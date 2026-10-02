import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  HistoryBatchError,
  HistoryCorruptionError,
  rebuildInvocationStates,
  validateHistoryTransition,
  validateHistoryBatch,
  type HistoryAppendResult,
  type HistoryEvent,
  type HistoryPort,
  type HistorySnapshot,
  type RebuiltInvocationState
} from '../../packages/agent-sdk/src/history'
import { runInTransaction } from '../database/transaction'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { commitSessionTranscriptInTransaction } from '../database/sessionTranscript'
import type { SessionTranscriptCommitIntent } from '../../packages/agent-sdk/src/history'
import { sanitizeCapabilityParamsForDisplay } from '../../src/shared/capabilityParamSanitize'
import { toolIdToOpenAiCompatibleApiToolName } from '../../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../../src/shared/toolNameCompatibility'
import { decodeTerminalOutcome } from './terminalOutcome'
import { foldClaudeSessionSnapshots, rebuildClaudeMessagesFromHistory, toCanonicalModelMessages, type CanonicalSessionSnapshot } from './canonicalHistory'
import { isCanonicalProjectionWatermarkValid } from './canonicalHistory'
import type { ClaudeChatMessageWithBlocks } from '../../src/shared/api'
import { createSpillStoreForDatabase, type SpillDescriptor, type SpillStore } from '../storage/spillStore'

const CANONICAL_SESSION_CACHE_VERSION = 1

type StreamRow = { invocation_id: string; version: number; schema_version: number; session_id: string | null }
type EventRow = {
  invocation_id: string
  sequence: number
  event_id: string
  idempotency_key: string
  turn_id: string
  schema_version: number
  kind: HistoryEvent['kind']
  payload_json: string
}
type OrderedSessionEventRow = EventRow & { session_seq: number; commit_order: number; session_id: string; created_at: number }

export type CanonicalSessionTranscriptRead =
  | Readonly<{ kind: 'matched'; messages: ClaudeChatMessageWithBlocks[]; sessionId: string; sessionGeneration: string; sessionSeq: number; commitOrder: number; watermarkEventId: string | null; watermarkInvocationId: string | null; eventCount: number }>
  | Readonly<{ kind: 'unavailable'; reason: 'session-missing' | 'order-invalid' | 'snapshot-invalid' | 'legacy-mismatch' }>

type LegacyTranscriptMessage = Readonly<{
  id: string; role: 'user' | 'assistant'; content: string; timestamp: number
  thinking?: unknown; contentSegments?: unknown; toolCalls?: unknown; toolUse?: unknown; attachments?: unknown
  status?: unknown; sequence?: unknown; imagesDeliveredToApi?: unknown; skillHints?: unknown
}>

export type CanonicalSessionCacheRead =
  | Readonly<{ kind: 'hit'; value: string; sessionSeq: number; commitOrder: number }>
  | Readonly<{ kind: 'miss'; reason: 'cache-missing' | 'watermark-invalid' | 'schema-invalid' }>

export type CanonicalSessionTranscriptWithCacheRead =
  | Readonly<{ kind: 'matched'; source: 'L1' | 'L2'; messages: ClaudeChatMessageWithBlocks[]; replayedEvents: number; watermark: Extract<CanonicalSessionTranscriptRead, { kind: 'matched' }> }>
  | Readonly<{ kind: 'unavailable'; reason: Extract<CanonicalSessionTranscriptRead, { kind: 'unavailable' }>['reason'] }>
type CompactionLedgerLocation = { workDir: string; sessionId: string; createdAt: number }
type CanonicalCompactionLedger = { location: CompactionLedgerLocation; start: Record<string, unknown>; summary: Record<string, unknown> }
type CanonicalToolLedger = { location: CompactionLedgerLocation; stepId: string; result: Record<string, unknown>; requestId?: string; invocationRequestId?: string; lane?: string; turnId?: string }
type CanonicalToolCallLedger = { location: CompactionLedgerLocation; stepId?: string; toolCalls?: Array<Record<string, unknown>>; requestUsage?: Record<string, unknown> }

/** SQLite adapter for canonical SDK history. Callers must run the current migrations first. */
export class SqliteAgentHistory implements HistoryPort {
  private readonly spillStore?: SpillStore

  constructor(private readonly conn: DatabaseSync, private readonly schemaVersion = 1, private readonly now: () => number = Date.now, private readonly sessionId?: string, spillStore?: SpillStore) {
    this.spillStore = spillStore ?? createSpillStoreForDatabase(conn)
  }

  async appendBatch(events: readonly HistoryEvent[], expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent): Promise<HistoryAppendResult> {
    const storedEvents = this.spillStore ? await Promise.all(events.map((event) => this.spillLargeCanonicalPayload(event))) : events
    let storedTranscriptJson: string | undefined
    if (this.spillStore && transcriptCommit) {
      const transcriptJson = JSON.stringify(transcriptCommit.messages)
      if (Buffer.byteLength(transcriptJson, 'utf8') > 64 * 1024) {
        try {
          const descriptor = await this.spillStore.commitSourceTruth(transcriptJson, () => undefined)
          storedTranscriptJson = JSON.stringify({ __spaceassistant_session_transcript_spill_v1: descriptor })
        } catch {
          // Preserve the complete transcript snapshot inline when durable spill preparation fails.
        }
      }
    }
    return runInTransaction(this.conn, () => {
      const appended = appendSqliteAgentHistoryBatchInTransaction(this.conn, storedEvents, expectedVersion, {
        schemaVersion: this.schemaVersion, now: this.now, ...(this.sessionId ? { sessionId: this.sessionId } : {})
      })
      if (!transcriptCommit) return appended
      if (!this.sessionId || transcriptCommit.sessionId !== this.sessionId) throw new HistoryBatchError('terminal transcript commit session identity mismatch')
      const terminal = events.length === 1 ? events[0] : undefined
      if (!terminal || !['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(terminal.kind)) {
        throw new HistoryBatchError('session transcript commit intent requires one terminal History event')
      }
      const committed = commitSessionTranscriptInTransaction(this.conn, {
        sessionId: transcriptCommit.sessionId, turnId: terminal.turnId, baseVersion: transcriptCommit.baseVersion,
        outcome: transcriptCommit.outcome, messages: transcriptCommit.messages,
        ...(storedTranscriptJson ? { storedMessagesJson: storedTranscriptJson } : {}), now: this.now()
      })
      if (!committed.committed) throw new HistoryBatchError(`session transcript commit rejected: ${committed.reason}`)
      return appended
    })
  }

  /** Fold session-owned canonical snapshots and require exact equality for every legacy field this API can represent. */
  readCanonicalSessionTranscript(sessionId: string, legacyMessages: readonly LegacyTranscriptMessage[]): CanonicalSessionTranscriptRead {
    if (!sessionId.trim() || (this.sessionId && this.sessionId !== sessionId)) return { kind: 'unavailable', reason: 'session-missing' }
    const session = this.conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
    if (!session?.generation) return { kind: 'unavailable', reason: 'session-missing' }
    const rows = this.conn.prepare(`
      SELECT events.invocation_id, events.sequence, events.event_id, events.idempotency_key, events.turn_id,
        events.schema_version, events.kind, events.payload_json, events.session_seq, events.commit_order,
        events.session_id, events.created_at
      FROM agent_history_events AS events
      JOIN agent_history_streams AS streams ON streams.invocation_id = events.invocation_id
      WHERE streams.session_id = ? AND events.session_id = ?
      ORDER BY events.session_seq ASC, events.commit_order ASC
    `).all(sessionId, sessionId) as OrderedSessionEventRow[]
    if (rows.length === 0) return legacyMessages.length === 0
      ? { kind: 'matched', messages: [], sessionId, sessionGeneration: session.generation, sessionSeq: -1,
          commitOrder: -1, watermarkEventId: null, watermarkInvocationId: null, eventCount: 0 }
      : { kind: 'unavailable', reason: 'legacy-mismatch' }
    if (rows.some((row, index) => !Number.isSafeInteger(row.session_seq) || row.session_seq !== index + 1 ||
      !Number.isSafeInteger(row.commit_order) || row.commit_order < 1 || row.session_id !== sessionId ||
      (index > 0 && row.commit_order <= rows[index - 1]!.commit_order))) return { kind: 'unavailable', reason: 'order-invalid' }

    try {
      const snapshots: CanonicalSessionSnapshot[] = []
      const byInvocation = new Map<string, OrderedSessionEventRow[]>()
      for (const row of rows) {
        const streamRows = byInvocation.get(row.invocation_id) ?? []
        streamRows.push(row)
        byInvocation.set(row.invocation_id, streamRows)
      }
      for (const [invocationId, streamRows] of byInvocation) {
        const hasBase = streamRows.some((row) => row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')
        if (!hasBase) {
          if (streamRows.some((row) => ['model-response-committed', 'replay-message-committed', 'tool-call-finished', 'tool-call-not-dispatched'].includes(row.kind))) {
            return { kind: 'unavailable', reason: 'snapshot-invalid' }
          }
          continue
        }
        const events = streamRows.map((row) => ({ invocationId, sequence: row.sequence, eventId: row.event_id,
          idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
          kind: row.kind, payload: JSON.parse(row.payload_json) as unknown })) as HistoryEvent[]
        const hydratedEvents = this.spillStore ? events.map((event) => this.hydrateLargeToolResultSync(event)) : events
        const messages = rebuildClaudeMessagesFromHistory(hydratedEvents)
        const last = streamRows.at(-1)!
        snapshots.push({ sessionId, invocationId, sessionSeq: last.session_seq, commitOrder: last.commit_order, messages })
      }
      const folded = foldClaudeSessionSnapshots(snapshots)
      const canonical = toCanonicalModelMessages(folded)
      const eligibleLegacy = legacyMessages.map((message) => ({
        id: message.id, role: message.role, content: message.content, timestamp: message.timestamp,
        ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
        ...(message.contentSegments !== undefined ? { contentSegments: message.contentSegments } : {}),
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolUse !== undefined ? { toolUse: message.toolUse } : {}),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(message.status !== undefined ? { status: message.status } : {}),
        ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
        ...(message.imagesDeliveredToApi !== undefined ? { imagesDeliveredToApi: message.imagesDeliveredToApi } : {}),
        ...(message.skillHints !== undefined ? { skillHints: message.skillHints } : {})
      }))
      const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) : value
      if (JSON.stringify(stable(canonical)) !== JSON.stringify(stable(eligibleLegacy))) return { kind: 'unavailable', reason: 'legacy-mismatch' }
      const watermark = rows.at(-1)!
      const anchor = this.conn.prepare(`SELECT session_id, session_seq, commit_order, event_id, invocation_id
        FROM agent_history_events WHERE session_id=? AND session_seq=?`).get(sessionId, watermark.session_seq) as
        { session_id: string; session_seq: number; commit_order: number; event_id: string; invocation_id: string } | undefined
      if (!anchor || anchor.session_id !== sessionId || anchor.commit_order !== watermark.commit_order || anchor.event_id !== watermark.event_id || anchor.invocation_id !== watermark.invocation_id) {
        return { kind: 'unavailable', reason: 'order-invalid' }
      }
      return { kind: 'matched', messages: folded, sessionId, sessionGeneration: session.generation,
        sessionSeq: watermark.session_seq, commitOrder: watermark.commit_order,
        watermarkEventId: watermark.event_id, watermarkInvocationId: watermark.invocation_id, eventCount: rows.length }
    } catch {
      return { kind: 'unavailable', reason: 'snapshot-invalid' }
    }
  }

  /** Reads a detached per-key cache record only when its live session incarnation and exact anchor still match. */
  readCanonicalSessionCache(input: Extract<CanonicalSessionTranscriptRead, { kind: 'matched' }> & { cacheKey: string }): CanonicalSessionCacheRead {
    const row = this.conn.prepare(`SELECT session_id, cache_version, session_generation, session_seq, commit_order, watermark_event_id,
      watermark_invocation_id, event_count, value FROM canonical_session_projection_cache WHERE session_id=? AND cache_key=?`)
      .get(input.sessionId, input.cacheKey) as { session_id: string; cache_version: number; session_generation: string; session_seq: number; commit_order: number;
        watermark_event_id: string | null; watermark_invocation_id: string | null; event_count: number; value: string } | undefined
    if (!row) return { kind: 'miss', reason: 'cache-missing' }
    if (row.cache_version !== CANONICAL_SESSION_CACHE_VERSION) return { kind: 'miss', reason: 'schema-invalid' }
    const liveSession = this.conn.prepare('SELECT generation FROM sessions WHERE id=?').get(input.sessionId) as { generation: string } | undefined
    const anchor = row.session_seq === -1 ? undefined : this.conn.prepare(`SELECT session_id, session_seq, commit_order, event_id, invocation_id
      FROM agent_history_events WHERE session_id=? AND session_seq=?`).get(input.sessionId, row.session_seq) as
      { session_id: string; session_seq: number; commit_order: number; event_id: string; invocation_id: string } | undefined
    const canonicalEventCount = Number((this.conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(input.sessionId) as { count: number }).count)
    const valid = isCanonicalProjectionWatermarkValid({
      watermark: { sessionId: row.session_id, sessionGeneration: row.session_generation, sessionSeq: row.session_seq,
        commitOrder: row.commit_order, watermarkEventId: row.watermark_event_id, watermarkInvocationId: row.watermark_invocation_id,
        eventCount: row.event_count },
      currentSessionId: input.sessionId, currentGeneration: liveSession?.generation ?? '', canonicalEventCount,
      ...(anchor ? { anchor: { sessionId: anchor.session_id, sessionGeneration: row.session_generation,
        sessionSeq: anchor.session_seq, commitOrder: anchor.commit_order, eventId: anchor.event_id, invocationId: anchor.invocation_id } } : {})
    })
    if (!valid || row.session_generation !== input.sessionGeneration || row.session_seq !== input.sessionSeq || row.commit_order !== input.commitOrder ||
      row.watermark_event_id !== input.watermarkEventId || row.watermark_invocation_id !== input.watermarkInvocationId || row.event_count !== input.eventCount) {
      return { kind: 'miss', reason: 'watermark-invalid' }
    }
    try { JSON.parse(row.value) } catch { return { kind: 'miss', reason: 'schema-invalid' } }
    return { kind: 'hit', value: row.value, sessionSeq: row.session_seq, commitOrder: row.commit_order }
  }

  /** Best-effort per-session canonical seed write; callers keep legacy as their authority on failure. */
  writeCanonicalSessionCache(input: Extract<CanonicalSessionTranscriptRead, { kind: 'matched' }> & { cacheKey: string; value: string }): boolean {
    try {
      JSON.parse(input.value)
      const result = this.conn.prepare(`INSERT INTO canonical_session_projection_cache(
        session_id, cache_key, cache_version, session_generation, session_seq, commit_order, watermark_event_id, watermark_invocation_id,
        event_count, value, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, cache_key) DO UPDATE SET
        cache_version=excluded.cache_version, session_generation=excluded.session_generation, session_seq=excluded.session_seq, commit_order=excluded.commit_order,
        watermark_event_id=excluded.watermark_event_id, watermark_invocation_id=excluded.watermark_invocation_id,
        event_count=excluded.event_count, value=excluded.value, updated_at=excluded.updated_at`).run(
        input.sessionId, input.cacheKey, CANONICAL_SESSION_CACHE_VERSION, input.sessionGeneration, input.sessionSeq, input.commitOrder,
        input.watermarkEventId, input.watermarkInvocationId, input.eventCount, input.value, Date.now()
      )
      return Number(result.changes) > 0
    } catch { return false }
  }

  /** L1 reads a validated detached seed and folds only later snapshot facts; any ambiguity runs the L2 full fold. */
  readCanonicalSessionTranscriptWithCache(sessionId: string, cacheKey: string, legacyMessages?: readonly LegacyTranscriptMessage[]): CanonicalSessionTranscriptWithCacheRead {
    let cacheRow: { session_id: string; cache_version: number; session_generation: string; session_seq: number; commit_order: number;
      watermark_event_id: string | null; watermark_invocation_id: string | null; event_count: number; value: string } | undefined
    try {
      cacheRow = this.conn.prepare(`SELECT session_id, cache_version, session_generation, session_seq, commit_order, watermark_event_id,
        watermark_invocation_id, event_count, value FROM canonical_session_projection_cache WHERE session_id=? AND cache_key=?`)
        .get(sessionId, cacheKey) as typeof cacheRow
    } catch { cacheRow = undefined }
    if (cacheRow && cacheRow.cache_version === CANONICAL_SESSION_CACHE_VERSION) {
      const liveSession = this.conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
      const cursorRow = this.conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
      const cursor = cursorRow ?? { next_seq: 0 }
      const canonicalEventCount = Number((this.conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(sessionId) as { count: number }).count)
      const anchor = cacheRow.session_seq === -1 ? undefined : this.conn.prepare(`SELECT session_id, session_seq, commit_order, event_id, invocation_id
        FROM agent_history_events WHERE session_id=? AND session_seq=?`).get(sessionId, cacheRow.session_seq) as
        { session_id: string; session_seq: number; commit_order: number; event_id: string; invocation_id: string } | undefined
      const valid = isCanonicalProjectionWatermarkValid({
        watermark: { sessionId: cacheRow.session_id, sessionGeneration: cacheRow.session_generation, sessionSeq: cacheRow.session_seq,
          commitOrder: cacheRow.commit_order, watermarkEventId: cacheRow.watermark_event_id,
          watermarkInvocationId: cacheRow.watermark_invocation_id, eventCount: cacheRow.event_count },
        currentSessionId: sessionId, currentGeneration: liveSession?.generation ?? '', canonicalEventCount: cacheRow.event_count,
        ...(anchor ? { anchor: { sessionId: anchor.session_id, sessionGeneration: cacheRow.session_generation,
          sessionSeq: anchor.session_seq, commitOrder: anchor.commit_order, eventId: anchor.event_id, invocationId: anchor.invocation_id } } : {})
      })
      if (valid && cursor.next_seq === canonicalEventCount && cacheRow.session_seq <= canonicalEventCount &&
        (cacheRow.session_seq === -1 ? cacheRow.event_count === 0 : cacheRow.event_count === cacheRow.session_seq)) {
        try {
          const seed = JSON.parse(cacheRow.value) as ClaudeChatMessageWithBlocks[]
          if (!Array.isArray(seed) || seed.some((message) => !message || !['user', 'assistant'].includes(message.role))) throw new Error('invalid cache seed')
          const tailRows = this.conn.prepare(`SELECT events.invocation_id, events.sequence, events.event_id, events.idempotency_key, events.turn_id,
            events.schema_version, events.kind, events.payload_json, events.session_seq, events.commit_order, events.session_id, events.created_at
            FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
            WHERE events.session_id=? AND streams.session_id=? AND events.session_seq>? ORDER BY events.session_seq, events.commit_order`)
            .all(sessionId, sessionId, cacheRow.session_seq) as OrderedSessionEventRow[]
          if (cursor && cursor.next_seq === (cacheRow.session_seq === -1 ? tailRows.length : cacheRow.session_seq + tailRows.length) && tailRows.every((row, index) => row.session_seq === (cacheRow.session_seq === -1 ? index + 1 : cacheRow.session_seq + index + 1) &&
            (index === 0 ? row.commit_order > cacheRow.commit_order : row.commit_order > tailRows[index - 1]!.commit_order))) {
            const rowsByInvocation = new Map<string, OrderedSessionEventRow[]>()
            for (const row of tailRows) rowsByInvocation.set(row.invocation_id, [...(rowsByInvocation.get(row.invocation_id) ?? []), row])
            const tailSnapshots: CanonicalSessionSnapshot[] = []
            let usedSeedAsBase = false
            for (const [invocationId, invocationRows] of rowsByInvocation) {
              const hasBase = invocationRows.some((row) => row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')
              if (!hasBase && !invocationRows.some((row) => ['model-response-committed', 'replay-message-committed', 'tool-call-finished', 'tool-call-not-dispatched'].includes(row.kind))) continue
              const events = invocationRows.map((row) => ({ invocationId, sequence: row.sequence + (hasBase ? 0 : 1),
                eventId: row.event_id, idempotencyKey: row.idempotency_key, turnId: row.turn_id,
                schemaVersion: row.schema_version, kind: row.kind, payload: JSON.parse(row.payload_json) as unknown })) as HistoryEvent[]
              const hydratedEvents = this.spillStore ? events.map((event) => this.hydrateLargeToolResultSync(event)) : events
              if (!hasBase) {
                if (usedSeedAsBase) throw new Error('multiple context-free transcript deltas are ambiguous')
                usedSeedAsBase = true
                const seedEvent: HistoryEvent = { invocationId, sequence: 1, eventId: `cache-seed:${cacheRow.watermark_event_id}`,
                  idempotencyKey: `cache-seed:${cacheRow.watermark_event_id}`, turnId: events[0]!.turnId,
                  schemaVersion: events[0]!.schemaVersion, kind: 'invocation-context-committed', payload: { messages: seed } }
                hydratedEvents.unshift(seedEvent)
              }
              const messages = rebuildClaudeMessagesFromHistory(hydratedEvents)
              const last = invocationRows.at(-1)!
              tailSnapshots.push({ sessionId, invocationId, sessionSeq: last.session_seq,
                commitOrder: last.commit_order, messages })
            }
            const folded = tailSnapshots.length
              ? foldClaudeSessionSnapshots([...(cacheRow.session_seq >= 1 ? [{ sessionId, invocationId: cacheRow.watermark_invocation_id ?? 'cache-seed',
                  sessionSeq: cacheRow.session_seq, commitOrder: cacheRow.commit_order, messages: seed }] : []), ...tailSnapshots])
              : seed
            const canonical = toCanonicalModelMessages(folded)
            const legacyCanonical = legacyMessages?.map((message) => ({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp,
              ...(message.thinking !== undefined ? { thinking: message.thinking } : {}), ...(message.contentSegments !== undefined ? { contentSegments: message.contentSegments } : {}),
              ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}), ...(message.toolUse !== undefined ? { toolUse: message.toolUse } : {}),
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}), ...(message.status !== undefined ? { status: message.status } : {}),
              ...(message.sequence !== undefined ? { sequence: message.sequence } : {}), ...(message.imagesDeliveredToApi !== undefined ? { imagesDeliveredToApi: message.imagesDeliveredToApi } : {}),
              ...(message.skillHints !== undefined ? { skillHints: message.skillHints } : {}) }))
            const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
            if (legacyCanonical === undefined || JSON.stringify(stable(canonical)) === JSON.stringify(stable(legacyCanonical))) {
              const lastTail = tailRows.at(-1)
              const watermarkEventId = lastTail?.event_id ?? cacheRow.watermark_event_id
              const watermarkInvocationId = lastTail?.invocation_id ?? cacheRow.watermark_invocation_id
              const sessionSeq = lastTail?.session_seq ?? cacheRow.session_seq
              const commitOrder = lastTail?.commit_order ?? cacheRow.commit_order
              if (sessionSeq === -1 ? watermarkEventId !== null || watermarkInvocationId !== null : !watermarkEventId || !watermarkInvocationId) throw new Error('cache watermark is incomplete')
              const eventCount = cacheRow.event_count + tailRows.length
              const anchor = this.conn.prepare(`SELECT session_id, session_seq, commit_order, event_id, invocation_id
                FROM agent_history_events WHERE session_id=? AND session_seq=?`).get(sessionId, sessionSeq) as
                { session_id: string; session_seq: number; commit_order: number; event_id: string; invocation_id: string } | undefined
              if (sessionSeq === -1 ? anchor !== undefined || eventCount !== 0 : !anchor || anchor.commit_order !== commitOrder || anchor.event_id !== watermarkEventId || anchor.invocation_id !== watermarkInvocationId) throw new Error('cache tail anchor changed')
              const watermark = { kind: 'matched' as const, messages: folded, sessionId,
                sessionGeneration: liveSession!.generation, sessionSeq, commitOrder,
                watermarkEventId, watermarkInvocationId, eventCount }
              const result = { kind: 'matched' as const, source: 'L1' as const, messages: folded, replayedEvents: tailRows.length, watermark }
              this.writeCanonicalSessionCache({ ...watermark, cacheKey, value: JSON.stringify(folded) })
              return result
            }
          }
        } catch { /* fail closed to the L2 full fold below */ }
      }
    }
    if (legacyMessages === undefined) return { kind: 'unavailable', reason: 'legacy-mismatch' }
    const full = this.readCanonicalSessionTranscript(sessionId, legacyMessages)
    if (full.kind === 'unavailable') return full
    this.writeCanonicalSessionCache({ ...full, cacheKey, value: JSON.stringify(full.messages) })
    return { kind: 'matched', source: 'L2', messages: full.messages, replayedEvents: full.eventCount, watermark: full }
  }

  /** Classifies pre-queue canonical projection obligations in bounded, resumable transactions. */
  async classifyLegacyProjectionRepairs(batchSize = 100): Promise<{ classified: number; complete: boolean }> {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new HistoryBatchError('batchSize must be a positive integer')
    return runInTransaction(this.conn, () => {
      const migration = this.conn.prepare(`SELECT after_invocation_id, status FROM canonical_projection_repair_migration
        WHERE migration_key = 'legacy-classification-v1'`).get() as { after_invocation_id: string | null; status: string } | undefined
      if (!migration || migration.status === 'complete') return { classified: 0, complete: true }
      const streams = this.conn.prepare(`
        SELECT streams.invocation_id, streams.session_id, streams.version
        FROM agent_history_streams streams
        WHERE (? IS NULL OR streams.invocation_id > ?)
        ORDER BY streams.invocation_id LIMIT ?
      `).all(migration.after_invocation_id, migration.after_invocation_id, batchSize + 1) as Array<{ invocation_id: string; session_id: string | null; version: number }>
      const hasMore = streams.length > batchSize
      const batch = hasMore ? streams.slice(0, batchSize) : streams
      const register = this.conn.prepare(`INSERT OR IGNORE INTO canonical_projection_repairs(
        repair_id, session_id, invocation_id, repair_kind, target_key, status, attempts, idempotency_key, updated_at
      ) VALUES(?, ?, ?, 'invocation-projections', ?, 'pending', 0, ?, ?)`)
      for (const stream of batch) {
        if (stream.version <= 0) continue
        const events = this.conn.prepare(`SELECT event_id, payload_json FROM agent_history_events
          WHERE invocation_id = ? ORDER BY sequence`).all(stream.invocation_id) as Array<{ event_id: string; payload_json: string }>
        for (const event of events) {
          let payload: { sessionLedger?: { location?: { workDir?: unknown; sessionId?: unknown; createdAt?: unknown } } }
          try { payload = JSON.parse(event.payload_json) }
          catch {
            throw new HistoryCorruptionError(stream.invocation_id, `cannot classify projection repair obligations: corrupt event payload ${event.event_id}`)
          }
          const location = payload.sessionLedger?.location
          if (!location || typeof location.workDir !== 'string' || typeof location.sessionId !== 'string' || !Number.isFinite(location.createdAt)) continue
          register.run(`${stream.invocation_id}:invocation-projections:${event.event_id}`, stream.session_id, stream.invocation_id,
            event.event_id, `${stream.invocation_id}:repair:invocation-projections:${event.event_id}`, Date.now())
        }
      }
      const after = batch.at(-1)?.invocation_id ?? migration.after_invocation_id
      const complete = !hasMore
      this.conn.prepare(`UPDATE canonical_projection_repair_migration SET after_invocation_id = ?, status = ?, updated_at = ?
        WHERE migration_key = 'legacy-classification-v1'`).run(after, complete ? 'complete' : 'pending', Date.now())
      return { classified: batch.length, complete }
    })
  }

  /** Pending obligations are retried independently; success is the only transition to completed. */
  recordProjectionRepairResult(repairId: string, result: { success: true } | { success: false; error: unknown }): void {
    const now = Date.now()
    if (result.success) {
      this.conn.prepare(`UPDATE canonical_projection_repairs SET status = 'completed', attempts = attempts + 1,
        last_error = NULL, updated_at = ? WHERE repair_id = ?`).run(now, repairId)
    } else {
      const message = result.error instanceof Error ? result.error.message : String(result.error)
      this.conn.prepare(`UPDATE canonical_projection_repairs SET status = 'pending', attempts = attempts + 1,
        last_error = ?, updated_at = ? WHERE repair_id = ?`).run(message, now, repairId)
    }
  }

  /** Lists canonical invocation streams owned by a session in their first-commit order. */
  listInvocationIdsForSession(sessionId: string): string[] {
    if (!sessionId.trim()) throw new HistoryBatchError('sessionId is required')
    return (this.conn.prepare(`
      SELECT streams.invocation_id
      FROM agent_history_streams AS streams
      JOIN agent_history_events AS events ON events.invocation_id = streams.invocation_id
      WHERE streams.session_id = ?
      GROUP BY streams.invocation_id
      ORDER BY MIN(events.created_at) ASC, MIN(events.rowid) ASC, streams.invocation_id ASC
    `).all(sessionId) as Array<{ invocation_id: string }>).map(({ invocation_id }) => invocation_id)
  }

  /** Returns the newest safe completed transcript; explicitly failed attempts do not shadow prior context. */
  async readLatestCompletedInvocationForSession(sessionId: string, options: { excludeInvocationId?: string } = {}): Promise<HistorySnapshot | undefined> {
    const latest = await this.readLatestInvocationForSession(sessionId, options)
    return latest.kind === 'completed' ? latest.snapshot : undefined
  }

  /** Distinguishes an empty session from a latest canonical stream that cannot safely supply a transcript. */
  async readLatestInvocationForSession(sessionId: string, options: { excludeInvocationId?: string; excludeInvocationIds?: readonly string[] } = {}): Promise<
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'completed'; snapshot: HistorySnapshot }>
    | Readonly<{ kind: 'cancelled'; snapshot: HistorySnapshot }>
    | Readonly<{ kind: 'unavailable'; invocationId: string }>
  > {
    const excluded = new Set([...(options.excludeInvocationId ? [options.excludeInvocationId] : []), ...(options.excludeInvocationIds ?? [])])
    const invocationIds = this.listInvocationIdsForSession(sessionId).filter((id) => !excluded.has(id))
    if (invocationIds.length === 0) return { kind: 'none' }
    for (const invocationId of invocationIds.reverse()) {
      const snapshot = await this.read(invocationId)
      const terminal = snapshot.events.at(-1)
      // Open/interrupted streams may represent a crashed turn whose canonical tail is incomplete.
      if (!terminal || !['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(terminal.kind)) {
        return { kind: 'unavailable', invocationId }
      }
      // Failed turns are closed attempts. Keep searching for the last complete conversation base.
      if (terminal.kind === 'invocation-failed') continue
      if (terminal.kind === 'invocation-interrupted') {
        const outcome = decodeTerminalOutcome(terminal)
        // User cancellation has a known outcome. The Hosted cutover still validates that the
        // canonical transcript can be rebuilt and is a prefix of the next request.
        if (outcome === 'cancelled' && snapshot.events.some(({ kind }) => kind === 'invocation-context-committed' || kind === 'transcript-compacted')) {
          return { kind: 'cancelled', snapshot }
        }
        return { kind: 'unavailable', invocationId }
      }
      if (!snapshot.events.some(({ kind }) => kind === 'invocation-context-committed' || kind === 'transcript-compacted')) {
        return { kind: 'unavailable', invocationId }
      }
      return { kind: 'completed', snapshot }
    }
    return { kind: 'none' }
  }

  async read(invocationId: string): Promise<HistorySnapshot> {
    return this.readSync(invocationId)
  }

  /** Synchronous read for startup coordinators whose recovery contract is intentionally synchronous. */
  readSync(invocationId: string): HistorySnapshot {
    // Compatibility adapter: callers holding an accepted requestId can still read its
    // canonical turn stream. Exact stream IDs always win for legacy records.
    const exactStream = this.conn.prepare('SELECT invocation_id, version, schema_version, session_id FROM agent_history_streams WHERE invocation_id = ?').get(invocationId) as StreamRow | undefined
    if (exactStream && this.sessionId && exactStream.session_id !== this.sessionId) {
      throw new HistoryBatchError(`invocation ${invocationId} does not belong to session ${this.sessionId}`)
    }
    const hasTurnTable = Boolean(this.conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get())
    const hasAcceptedTurnTable = Boolean(this.conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accepted_turn_contexts'").get())
    let mappedInvocationId: string | undefined
    if (!exactStream && hasTurnTable) {
      const turnMappings = this.conn.prepare(`
      SELECT turns.turn_id AS turnId FROM turns
      JOIN agent_history_streams streams ON streams.invocation_id = turns.turn_id
      WHERE turns.request_id = ? AND (? IS NULL OR turns.session_id = ?)
      ORDER BY turns.rowid DESC LIMIT 2
      `).all(invocationId, this.sessionId ?? null, this.sessionId ?? null) as Array<{ turnId: string }>
      if (!this.sessionId && turnMappings.length > 1) {
        throw new HistoryBatchError(`requestId ${invocationId} maps to multiple session turns`)
      }
      mappedInvocationId = turnMappings[0]?.turnId
    }
    if (!exactStream && !mappedInvocationId && hasAcceptedTurnTable) {
      const acceptedMappings = this.conn.prepare(`
        SELECT turn_id FROM accepted_turn_contexts
        WHERE request_id = ? AND (? IS NULL OR session_id = ?)
        ORDER BY created_at DESC LIMIT 2
      `).all(invocationId, this.sessionId ?? null, this.sessionId ?? null) as Array<{ turn_id: string }>
      if (!this.sessionId && acceptedMappings.length > 1) {
        throw new HistoryBatchError(`requestId ${invocationId} maps to multiple accepted turns`)
      }
      if (acceptedMappings.length === 1) mappedInvocationId = acceptedMappings[0]!.turn_id
    }
    const resolvedInvocationId = exactStream ? invocationId : mappedInvocationId ?? invocationId
    const stream = exactStream ?? this.conn.prepare('SELECT invocation_id, version, schema_version, session_id FROM agent_history_streams WHERE invocation_id = ?').get(resolvedInvocationId) as StreamRow | undefined
    const rows = this.conn.prepare(`
      SELECT invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json
      FROM agent_history_events WHERE invocation_id = ? ORDER BY sequence ASC
    `).all(resolvedInvocationId) as EventRow[]
    if (!stream && rows.length > 0) throw new HistoryCorruptionError(invocationId, 'events exist without a stream record')
    if (stream && stream.schema_version !== this.schemaVersion) {
      throw new HistoryCorruptionError(invocationId, `unsupported schema version ${stream.schema_version} (adapter supports ${this.schemaVersion})`)
    }
    const events = rows.map((row) => {
      try {
        const event = fromRow(row)
        if (this.spillStore) return this.hydrateLargeToolResultSync(event)
        validateHistoryBatch([event])
        return event
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'SPILL_CONTENT_UNAVAILABLE') throw error
        throw new HistoryCorruptionError(invocationId, error instanceof Error ? error.message : String(error))
      }
    })
    if (stream && stream.version !== events.length) throw new HistoryCorruptionError(invocationId, `stored version ${stream.version} differs from event count ${events.length}`)
    if (stream && events.some((event, index) => event.sequence !== index + 1 || event.schemaVersion !== stream.schema_version)) {
      throw new HistoryCorruptionError(invocationId, 'event sequence or schema version is not contiguous')
    }
    try { validateHistoryTransition([], events) }
    catch (error) { throw new HistoryCorruptionError(invocationId, error instanceof Error ? error.message : String(error)) }
    return { invocationId: stream?.invocation_id ?? invocationId, version: stream?.version ?? 0, schemaVersion: stream?.schema_version ?? this.schemaVersion, events }
  }

  private async spillLargeCanonicalPayload(event: HistoryEvent): Promise<HistoryEvent> {
    if (!event.payload || typeof event.payload !== 'object') return event
    const payload = event.payload as Record<string, unknown>
    try {
      const spillText = async (value: unknown): Promise<unknown> => {
        if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 64 * 1024) {
          const descriptor = await this.spillStore!.commitSourceTruth(value, () => undefined)
          return { __spaceassistant_spill_v1: descriptor }
        }
        return value
      }
      if (event.kind === 'tool-call-finished') {
        const result = payload.result
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const resultRecord = result as Record<string, unknown>
          const originalData = resultRecord.data
          const spilledData = await spillText(originalData)
          if (spilledData !== originalData) {
            const storedPayload: Record<string, unknown> = { ...payload, result: { ...resultRecord, data: spilledData } }
            const ledger = payload.sessionLedger
            if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
              const ledgerRecord = ledger as Record<string, unknown>
              if (ledgerRecord.result && typeof ledgerRecord.result === 'object' && !Array.isArray(ledgerRecord.result) &&
                (ledgerRecord.result as Record<string, unknown>).data === originalData) {
                storedPayload.sessionLedger = { ...ledgerRecord, result: { ...(ledgerRecord.result as Record<string, unknown>), data: spilledData } }
              }
            }
            return { ...event, payload: storedPayload }
          }
        }
      }
      if (event.kind === 'model-response-committed') {
        const message = payload.message
        if (message && typeof message === 'object' && !Array.isArray(message)) {
          const record = message as Record<string, unknown>
          const content = record.content
          if (typeof content === 'string') {
            const spilled = await spillText(content)
            if (spilled !== content) return { ...event, payload: { ...payload, message: { ...record, content: spilled } } }
          } else if (Array.isArray(content)) {
            let changed = false
            const blocks = await Promise.all(content.map(async (block) => {
              if (!block || typeof block !== 'object' || Array.isArray(block)) return block
              const blockRecord = block as Record<string, unknown>
              if (blockRecord.type !== 'text' && blockRecord.type !== 'thinking') return block
              const field = blockRecord.type === 'text' ? 'text' : 'thinking'
              const spilled = await spillText(blockRecord[field])
              if (spilled === blockRecord[field]) return block
              changed = true
              return { ...blockRecord, [field]: spilled }
            }))
            if (changed) return { ...event, payload: { ...payload, message: { ...record, content: blocks } } }
          }
        }
      }
      if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
        const messages = payload.messages
        if (Array.isArray(messages)) {
          let changed = false
          const storedMessages = await Promise.all(messages.map(async (message) => {
            if (!message || typeof message !== 'object' || Array.isArray(message)) return message
            const record = message as Record<string, unknown>
            const content = record.content
            if (typeof content === 'string') {
              const spilled = await spillText(content)
              if (spilled !== content) { changed = true; return { ...record, content: spilled } }
              return message
            }
            if (!Array.isArray(content)) return message
            let contentChanged = false
            const blocks = await Promise.all(content.map(async (block) => {
              if (!block || typeof block !== 'object' || Array.isArray(block)) return block
              const blockRecord = block as Record<string, unknown>
              const field = blockRecord.type === 'text' ? 'text' : blockRecord.type === 'thinking' ? 'thinking' : blockRecord.type === 'image' ? 'data' : undefined
              if (!field) return block
              const spilled = await spillText(blockRecord[field])
              if (spilled === blockRecord[field]) return block
              contentChanged = true
              return { ...blockRecord, [field]: spilled }
            }))
            if (!contentChanged) return message
            changed = true
            return { ...record, content: blocks }
          }))
          if (changed) return { ...event, payload: { ...payload, messages: storedMessages } }
        }
      }
      if (event.kind === 'invocation-completed') {
        const outputText = payload.outputText
        const spilled = await spillText(outputText)
        if (spilled !== outputText) return { ...event, payload: { ...payload, outputText: spilled } }
      }
      return event
    } catch {
      // Spill is an optimization: preserve the complete canonical body inline if durable preparation fails.
      return event
    }
  }

  private hydrateLargeToolResultSync(event: HistoryEvent): HistoryEvent {
    if (!event.payload || typeof event.payload !== 'object') return event
    const payload = event.payload as Record<string, unknown>
    const hydrateTaggedText = (tagged: unknown): unknown => {
      if (!tagged || typeof tagged !== 'object' || !('__spaceassistant_spill_v1' in tagged)) return tagged
      const descriptor = (tagged as { __spaceassistant_spill_v1: SpillDescriptor }).__spaceassistant_spill_v1
      if (descriptor.kind !== 'source-of-truth') throw new Error('canonical tool result references a non-source spill')
      return this.readSourceTruthSync(descriptor)
    }
    const hydrated: Record<string, unknown> = { ...payload }
    if (event.kind === 'tool-call-finished') {
      const hydrateResult = (value: unknown): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const record = value as Record<string, unknown>
        const data = hydrateTaggedText(record.data)
        return data === record.data ? value : { ...record, data }
      }
      if ('result' in payload) hydrated.result = hydrateResult(payload.result)
      const ledger = payload.sessionLedger
      if (ledger && typeof ledger === 'object' && !Array.isArray(ledger) && 'result' in ledger) {
        hydrated.sessionLedger = { ...(ledger as Record<string, unknown>), result: hydrateResult((ledger as Record<string, unknown>).result) }
      }
    } else if (event.kind === 'model-response-committed') {
      const message = payload.message
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const record = message as Record<string, unknown>
        const content = record.content
        if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
          hydrated.message = { ...record, content: hydrateTaggedText(content) }
        } else if (Array.isArray(content)) {
          hydrated.message = { ...record, content: content.map((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return block
            const blockRecord = block as Record<string, unknown>
            const field = blockRecord.type === 'text' ? 'text' : blockRecord.type === 'thinking' ? 'thinking' : undefined
            if (!field) return block
            const value = hydrateTaggedText(blockRecord[field])
            return value === blockRecord[field] ? block : { ...blockRecord, [field]: value }
          }) }
        }
      }
    } else if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
      const messages = payload.messages
      if (Array.isArray(messages)) {
        hydrated.messages = messages.map((message) => {
          if (!message || typeof message !== 'object' || Array.isArray(message)) return message
          const record = message as Record<string, unknown>
          const content = record.content
          if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
            const value = hydrateTaggedText(content)
            return value === content ? message : { ...record, content: value }
          }
          if (!Array.isArray(content)) return message
          let changed = false
          const blocks = content.map((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return block
            const blockRecord = block as Record<string, unknown>
            const field = blockRecord.type === 'text' ? 'text' : blockRecord.type === 'thinking' ? 'thinking' : blockRecord.type === 'image' ? 'data' : undefined
            if (!field) return block
            const value = hydrateTaggedText(blockRecord[field])
            if (value === blockRecord[field]) return block
            changed = true
            return { ...blockRecord, [field]: value }
          })
          return changed ? { ...record, content: blocks } : message
        })
      }
    } else if (event.kind === 'invocation-completed' && 'outputText' in payload) {
      hydrated.outputText = hydrateTaggedText(payload.outputText)
    }
    const result = { ...event, payload: hydrated }
    validateHistoryBatch([result])
    return result
  }

  private readSourceTruthSync(descriptor: SpillDescriptor): string {
    // History's recovery and provider-context contracts are synchronous; verify each referenced object before exposing it.
    return this.spillStore!.readSourceTruthSync(descriptor)
  }

  /** Trust a completed terminal only when the invocation is owned by this session or has no migrated owner. */
  isCompletedInvocationForSession(invocationId: string, sessionId: string): boolean {
    return this.readCompletedInvocationForSession(invocationId, sessionId) !== undefined
  }

  /** Returns the canonical final output when the owner and complete History stream are valid. */
  readCompletedInvocationForSession(invocationId: string, sessionId: string, expectedTurnId?: string): { outputText?: string; usage?: unknown } | undefined {
    try {
      const snapshot = this.readSync(invocationId)
      const stream = this.conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id = ?').get(snapshot.invocationId) as { session_id: string | null } | undefined
      if (!stream || (stream.session_id !== null && stream.session_id !== sessionId)) return undefined
      const terminal = snapshot.events.at(-1)
      if (terminal?.kind !== 'invocation-completed' || !terminal.payload || typeof terminal.payload !== 'object' ||
        (terminal.payload as { status?: unknown }).status !== 'completed' ||
        (expectedTurnId !== undefined && (snapshot.events.some((event) => event.turnId !== expectedTurnId) || terminal.turnId !== expectedTurnId))) return undefined
      const outputText = (terminal.payload as { outputText?: unknown }).outputText
      if (outputText !== undefined && typeof outputText !== 'string') return undefined
      const usage = (terminal.payload as { usage?: unknown }).usage
      if (usage !== undefined && (!usage || typeof usage !== 'object' || Array.isArray(usage))) return undefined
      return {
        ...(typeof outputText === 'string' ? { outputText } : {}),
        ...(usage !== undefined ? { usage } : {})
      }
    } catch {
      return undefined
    }
  }

  /** Rebuilds completed UI tool records only from a valid, fully settled canonical invocation. */
  readCompletedToolCallsForSession(invocationId: string, sessionId: string, expectedTurnId: string): import('../../src/shared/domainTypes').ToolCallRecord[] | undefined {
    try {
      const snapshot = this.readSync(invocationId)
      const stream = this.conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id = ?').get(snapshot.invocationId) as { session_id: string | null } | undefined
      const terminal = snapshot.events.at(-1)
      if (!stream || (stream.session_id !== null && stream.session_id !== sessionId) ||
        terminal?.kind !== 'invocation-completed' || !terminal.payload || typeof terminal.payload !== 'object' ||
        (terminal.payload as { status?: unknown }).status !== 'completed' || snapshot.events.some((event) => event.turnId !== expectedTurnId)) return undefined
      const calls = new Map<string, import('../../src/shared/domainTypes').ToolCallRecord>()
      const approvalWaits = new Map<string, { approval: NonNullable<import('../../src/shared/domainTypes').ToolCallRecord['approval']>; reasonCode: string }>()
      for (const event of snapshot.events) {
        const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : undefined
        if (event.kind === 'model-response-committed') {
          const message = payload?.message && typeof payload.message === 'object' ? payload.message as { toolCalls?: unknown } : undefined
          if (message && Object.prototype.hasOwnProperty.call(message, 'toolCalls') && !Array.isArray(message.toolCalls)) return undefined
          for (const candidate of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
            const call = candidate as { id?: unknown; name?: unknown; input?: unknown }
            if (typeof call.id !== 'string' || !call.id.trim() || typeof call.name !== 'string' || !call.name.trim() ||
              !call.input || typeof call.input !== 'object' || Array.isArray(call.input) || calls.has(call.id)) return undefined
            // History intentionally stores no policy risk metadata; use the conservative display value.
            calls.set(call.id, { id: call.id, toolName: call.name, input: structuredClone(call.input as Record<string, unknown>), status: 'calling', riskLevel: 'high' })
          }
        } else if (event.kind === 'approval-waiting' && typeof payload?.toolCallId === 'string') {
          const existing = calls.get(payload.toolCallId)
          if (!existing) return undefined
          const hasApprovalMetadata = ['answerer', 'reasonCode', 'requestedAt'].some((key) => key in payload)
          if (!hasApprovalMetadata) continue // Legacy History keeps lifecycle safety but cannot rebuild the richer card.
          if (typeof payload.approvalId !== 'string' || !payload.approvalId.trim() ||
            (payload.answerer !== 'user' && payload.answerer !== 'agent') || typeof payload.reasonCode !== 'string' || !payload.reasonCode.trim() ||
            typeof payload.requestedAt !== 'number' || !Number.isFinite(payload.requestedAt) || approvalWaits.has(payload.toolCallId)) return undefined
          const approval: NonNullable<import('../../src/shared/domainTypes').ToolCallRecord['approval']> = {
            schemaVersion: 1,
            approvalId: payload.approvalId,
            attemptId: `${invocationId}:approval:${payload.toolCallId}`,
            toolUseId: payload.toolCallId,
            answerer: payload.answerer,
            status: payload.answerer === 'agent' ? 'evaluating' : 'awaiting-user',
            reason: { summary: payload.reasonCode },
            requestedAt: payload.requestedAt,
            revision: 1
          }
          existing.approval = approval
          approvalWaits.set(payload.toolCallId, { approval, reasonCode: payload.reasonCode })
        } else if (event.kind === 'approval-resolved' && typeof payload?.toolCallId === 'string') {
          const waiting = approvalWaits.get(payload.toolCallId)
          if (!waiting) continue // Legacy approval lifecycle has no card metadata to rebuild.
          const validOutcomes = ['approved', 'denied', 'timeout', 'unavailable', 'cancelled']
          if (typeof payload.approved !== 'boolean' || typeof payload.outcome !== 'string' || !validOutcomes.includes(payload.outcome) ||
            typeof payload.settledAt !== 'number' || !Number.isFinite(payload.settledAt) ||
            payload.approved !== (payload.outcome === 'approved') ||
            (payload.answerer !== undefined && payload.answerer !== 'user' && payload.answerer !== 'agent') ||
            (payload.cause !== undefined && (typeof payload.cause !== 'string' || !payload.cause.trim()))) return undefined
          const approval = waiting.approval
          if (payload.answerer === 'user' || payload.answerer === 'agent') approval.answerer = payload.answerer
          approval.status = payload.outcome === 'approved' ? 'approved'
            : payload.outcome === 'timeout' ? 'timed-out'
              : payload.outcome === 'unavailable' ? 'unavailable'
                : payload.outcome === 'cancelled' ? 'cancelled' : 'denied'
          approval.settledAt = payload.settledAt
          approval.revision = 2
          if (typeof payload.cause === 'string') approval.cause = payload.cause as NonNullable<typeof approval.cause>
          else if (payload.outcome === 'approved' && approval.answerer === 'agent') approval.cause = 'agent-approved'
          else if (payload.outcome === 'denied') approval.cause = approval.answerer === 'agent' ? 'agent-deny' : 'user-denied'
          else if (payload.outcome === 'timeout') approval.cause = 'evaluation-timeout'
          else if (payload.outcome === 'unavailable') approval.cause = 'provider-unavailable'
          else if (payload.outcome === 'cancelled') approval.cause = 'cancelled'
          approvalWaits.delete(payload.toolCallId)
        } else if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && typeof payload?.toolCallId === 'string') {
          const existing = calls.get(payload.toolCallId)
          if (!existing || existing.status !== 'calling') return undefined
          if (event.kind === 'tool-call-finished') {
            if (typeof payload.success !== 'boolean') return undefined
            const rawResult = payload.result
            const result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult) ? structuredClone(rawResult as Record<string, unknown>) : undefined
            if (result && 'success' in result && (typeof result.success !== 'boolean' || result.success !== payload.success)) return undefined
            existing.status = payload.success === true ? 'completed' : 'failed'
            existing.result = result && typeof result.success === 'boolean'
              ? result as unknown as import('../../src/shared/domainTypes').ToolCallResultPersisted
              : { success: payload.success, ...(rawResult !== undefined ? { data: structuredClone(rawResult) } : {}) }
          } else {
            existing.status = 'rejected'
            if (payload.reason === 'FACTS_CHANGED' && existing.approval) {
              existing.approval.status = 'denied'
              existing.approval.cause = 'facts-changed'
              existing.approval.reason = { summary: 'facts-changed' }
            }
            const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? structuredClone(payload.result as Record<string, unknown>) : undefined
            if (result && typeof result.success === 'boolean') {
              existing.result = result as unknown as import('../../src/shared/domainTypes').ToolCallResultPersisted
            } else if (typeof payload.replayContent === 'string' && payload.isError === true) {
              existing.result = { success: false, data: payload.replayContent, notExecuted: true }
            } else return undefined
          }
        }
      }
      return [...calls.values()].every((call) => call.status === 'completed' || call.status === 'failed' || call.status === 'rejected')
        ? [...calls.values()]
        : undefined
    } catch {
      return undefined
    }
  }

  /** Persist fail-safe interruption markers for non-terminal invocation streams after process restart. */
  async recoverInterruptedInvocations(options: {
    resolveSessionLedgerLocation?: (sessionId: string) => Promise<CompactionLedgerLocation | undefined> | CompactionLedgerLocation | undefined
    onSessionLocationResolveError?: (error: unknown, invocationId: string, sessionId: string) => void
    repairCompaction?: (location: CompactionLedgerLocation, start: Record<string, unknown>, summary: Record<string, unknown>) => Promise<unknown>
    repairToolLedger?: (location: CompactionLedgerLocation, result: Record<string, unknown>) => Promise<unknown>
    repairToolCallLedger?: (location: CompactionLedgerLocation, toolCall: Record<string, unknown>) => Promise<unknown>
    repairModelRequestLedger?: (location: CompactionLedgerLocation, projection: { requestHeader: Record<string, unknown>; requestContext: Record<string, unknown> }) => Promise<unknown>
    repairProviderRetryLedger?: (location: CompactionLedgerLocation, retry: Record<string, unknown>) => Promise<unknown>
    repairUsageLedger?: (location: CompactionLedgerLocation, requestUsage: Record<string, unknown>) => Promise<unknown>
    repairFinalRequestContextLedger?: (location: CompactionLedgerLocation, requestContext: Record<string, unknown>) => Promise<unknown>
    repairInvocationTerminal?: (location: CompactionLedgerLocation, terminal: Record<string, unknown>) => Promise<unknown>
    onCompactionRepairError?: (error: unknown, invocationId: string, compactionId: string) => void
    onToolLedgerRepairError?: (error: unknown, invocationId: string, toolCallId: string) => void
    onModelRequestLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
    onProviderRetryLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
    onUsageLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
    onFinalRequestContextLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
    onInvocationTerminalRepairError?: (error: unknown, invocationId: string, turnId: string) => void
  } = {}): Promise<RebuiltInvocationState[]> {
    const migration = this.conn.prepare(`SELECT status FROM canonical_projection_repair_migration WHERE migration_key='legacy-classification-v1'`).get() as { status: string } | undefined
    const classificationComplete = migration?.status === 'complete'
    const streams = classificationComplete
      ? this.conn.prepare(`SELECT streams.invocation_id, streams.session_id
          FROM agent_history_streams streams
          WHERE EXISTS (
            SELECT 1 FROM agent_history_events terminal
            WHERE terminal.invocation_id = streams.invocation_id
              AND terminal.sequence = streams.version
              AND terminal.kind NOT IN ('invocation-completed', 'invocation-failed', 'invocation-interrupted')
          )
          ORDER BY streams.invocation_id`).all() as Array<{ invocation_id: string; session_id: string | null }>
      : this.conn.prepare('SELECT invocation_id, session_id FROM agent_history_streams ORDER BY invocation_id').all() as Array<{ invocation_id: string; session_id: string | null }>
    const recovered: RebuiltInvocationState[] = []
      const repairRows = this.conn.prepare(`SELECT repair_id, invocation_id, repair_kind, target_key
          FROM canonical_projection_repairs WHERE status='pending' ORDER BY updated_at, repair_id`).all() as Array<{ repair_id: string; invocation_id: string; repair_kind: string; target_key: string }>
      const work = new Map<string, { sessionId: string | null; repairIds: string[] }>()
    for (const row of streams) work.set(row.invocation_id, { sessionId: row.session_id, repairIds: [] })
    for (const row of repairRows) {
      const current = work.get(row.invocation_id) ?? {
        sessionId: (this.conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id=?').get(row.invocation_id) as { session_id: string | null } | undefined)?.session_id ?? null,
        repairIds: []
      }
      current.repairIds.push(row.repair_id)
      work.set(row.invocation_id, current)
    }
    const repairTargetById = new Map(repairRows.map(({ repair_id, target_key }) => [repair_id, target_key]))
    for (const [invocationId, { sessionId: streamSessionId, repairIds }] of work) {
      let snapshot = await this.read(invocationId)
      let state = rebuildInvocationStates(snapshot).get(invocationId)
      const blockedSessionLedgers = new Set<string>()
      const canonicalToolCalls = new Map<string, { location: CompactionLedgerLocation; stepId: string }>()
      const canonicalProposalById = new Map<string, { name: string; input: unknown }>()
      const canonicalProposalIds = new Set<string>()
      let sawCanonicalModelResponse = false
      const ledgerKey = (location: CompactionLedgerLocation) => JSON.stringify([location.workDir, location.sessionId, location.createdAt])
      const recoveryLocations = new Map<string, CompactionLedgerLocation>()
      const requestIdsByTurn = new Map<string, string>()
      const repairOutcomes = new Map<string, boolean>()
      const unrepairableRepairIds = new Set<string>()
      const repairLedgerKeys = new Map<string, string>()
      const repairIdsByTarget = new Map<string, string[]>()
      for (const repairId of repairIds) {
        const targetKey = repairTargetById.get(repairId)
        if (!targetKey) continue
        repairIdsByTarget.set(targetKey, [...(repairIdsByTarget.get(targetKey) ?? []), repairId])
      }
      for (const event of snapshot.events) {
        const location = (event.payload as { sessionLedger?: { location?: unknown } } | undefined)?.sessionLedger?.location
        if (!location || typeof location !== 'object' || Array.isArray(location)) continue
        const candidate = location as Partial<CompactionLedgerLocation>
        if (typeof candidate.workDir !== 'string' || typeof candidate.sessionId !== 'string' || !Number.isFinite(candidate.createdAt)) continue
        for (const repairId of repairIdsByTarget.get(event.eventId) ?? []) repairLedgerKeys.set(repairId, ledgerKey(candidate as CompactionLedgerLocation))
      }
      const flushRepairOutcomes = () => {
        for (const repairId of repairIds) {
          const success = repairOutcomes.get(repairId) === true && !unrepairableRepairIds.has(repairId) &&
            !blockedSessionLedgers.has(repairLedgerKeys.get(repairId) ?? '')
          this.recordProjectionRepairResult(repairId, success
            ? { success: true }
            : { success: false, error: new Error('one or more canonical projections remain incomplete') })
        }
      }
      const markEventRepair = (eventId: string, success: boolean) => {
        for (const repairId of repairIdsByTarget.get(eventId) ?? []) repairOutcomes.set(repairId, success)
      }
      for (const event of snapshot.events) {
        if (event.kind !== 'model-request-started') continue
        const payload = event.payload as { modelTurn?: unknown; attempt?: unknown; sessionLedger?: { requestHeader?: unknown } } | undefined
        const header = payload?.sessionLedger?.requestHeader
        const requestId = header && typeof header === 'object' && !Array.isArray(header)
          ? (header as Record<string, unknown>).requestId
          : undefined
        if (Number.isInteger(payload?.modelTurn) && Number.isInteger(payload?.attempt) && typeof requestId === 'string' && requestId.trim()) {
          requestIdsByTurn.set(`${event.turnId}:${payload!.modelTurn}:${payload!.attempt}`, requestId)
        }
      }
      for (const event of snapshot.events) {
        const location = (event.payload as { sessionLedger?: { location?: unknown } } | undefined)?.sessionLedger?.location
        if (!location || typeof location !== 'object' || Array.isArray(location)) continue
        const candidate = location as Partial<CompactionLedgerLocation>
        if (typeof candidate.workDir !== 'string' || !candidate.workDir.trim() || typeof candidate.sessionId !== 'string' ||
          !candidate.sessionId.trim() || !Number.isFinite(candidate.createdAt)) continue
        recoveryLocations.set(ledgerKey(candidate as CompactionLedgerLocation), candidate as CompactionLedgerLocation)
      }
      for (const event of snapshot.events) {
        if (!repairIdsByTarget.has(event.eventId)) continue
        const payload = event.payload as { sessionLedger?: Record<string, unknown> } | undefined
        const ledger = payload?.sessionLedger
        const has = (field: string) => Boolean(ledger && Object.prototype.hasOwnProperty.call(ledger, field))
        const hasToolCalls = has('toolCalls') && (!Array.isArray(ledger?.toolCalls) || ledger.toolCalls.length > 0)
        const hasProjectionWork = event.kind === 'model-request-started' ? has('requestHeader') || has('requestContext')
          : event.kind === 'provider-retry-scheduled' ? has('requestRetry')
          : event.kind === 'model-response-committed' ? hasToolCalls || has('requestUsage') || has('requestContext')
          : event.kind === 'model-attempt-discarded' ? has('requestUsage')
          : event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched' ? has('result')
          : event.kind === 'transcript-compacted' ? has('start') || has('summary')
          : ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind)
        const configured = !hasProjectionWork || (event.kind === 'model-request-started' ? Boolean(options.repairModelRequestLedger)
          : event.kind === 'provider-retry-scheduled' ? Boolean(options.repairProviderRetryLedger)
          : event.kind === 'model-response-committed' ?
            (!hasToolCalls || Boolean(options.repairToolCallLedger)) &&
            (!has('requestUsage') || Boolean(options.repairUsageLedger)) &&
            (!has('requestContext') || Boolean(options.repairFinalRequestContextLedger))
          : event.kind === 'model-attempt-discarded' ? (!has('requestUsage') || Boolean(options.repairUsageLedger))
          : event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched' ? Boolean(options.repairToolLedger)
          : event.kind === 'transcript-compacted' ? Boolean(options.repairCompaction)
          : ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind) ? Boolean(options.repairInvocationTerminal)
          : false)
        if (!hasProjectionWork) markEventRepair(event.eventId, true)
        else if (!configured) {
          for (const repairId of repairIdsByTarget.get(event.eventId) ?? []) unrepairableRepairIds.add(repairId)
        }
      }
      for (const event of snapshot.events) {
        if (['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind) && options.repairInvocationTerminal) {
          const payload = event.payload as { status?: unknown; sessionLedger?: unknown }
          const ledger = payload?.sessionLedger as { location?: unknown; turnId?: unknown; reason?: unknown } | undefined
          const location = ledger?.location
          const terminalState = event.kind === 'invocation-completed' ? 'completed' : event.kind === 'invocation-interrupted' ? 'interrupted' : 'failed'
          if (location && typeof location === 'object' && !Array.isArray(location) &&
            typeof (location as { workDir?: unknown }).workDir === 'string' && typeof (location as { sessionId?: unknown }).sessionId === 'string' &&
            Number.isFinite((location as { createdAt?: unknown }).createdAt) && typeof ledger?.turnId === 'string' && ledger.turnId.trim() &&
            ['completed', 'failed', 'interrupted', 'cancelled', 'denied'].includes(String(ledger.reason)) &&
            ['completed', 'failed', 'interrupted', 'cancelled', 'denied'].includes(String(payload.status)) &&
            ((terminalState === 'completed' && payload.status === 'completed' && ledger.reason === 'completed') ||
              (terminalState === 'failed' && ['failed', 'denied'].includes(String(payload.status)) && ledger.reason === 'failed') ||
              (terminalState === 'interrupted' && payload.status === 'interrupted' && ledger.reason === 'interrupted') ||
              (terminalState === 'interrupted' && payload.status === 'cancelled' && ledger.reason === 'cancelled'))) {
            const repairLocation = location as CompactionLedgerLocation
            const repairId = `${invocationId}:invocation-projections:${event.eventId}`
            try {
              await options.repairInvocationTerminal(repairLocation, { status: payload.status as string, turnId: ledger.turnId, reason: ledger.reason })
              markEventRepair(event.eventId, true)
            }
            catch (error) {
              markEventRepair(event.eventId, false)
              try { options.onInvocationTerminalRepairError?.(error, invocationId, ledger.turnId) }
              catch { /* Keep startup recovery moving while preserving the canonical terminal for retry. */ }
            }
          }
        }
        if (event.kind === 'model-response-committed') {
          sawCanonicalModelResponse = true
          const message = (event.payload as { message?: unknown }).message as { toolCalls?: unknown } | undefined
          if (Array.isArray(message?.toolCalls)) {
            for (const call of message.toolCalls) {
              if (!call || typeof call !== 'object' || typeof (call as { id?: unknown }).id !== 'string') continue
              const id = (call as { id: string }).id
              canonicalProposalIds.add(id)
              const proposal = call as { name?: unknown; input?: unknown }
              if (typeof proposal.name === 'string') canonicalProposalById.set(id, { name: proposal.name, input: proposal.input })
            }
          }
        }
        if (event.kind === 'model-request-started' && options.repairModelRequestLedger) {
          const payload = event.payload as { requestId?: unknown; modelTurn?: unknown; attempt?: unknown; sessionLedger?: unknown }
          const ledger = payload.sessionLedger as { location?: unknown; requestHeader?: unknown; requestContext?: unknown } | undefined
          const location = ledger?.location
          const requestId = typeof payload.requestId === 'string' ? payload.requestId : 'model-request'
          if (location && typeof location === 'object' && typeof (location as { workDir?: unknown }).workDir === 'string' &&
            typeof (location as { sessionId?: unknown }).sessionId === 'string' && Number.isFinite((location as { createdAt?: unknown }).createdAt)) {
            const repairLocation = location as CompactionLedgerLocation
            const key = ledgerKey(repairLocation)
            const validModelTurn = Number.isInteger(payload.modelTurn) && (payload.modelTurn as number) > 0
            const validAttempt = Number.isInteger(payload.attempt) && (payload.attempt as number) > 0
            const requestHeader = ledger?.requestHeader
            const requestContext = ledger?.requestContext
            // The event's request ID owns its model round. The projection can retain
            // a separate external request namespace, but must agree with itself and
            // remain bound to this canonical turn.
            const expectedRequestId = validModelTurn && typeof payload.requestId === 'string' && payload.requestId.endsWith(`:round:${payload.modelTurn}`)
              ? payload.requestId
              : undefined
            const projectionRequestId = requestHeader && typeof requestHeader === 'object' && !Array.isArray(requestHeader)
              ? (requestHeader as Record<string, unknown>).requestId
              : undefined
            const header = requestHeader && typeof requestHeader === 'object' && !Array.isArray(requestHeader)
              ? requestHeader as Record<string, unknown>
              : undefined
            const context = requestContext && typeof requestContext === 'object' && !Array.isArray(requestContext)
              ? requestContext as Record<string, unknown>
              : undefined
            const projectionIdentity = {
              validModelTurn,
              validAttempt,
              payloadRequestIdMatchesExpected: requestId === expectedRequestId,
              requestHeaderPresent: header !== undefined,
              requestHeaderRequestIdMatchesPayload: typeof projectionRequestId === 'string' && projectionRequestId === requestId,
              requestHeaderAttemptMatchesPayload: header?.attempt === payload.attempt,
              requestHeaderTurnMatchesEvent: header?.turnId === undefined || header?.turnId === event.turnId,
              requestContextPresent: context !== undefined,
              requestContextRequestIdMatchesHeader: context?.requestId === projectionRequestId,
              requestContextAttemptMatchesPayload: context?.attempt === payload.attempt,
              requestContextTurnMatchesEvent: context?.turnId === undefined || context?.turnId === event.turnId
            }
            const validProjection = validModelTurn && validAttempt && requestId === expectedRequestId &&
              header !== undefined && context !== undefined &&
              typeof projectionRequestId === 'string' && projectionRequestId.endsWith(`:round:${payload.modelTurn}`) &&
              header.attempt === payload.attempt &&
              (header.turnId === undefined || header.turnId === event.turnId)
            const validRequestContext = validProjection &&
              context !== undefined && context.requestId === projectionRequestId && context.attempt === payload.attempt &&
              (context.turnId === undefined || context.turnId === event.turnId)
            if (!validRequestContext) {
              blockedSessionLedgers.add(key)
              try { options.onModelRequestLedgerRepairError?.(new Error(`canonical model request projection identity is invalid: ${JSON.stringify(projectionIdentity)}`), invocationId, requestId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
            } else if (!blockedSessionLedgers.has(key)) {
              try {
                await options.repairModelRequestLedger(repairLocation, {
                  requestHeader: requestHeader as Record<string, unknown>,
                  requestContext: requestContext as Record<string, unknown>
                })
                markEventRepair(event.eventId, true)
              } catch (error) {
                blockedSessionLedgers.add(key)
                try { options.onModelRequestLedgerRepairError?.(error, invocationId, requestId) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              }
            }
          }
        }
        if (event.kind === 'provider-retry-scheduled' && options.repairProviderRetryLedger) {
          const payload = event.payload as { requestId?: unknown; modelTurn?: unknown; retryAttempt?: unknown; routeId?: unknown; code?: unknown; backoffMs?: unknown; sessionLedger?: unknown }
          const ledger = payload.sessionLedger as { location?: unknown; requestRetry?: unknown } | undefined
          const location = ledger?.location
          if (location && typeof location === 'object' && typeof (location as { workDir?: unknown }).workDir === 'string' &&
            typeof (location as { sessionId?: unknown }).sessionId === 'string' && Number.isFinite((location as { createdAt?: unknown }).createdAt)) {
            const repairLocation = location as CompactionLedgerLocation
            const key = ledgerKey(repairLocation)
            const validRetry = Number.isInteger(payload.modelTurn) && (payload.modelTurn as number) > 0 &&
              payload.requestId === `${invocationId}:round:${payload.modelTurn}` &&
              Number.isInteger(payload.retryAttempt) && (payload.retryAttempt as number) > 0 &&
              typeof payload.routeId === 'string' && payload.routeId.length > 0 &&
              typeof payload.code === 'string' && /^[a-z0-9_]{1,64}$/.test(payload.code) &&
              typeof payload.backoffMs === 'number' && Number.isFinite(payload.backoffMs) && payload.backoffMs >= 0 &&
              ledger?.requestRetry && typeof ledger.requestRetry === 'object' && !Array.isArray(ledger.requestRetry)
            const requestRetry = ledger?.requestRetry as Record<string, unknown> | undefined
            if (!validRetry || requestRetry?.requestId !== payload.requestId || requestRetry?.attempt !== payload.retryAttempt || requestRetry?.code !== payload.code || requestRetry?.backoffMs !== payload.backoffMs ||
              (requestRetry?.turnId !== undefined && requestRetry.turnId !== event.turnId)) {
              blockedSessionLedgers.add(key)
              try { options.onProviderRetryLedgerRepairError?.(new Error('canonical provider retry projection identity is invalid'), invocationId, typeof payload.requestId === 'string' ? payload.requestId : 'provider-retry') }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
            } else if (!blockedSessionLedgers.has(key)) {
              try { await options.repairProviderRetryLedger(repairLocation, requestRetry!); markEventRepair(event.eventId, true) }
              catch (error) {
                blockedSessionLedgers.add(key)
                try { options.onProviderRetryLedgerRepairError?.(error, invocationId, String(payload.requestId)) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              }
            }
          }
        }
        if ((event.kind === 'model-response-committed' || event.kind === 'model-attempt-discarded') && (options.repairUsageLedger || (event.kind === 'model-response-committed' && options.repairFinalRequestContextLedger))) {
          const ledger = (event.payload as { sessionLedger?: unknown }).sessionLedger as Partial<CanonicalToolCallLedger> | undefined
          const location = ledger?.location
          if (location && typeof location.workDir === 'string' && typeof location.sessionId === 'string' && Number.isFinite(location.createdAt)) {
            const key = ledgerKey(location as CompactionLedgerLocation)
            const usagePayload = event.payload as { modelTurn?: unknown; attempt?: unknown }
            const modelTurn = usagePayload.modelTurn
            const attempt = usagePayload.attempt === undefined ? 1 : usagePayload.attempt
            const expectedUsageRequestId = Number.isInteger(modelTurn) && (modelTurn as number) > 0 && Number.isInteger(attempt) && (attempt as number) > 0
              ? requestIdsByTurn.get(`${event.turnId}:${modelTurn}:${attempt}`) ??
                `${invocationId}:round:${modelTurn}${(attempt as number) > 1 ? `:attempt:${attempt}` : ''}`
              : undefined
            if ((event.kind === 'model-response-committed' || event.kind === 'model-attempt-discarded') && ledger.requestUsage && typeof ledger.requestUsage === 'object' && !Array.isArray(ledger.requestUsage)) {
              const usage = ledger.requestUsage as Record<string, unknown>
              if (!expectedUsageRequestId || typeof usage.requestId !== 'string' || usage.requestId !== expectedUsageRequestId || usage.turnId !== event.turnId) {
                blockedSessionLedgers.add(key)
                try {
                  options.onUsageLedgerRepairError?.(
                    new Error('canonical request usage identity does not match its History request, model turn, or turn'),
                    invocationId,
                    typeof usage.requestId === 'string' ? usage.requestId : 'request-usage'
                  )
                } catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              } else {
                try {
                  if (!blockedSessionLedgers.has(key) && options.repairUsageLedger) {
                    await options.repairUsageLedger(location as CompactionLedgerLocation, usage)
                    markEventRepair(event.eventId, true)
                  }
                }
                catch (error) {
                  blockedSessionLedgers.add(key)
                  try { options.onUsageLedgerRepairError?.(error, invocationId, typeof usage.requestId === 'string' ? usage.requestId : 'request-usage') }
                  catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                }
              }
            }
            if (event.kind === 'model-response-committed' && options.repairFinalRequestContextLedger && !blockedSessionLedgers.has(key)) {
              const requestContext = (ledger as Partial<CanonicalToolCallLedger> & { requestContext?: unknown }).requestContext
              if (requestContext !== undefined && (!requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext))) {
                blockedSessionLedgers.add(key)
                try { options.onFinalRequestContextLedgerRepairError?.(new Error('canonical final request context is not an object'), invocationId, expectedUsageRequestId ?? 'final-request-context') }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              } else if (requestContext && typeof requestContext === 'object' && !Array.isArray(requestContext)) {
                const finalContext = requestContext as Record<string, unknown>
                if (typeof finalContext.requestId !== 'string' || finalContext.requestId !== expectedUsageRequestId || finalContext.turnId !== event.turnId ||
                  !Number.isInteger(finalContext.attempt) || (finalContext.attempt as number) <= 0 || !finalContext.contextUsage ||
                  typeof finalContext.contextUsage !== 'object' || Array.isArray(finalContext.contextUsage)) {
                  blockedSessionLedgers.add(key)
                  try { options.onFinalRequestContextLedgerRepairError?.(new Error('canonical final request context identity or usage is invalid'), invocationId, expectedUsageRequestId ?? 'final-request-context') }
                  catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                } else {
                    try { await options.repairFinalRequestContextLedger(location as CompactionLedgerLocation, finalContext); markEventRepair(event.eventId, true) }
                    catch (error) {
                      blockedSessionLedgers.add(key)
                      try { options.onFinalRequestContextLedgerRepairError?.(error, invocationId, expectedUsageRequestId ?? 'final-request-context') }
                    catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                  }
                }
              }
            }
          }
        }
        if (event.kind === 'model-response-committed') {
          const ledger = (event.payload as { sessionLedger?: unknown }).sessionLedger as Partial<CanonicalToolCallLedger> | undefined
          const location = ledger?.location
          if (location && typeof location.workDir === 'string' && typeof location.sessionId === 'string' && Number.isFinite(location.createdAt) &&
            typeof ledger.stepId === 'string' && Array.isArray(ledger.toolCalls)) {
            const key = ledgerKey(location as CompactionLedgerLocation)
            if (blockedSessionLedgers.has(key)) continue
            for (const toolCall of ledger.toolCalls) {
              if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall) || typeof toolCall.toolUseId !== 'string' || typeof toolCall.name !== 'string' || !toolCall.args || typeof toolCall.args !== 'object' || Array.isArray(toolCall.args)) {
                blockedSessionLedgers.add(key)
                const toolCallId = toolCall && typeof toolCall === 'object' && typeof toolCall.toolUseId === 'string' ? toolCall.toolUseId : 'tool-proposal'
                try { options.onToolLedgerRepairError?.(new Error('canonical tool proposal sidecar is invalid'), invocationId, toolCallId) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                break
              }
              if (!canonicalProposalIds.has(toolCall.toolUseId)) {
                blockedSessionLedgers.add(key)
                try { options.onToolLedgerRepairError?.(new Error('tool proposal sidecar identity is absent from canonical model response'), invocationId, toolCall.toolUseId) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                break
              }
              const canonicalProposal = canonicalProposalById.get(toolCall.toolUseId)
              const projectedName = canonicalProposal
                ? toolIdToOpenAiCompatibleApiToolName(normalizeExternalToolName(canonicalProposal.name).canonicalName)
                : undefined
              const projectedArgs = canonicalProposal && (projectedName === 'toolkit_call' || projectedName === 'toolkit.call')
                ? sanitizeCapabilityParamsForDisplay(canonicalProposal.input)
                : canonicalProposal?.input
              if (!canonicalProposal || projectedName !== toolCall.name || !isDeepStrictEqual(projectedArgs, toolCall.args)) {
                blockedSessionLedgers.add(key)
                try { options.onToolLedgerRepairError?.(new Error('canonical tool proposal sidecar does not match model response name or input'), invocationId, toolCall.toolUseId) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                break
              }
              canonicalToolCalls.set(toolCall.toolUseId, { location: location as CompactionLedgerLocation, stepId: ledger.stepId })
              try { await options.repairToolCallLedger?.(location as CompactionLedgerLocation, { ...toolCall, turnId: event.turnId, stepId: ledger.stepId }); markEventRepair(event.eventId, true) }
              catch (error) {
                blockedSessionLedgers.add(key)
                try { options.onToolLedgerRepairError?.(error, invocationId, toolCall.toolUseId) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                break
              }
            }
          }
        } else if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && options.repairToolLedger) {
          const payload = event.payload as { toolCallId?: unknown; reason?: unknown; result?: unknown; sessionLedger?: unknown }
          const ledger = payload.sessionLedger as Partial<CanonicalToolLedger> | undefined
          const location = ledger?.location
          if (typeof payload.toolCallId === 'string' && location && typeof location.workDir === 'string' && typeof location.sessionId === 'string' && Number.isFinite(location.createdAt) &&
            typeof ledger.stepId === 'string') {
            const key = ledgerKey(location as CompactionLedgerLocation)
            if (!ledger.result || typeof ledger.result !== 'object' || Array.isArray(ledger.result)) {
              blockedSessionLedgers.add(key)
              try { options.onToolLedgerRepairError?.(new Error('canonical tool result sidecar is invalid'), invocationId, payload.toolCallId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              continue
            }
            const proposal = canonicalToolCalls.get(payload.toolCallId)
            if ((sawCanonicalModelResponse || event.kind === 'tool-call-not-dispatched') && !canonicalProposalIds.has(payload.toolCallId)) {
              blockedSessionLedgers.add(key)
              try { options.onToolLedgerRepairError?.(new Error('canonical tool result identity does not match a preceding model response proposal'), invocationId, payload.toolCallId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              continue
            }
            if (proposal && (ledgerKey(proposal.location) !== key || proposal.stepId !== ledger.stepId)) {
              blockedSessionLedgers.add(key)
              try { options.onToolLedgerRepairError?.(new Error('canonical tool result step identity does not match its model response proposal'), invocationId, payload.toolCallId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              continue
            }
            if (event.kind === 'tool-call-finished' && !isDeepStrictEqual(payload.result, ledger.result)) {
              blockedSessionLedgers.add(key)
              try { options.onToolLedgerRepairError?.(new Error('canonical tool result sidecar does not match the committed completion result'), invocationId, payload.toolCallId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
              continue
            }
            if (blockedSessionLedgers.has(key)) continue
            try {
              await options.repairToolLedger(location as CompactionLedgerLocation, {
                toolUseId: payload.toolCallId, turnId: ledger.turnId ?? event.turnId, stepId: ledger.stepId,
                ...(ledger.requestId !== undefined ? { requestId: ledger.requestId } : {}),
                ...(ledger.invocationRequestId !== undefined ? { invocationRequestId: ledger.invocationRequestId } : {}),
                ...(ledger.lane !== undefined ? { lane: ledger.lane } : {}), result: ledger.result
              })
              markEventRepair(event.eventId, true)
            } catch (error) {
              blockedSessionLedgers.add(key)
              try { options.onToolLedgerRepairError?.(error, invocationId, payload.toolCallId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
            }
          }
        }
      }
      if (state && state.state !== 'interrupted') {
        flushRepairOutcomes()
        continue
      }
      if (options.repairCompaction) {
        for (const event of snapshot.events) {
          if (event.kind !== 'transcript-compacted') continue
          const ledger = (event.payload as { sessionLedger?: unknown } | undefined)?.sessionLedger as Partial<CanonicalCompactionLedger> | undefined
          const location = ledger?.location
          const start = ledger?.start
          const summary = ledger?.summary
          if (!location || typeof location.workDir !== 'string' || typeof location.sessionId !== 'string' || !Number.isFinite(location.createdAt) || !start || !summary) continue
          if (blockedSessionLedgers.has(ledgerKey(location as CompactionLedgerLocation))) continue
          const compactionId = typeof summary.compactionId === 'string' ? summary.compactionId : event.eventId
          try { await options.repairCompaction(location as CompactionLedgerLocation, start, summary); markEventRepair(event.eventId, true) }
          catch (error) {
            blockedSessionLedgers.add(ledgerKey(location as CompactionLedgerLocation))
            try { options.onCompactionRepairError?.(error, invocationId, compactionId) }
            catch { /* A diagnostic sink must not abort recovery or discard the retryable canonical repair record. */ }
          }
        }
      }
      if (snapshot.events.length > 0 && snapshot.events.at(-1)?.kind === 'tool-call-finished') {
        const lastEvent = snapshot.events.at(-1)!
        state = { invocationId, state: 'interrupted', lastEventId: lastEvent.eventId }
      }
      if (state?.state !== 'interrupted') {
        flushRepairOutcomes()
        continue
      }
      if (snapshot.events.at(-1)?.kind !== 'invocation-interrupted') {
        const lastEvent = snapshot.events.at(-1)
        if (!lastEvent) continue
        const sequence = snapshot.version + 1
        let recoveryLocation = recoveryLocations.size === 1 ? recoveryLocations.values().next().value as CompactionLedgerLocation : undefined
        if (recoveryLocations.size === 0 && options.resolveSessionLedgerLocation) {
          const acceptedInputs = snapshot.events.filter(({ kind }) => kind === 'session-input-committed')
          const first = snapshot.events[0]
          const payload = first?.kind === 'session-input-committed' && first.payload && typeof first.payload === 'object'
            ? first.payload as { sessionId?: unknown; role?: unknown; messageId?: unknown; inputFingerprint?: unknown }
            : undefined
          const acceptedSessionId = payload?.sessionId
          const validAcceptedInput = acceptedInputs.length === 1 && first?.sequence === 1 &&
            typeof acceptedSessionId === 'string' && acceptedSessionId.trim() &&
            (!streamSessionId || acceptedSessionId === streamSessionId) && payload?.role === 'user' &&
            typeof payload.messageId === 'string' && payload.messageId.trim() &&
            typeof payload.inputFingerprint === 'string' && /^[a-f0-9]{64}$/.test(payload.inputFingerprint)
          if (validAcceptedInput) {
            try {
              const candidate = await options.resolveSessionLedgerLocation(acceptedSessionId)
              if (candidate && candidate.sessionId === acceptedSessionId && candidate.workDir.trim() && Number.isFinite(candidate.createdAt)) {
                recoveryLocation = candidate
              }
            } catch (error) {
              try { options.onSessionLocationResolveError?.(error, invocationId, acceptedSessionId) }
              catch { /* Location diagnostics cannot abort canonical process-restart recovery. */ }
            }
          }
        }
        const terminal = { status: 'interrupted', turnId: lastEvent.turnId, reason: 'interrupted' }
        await this.appendBatch([{
          invocationId,
          turnId: lastEvent.turnId,
          sequence,
          schemaVersion: snapshot.schemaVersion,
          eventId: `${invocationId}:history:${sequence}`,
          idempotencyKey: `${invocationId}:invocation-interrupted:${sequence}`,
          kind: 'invocation-interrupted',
          payload: {
            status: 'interrupted', reason: 'process-restart',
            ...(recoveryLocation ? { sessionLedger: { location: recoveryLocation, turnId: lastEvent.turnId, reason: terminal.reason } } : {})
          }
        }], snapshot.version)
        if (recoveryLocation && options.repairInvocationTerminal) {
          const recoveryTerminalEventId = `${invocationId}:history:${sequence}`
          const recoveryRepairId = `${invocationId}:invocation-projections:${recoveryTerminalEventId}`
          try {
            await options.repairInvocationTerminal(recoveryLocation, terminal)
            this.recordProjectionRepairResult(recoveryRepairId, { success: true })
          }
          catch (error) {
            this.recordProjectionRepairResult(recoveryRepairId, { success: false, error })
            try { options.onInvocationTerminalRepairError?.(error, invocationId, lastEvent.turnId) }
            catch { /* Keep the canonical terminal sidecar for retry on the next startup. */ }
          }
        }
        snapshot = await this.read(invocationId)
        state = rebuildInvocationStates(snapshot).get(invocationId)
      }
      if (state?.state === 'interrupted') recovered.push(state)
      flushRepairOutcomes()
    }
    return recovered
  }
}

function fromRow(row: EventRow): HistoryEvent {
  return {
    invocationId: row.invocation_id,
    sequence: row.sequence,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    turnId: row.turn_id,
    schemaVersion: row.schema_version,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown
  }
}
