import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  HistoryBatchError,
  HistoryCorruptionError,
  invocationTerminalStatusMatches,
  rebuildInvocationStates,
  validateHistoryTransition,
  validateHistoryBatch,
  type HistoryAppendResult,
  type HistoryEvent,
  type HistoryPort,
  type HistorySnapshot,
  type RebuiltInvocationState
} from '../../packages/agent-sdk/src/history'
import { foldCompactionEvents, type CompactionReplay } from '../../src/shared/compactionEvents'
import { runInTransaction } from '../database/transaction'
import { currentProcessGeneration } from '../database/processGeneration'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { buildCanonicalToolResultProjectionTargets } from '../sessionLedgerOutbox'
import { projectChatBodyV1 } from '../sessionStorage/domain/projectionSpec'
import { commitSessionTranscriptInTransaction } from '../database/sessionTranscript'
import type { SessionTranscriptCommitIntent } from '../../packages/agent-sdk/src/history'
import { sanitizeCapabilityParamsForDisplay } from '../../src/shared/capabilityParamSanitize'
import { toolIdToOpenAiCompatibleApiToolName } from '../../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../../src/shared/toolNameCompatibility'
import { decodeTerminalOutcome } from './terminalOutcome'
import { classifySessionHistoryRepairFailure } from './sessionHistoryRecoveryDiagnostics'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { canonicalSessionTranscriptEvents, foldClaudeSessionSnapshots, rebuildClaudeMessagesFromHistory, toCanonicalModelMessages, type CanonicalSessionSnapshot } from './canonicalHistory'
import type { ClaudeChatMessageWithBlocks } from '../../src/shared/api'
import { createSpillStoreForDatabase, type SpillDescriptor, type SpillStore } from '../storage/spillStore'
import { collectSpillDescriptorsStrict } from '../storage/spillProtocol'
import { projectCanonicalToolResultForSessionLedger } from './sessionLedgerResultProjection'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { withSessionLedgerLifecycleLocks } from '../sessionLedgerLifecycle'
import type { SessionHistoryLedgerLocation, SessionHistoryRecoveryOptions } from '../sessionStorage/public/ports'
import type { CanonicalContextMeterEvent } from '../sessionStorage/public/model'

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableCanonicalValue(item)]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalInvocationMessagesValidationError(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'messages-not-array'
  const pendingToolCalls = new Set<string>()
  for (const rawMessage of value) {
    if (!isRecord(rawMessage)) return 'message-not-object'
    const role = rawMessage.role
    if ((rawMessage.id !== undefined && (typeof rawMessage.id !== 'string' || !rawMessage.id.trim())) ||
      (rawMessage.timestamp !== undefined && (typeof rawMessage.timestamp !== 'number' || !Number.isFinite(rawMessage.timestamp)))) return 'message-identity-invalid'
    if (role === 'system' || role === 'user' || role === 'assistant') {
      const content = rawMessage.content
      const toolCalls = rawMessage.toolCalls
      if (role === 'system' && (typeof content !== 'string' || toolCalls !== undefined)) return 'system-message-invalid'
      if (role === 'user' && toolCalls !== undefined) return 'user-message-has-tool-calls'
      if (role === 'assistant' && content === undefined && (!Array.isArray(toolCalls) || toolCalls.length === 0)) return 'empty-assistant-message'
      if (content !== undefined && typeof content !== 'string' && !Array.isArray(content)) return 'message-content-invalid'
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          if (!isRecord(rawBlock)) return 'content-block-invalid'
          if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') continue
          if (rawBlock.type === 'thinking' && typeof rawBlock.thinking === 'string' &&
            (rawBlock.thinkingSignature === undefined || typeof rawBlock.thinkingSignature === 'string') &&
            (rawBlock.redacted === undefined || typeof rawBlock.redacted === 'boolean')) continue
          if (rawBlock.type === 'image' && typeof rawBlock.data === 'string' &&
            ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(rawBlock.mimeType))) continue
          return 'content-block-unsupported'
        }
      }
      if (role === 'assistant' && toolCalls !== undefined) {
        if (!Array.isArray(toolCalls)) return 'assistant-tool-calls-invalid'
        for (const rawTool of toolCalls) {
          if (!isRecord(rawTool) || typeof rawTool.id !== 'string' || !rawTool.id.trim() ||
            typeof rawTool.name !== 'string' || !rawTool.name.trim() || !isRecord(rawTool.input) ||
            (rawTool.thoughtSignature !== undefined && typeof rawTool.thoughtSignature !== 'string')) return 'assistant-tool-call-invalid'
          if (pendingToolCalls.has(rawTool.id)) return 'duplicate-tool-call-id'
          pendingToolCalls.add(rawTool.id)
        }
      } else if (rawMessage.toolCalls !== undefined) return 'non-assistant-message-has-tool-calls'
      continue
    }
    if (role === 'tool' && typeof rawMessage.toolCallId === 'string' && rawMessage.toolCallId.trim() &&
      typeof rawMessage.isError === 'boolean' && Object.hasOwn(rawMessage, 'content') && pendingToolCalls.delete(rawMessage.toolCallId)) continue
    return role === 'tool' ? 'tool-result-unpaired-or-invalid' : 'message-role-unsupported'
  }
  return undefined
}

function validateCanonicalInvocationMessages(value: unknown): value is unknown[] {
  return canonicalInvocationMessagesValidationError(value) === undefined
}

function assistantLegacyTextProjection(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.every((block) => block && typeof block === 'object' && !Array.isArray(block) &&
    (((block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string') ||
      ((block as Record<string, unknown>).type === 'thinking' && typeof (block as Record<string, unknown>).thinking === 'string') ||
      ((block as Record<string, unknown>).type === 'image' && typeof (block as Record<string, unknown>).data === 'string')))) return undefined
  return content.filter((block) => (block as Record<string, unknown>).type === 'text')
    .map((block) => (block as Record<string, unknown>).text as string).join('')
}

function requiredUserLegacyTextProjection(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.every((block) => block && typeof block === 'object' && !Array.isArray(block) &&
    (((block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string') ||
      ((block as Record<string, unknown>).type === 'image' && typeof (block as Record<string, unknown>).data === 'string')))) return undefined
  return content.filter((block) => (block as Record<string, unknown>).type === 'text')
    .map((block) => (block as Record<string, unknown>).text as string).join('')
}

function isCanonicalWriteFence(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.sessionGeneration === 'string' && Number.isSafeInteger(value.sessionSeq) &&
    Number.isSafeInteger(value.commitOrder) && (value.watermarkEventId === null || typeof value.watermarkEventId === 'string') &&
    (value.watermarkInvocationId === null || typeof value.watermarkInvocationId === 'string')
}

export function mirrorCanonicalContextMessages(
  conn: DatabaseSync,
  sessionId: string,
  messages: readonly unknown[],
  skipMessageId?: string,
  canonicalRevision = false
): void {
  if (!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) return
  const hasTurnsTable = Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turns'").get())
  const findTarget = conn.prepare(hasTurnsTable
    ? `SELECT messages.session_id,messages.role,messages.status,messages.sequence,messages.content,messages.content_storage_state,
        (SELECT state FROM turns WHERE session_id=messages.session_id AND assistant_message_id=messages.id LIMIT 1) AS turn_state
      FROM messages WHERE messages.id=?`
    : 'SELECT session_id,role,status,sequence,content,content_storage_state,NULL AS turn_state FROM messages WHERE id=?')
  const update = conn.prepare(`UPDATE messages SET content=CASE
    WHEN content_storage_state='canonical-backed-only' THEN content ELSE ? END,
    content_storage_state=CASE
    WHEN content_storage_state='canonical-backed-only' THEN content_storage_state
    WHEN (SELECT write_mode FROM session_message_content_cutover WHERE session_id=?)='canonical'
      THEN 'canonical-backed-dual-write' ELSE content_storage_state END
    WHERE id=? AND session_id=? AND role=? AND status=?`)
  const updateEditedCanonicalBody = conn.prepare(`UPDATE messages SET content='',content_storage_state='canonical-backed-only'
    WHERE id=? AND session_id=? AND role=? AND status=? AND content_storage_state='canonical-backed-dual-write' AND content=?`)
  const lastSequence = conn.prepare('SELECT sequence FROM messages WHERE session_id=? ORDER BY sequence DESC LIMIT 1')
  const updatePreview = conn.prepare('UPDATE sessions SET preview=?,updated_at=? WHERE id=?')
  const seenMessageIds = new Set<string>()
  for (const rawMessage of messages) {
    if (!isRecord(rawMessage) || typeof rawMessage.id !== 'string' || rawMessage.id === skipMessageId ||
      (rawMessage.role !== 'user' && rawMessage.role !== 'assistant') || rawMessage.content === undefined) continue
    if (seenMessageIds.has(rawMessage.id)) {
      throw new HistoryBatchError('canonical context message identity is duplicated or conflicts with its legacy row')
    }
    seenMessageIds.add(rawMessage.id)
    const target = findTarget.get(rawMessage.id) as { session_id: string; role: string; status: string; sequence: number;
      content: string; content_storage_state: string; turn_state: string | null } | undefined
    // Canonical History also serves standalone/remote invocations that have no desktop message row.
    if (!target) continue
    if (target.session_id !== sessionId || target.role !== rawMessage.role) {
      throw new HistoryBatchError('canonical context message identity is duplicated or conflicts with its legacy row')
    }
    const eligibleStatuses = rawMessage.role === 'user'
      ? ['sent']
      : ['sent', 'completed', 'failed', 'cancelled']
    if (!eligibleStatuses.includes(target.status)) continue
    // Preserve pending/streaming/open-turn legacy state. The appended canonical context remains
    // shadow-only until the normal session identity/body audit can certify the mixed session.
    if (target.role === 'assistant' && target.turn_state !== null && target.turn_state !== 'terminal') continue
    const content = rawMessage.role === 'user'
      ? requiredUserLegacyTextProjection(rawMessage.content)
      : assistantLegacyTextProjection(rawMessage.content)
    if (content === undefined) throw new HistoryBatchError('canonical context message content cannot be mirrored exactly')
    const editedCanonicalBody = canonicalRevision && target.content_storage_state === 'canonical-backed-dual-write' && target.content !== content
    const result = editedCanonicalBody
      // Earlier History snapshots remain immutable. Once a canonical body is edited,
      // the old snapshot can no longer be checked against a current dual-write mirror.
      // Move only the changed message to canonical-only in this same History transaction.
      ? updateEditedCanonicalBody.run(rawMessage.id, sessionId, rawMessage.role, target.status, target.content)
      : update.run(content, sessionId, rawMessage.id, sessionId, rawMessage.role, target.status)
    if (Number(result.changes) !== 1) throw new HistoryBatchError('canonical context message mirror target changed during append')
    const last = lastSequence.get(sessionId) as { sequence: number } | undefined
    if (last?.sequence === target.sequence) updatePreview.run(content.slice(0, 120), Date.now(), sessionId)
  }
}

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
  session_id?: string | null
}

/** Full-stream transition state used to validate canonical tool and approval history. */
type CanonicalToolTransitionState = {
  pending: Map<string, 'proposed' | 'started'>
  toolApproval: Map<string, { approvalId: string; approved?: boolean }>
  unboundApprovalIds: Set<string>
  seenApprovalIds: Set<string>
  invalidatedApprovalIds: Map<string, string>
  pendingApprovals: Set<string>
  approvalIdentity: Map<string, string>
  terminalSeen: boolean
  turnId: string | null
}

/** P3-②: a retried repair on any invocation waits at least this long (first attempts stay immediate). */
export const REPAIR_MIN_RETRY_INTERVAL_MS = 60 * 1000

/** P3-②: failure categories that cannot heal by retrying; they leave the queue terminal-failed. */
const REPAIR_TERMINAL_FAILURE_CATEGORIES = ['workspace-root-rejected', 'storage-access-denied']

export function projectionRepairRetryDelayMs(attempts: number, _invocationRepairCount: number): number {
  // P3-②: the historical zero-backoff retry for lightly-loaded invocations re-ran a full
  // read+fold with no delay; a *retry* (attempts >= 1) now carries at least the minimum
  // interval, and repeated failures keep the exponential backoff up to the daily cap. First
  // attempts (attempts === 0) remain immediate so fresh obligations still settle during the
  // startup pass that classified them.
  if (attempts <= 0) return 0
  return Math.max(REPAIR_MIN_RETRY_INTERVAL_MS, Math.min(24 * 60 * 60 * 1000, 30 * 60 * 1000 * 2 ** Math.min(attempts - 1, 5)))
}
type OrderedSessionEventRow = EventRow & { session_seq: number; commit_order: number; session_id: string; created_at: number }

function isAnonymousReplayOnlyStream(rows: readonly OrderedSessionEventRow[]): boolean {
  return rows.length > 0 && rows.every((row) => {
    if (row.kind !== 'replay-message-committed') return false
    try {
      const payload = JSON.parse(row.payload_json) as { message?: { id?: unknown; role?: unknown } }
      return payload.message?.role === 'user' && (typeof payload.message.id !== 'string' || !payload.message.id.trim())
    } catch { return false }
  })
}

export type CanonicalSessionTranscriptRead =
  | Readonly<{ kind: 'matched'; messages: ClaudeChatMessageWithBlocks[]; sessionId: string; sessionGeneration: string; sessionSeq: number; commitOrder: number; watermarkEventId: string | null; watermarkInvocationId: string | null; eventCount: number }>
  | Readonly<{ kind: 'unavailable'; reason: 'session-missing' | 'history-absent' | 'order-invalid' | 'snapshot-invalid' | 'legacy-mismatch' }>

/** Bulk readers may skip the global scan only after validating it in the same stable SQLite snapshot. */
type CanonicalSessionTranscriptReadOptions = Readonly<{ globalCommitCursorAlreadyValidated?: boolean }>

type LegacyTranscriptMessage = Readonly<{
  id: string; role: 'user' | 'assistant'; content: string; timestamp: number
  thinking?: unknown; contentSegments?: unknown; toolCalls?: unknown; toolUse?: unknown; attachments?: unknown
  status?: unknown; sequence?: unknown; imagesDeliveredToApi?: unknown; skillHints?: unknown
}>

type CanonicalCompactionLedger = { location: SessionHistoryLedgerLocation; start: Record<string, unknown>; summary: Record<string, unknown> }
type CanonicalToolLedger = { location: SessionHistoryLedgerLocation; stepId: string; result: Record<string, unknown>; requestId?: string; invocationRequestId?: string; lane?: string; turnId?: string }
type CanonicalToolCallLedger = { location: SessionHistoryLedgerLocation; stepId?: string; toolCalls?: Array<Record<string, unknown>>; requestUsage?: Record<string, unknown> }

type MirroredContentSegment = { content: string; startTime: number; endTime?: number }

export function reconcileTerminalContentSegments(serializedSegments: string | null, finalContent: string, now: number): MirroredContentSegment[] {
  let existing: MirroredContentSegment[] = []
  if (serializedSegments) {
    try {
      const parsed: unknown = JSON.parse(serializedSegments)
      if (Array.isArray(parsed)) existing = parsed.filter((segment): segment is MirroredContentSegment =>
        Boolean(segment && typeof segment === 'object' && typeof segment.content === 'string' && Number.isFinite(segment.startTime) &&
          (segment.endTime === undefined || Number.isFinite(segment.endTime)))
      )
    } catch { /* A malformed checkpoint cannot be used to order the final answer. */ }
  }
  const existingContent = existing.map((segment) => segment.content).join('')
  if (existingContent === finalContent) return existing
  if (!finalContent) return []

  let commonPrefixLength = 0
  const limit = Math.min(existingContent.length, finalContent.length)
  while (commonPrefixLength < limit && existingContent[commonPrefixLength] === finalContent[commonPrefixLength]) commonPrefixLength += 1
  if (commonPrefixLength > 0 && existing.length > 0) {
    let remaining = commonPrefixLength
    const reconciled: MirroredContentSegment[] = []
    for (const segment of existing) {
      if (remaining <= 0) break
      const content = segment.content.slice(0, remaining)
      if (content) reconciled.push({ ...segment, content })
      remaining -= content.length
    }
    if (remaining === 0) {
      const suffix = finalContent.slice(commonPrefixLength)
      if (suffix) reconciled.push({ content: suffix, startTime: now, endTime: now })
      return reconciled
    }
  }
  return [{ content: finalContent, startTime: now, endTime: now }]
}

/** SQLite adapter for canonical SDK history. Callers must run the current migrations first. */
export class SqliteAgentHistory implements HistoryPort {
  private readonly spillStore?: SpillStore
  private readonly processGeneration: number

  constructor(private readonly conn: DatabaseSync, private readonly schemaVersion = 1, private readonly now: () => number = Date.now, private readonly sessionId?: string, spillStore?: SpillStore) {
    this.spillStore = spillStore ?? createSpillStoreForDatabase(conn)
    this.processGeneration = currentProcessGeneration(conn)
  }

  /** Rebuilds the surface-compaction replay from committed, session-owned History facts. */
  readCanonicalCompactionReplay(sessionId: string): CompactionReplay | undefined {
    const rows = this.readValidatedCanonicalCompactionRows(sessionId)
    if (!rows) return undefined

    const events: Array<{ seq: number; type: 'compaction_start' | 'compaction_summary' | 'compaction_end'; payload: Record<string, unknown> }> = []
    const rejected: CompactionReplay['rejected'] = []
    rows.forEach((row, index) => {
      if (row.kind !== 'transcript-compacted') return
      const parsedPayload: unknown = JSON.parse(row.payload_json)
      const historyPayload = isRecord(parsedPayload) ? parsedPayload : {}
      const compactionId = typeof historyPayload.compactionId === 'string' ? historyPayload.compactionId : undefined
      const ledger = historyPayload.sessionLedger
      // Provider-overflow recovery replaces only the execution transcript; it has no surface replay ledger.
      if (ledger === undefined) return
      const location = isRecord(ledger) && isRecord(ledger.location) ? ledger.location : undefined
      const start = isRecord(ledger) && isRecord(ledger.start) ? ledger.start : undefined
      const summary = isRecord(ledger) && isRecord(ledger.summary) ? ledger.summary : undefined
      if (!location || location.sessionId !== sessionId || typeof location.workDir !== 'string' || !location.workDir.trim() ||
        !Number.isSafeInteger(location.createdAt) || !start || !summary) {
        rejected.push({ ...(compactionId ? { compactionId } : {}), reason: 'canonical-session-ledger-missing-or-invalid' })
        return
      }
      const seq = (index + 1) * 3
      const startEvent = { seq, type: 'compaction_start' as const, payload: start }
      const summaryEvent = { seq: seq + 1, type: 'compaction_summary' as const, payload: summary }
      const outputWindowId = typeof summary.outputWindowId === 'string' ? summary.outputWindowId : undefined
      const endWindowId = outputWindowId ?? (typeof start.windowId === 'string' ? start.windowId : undefined)
      const inputSurfaceFingerprint = start.inputSurfaceFingerprint
      const outputSurfaceFingerprint = summary.outputSurfaceFingerprint
      const endEvent = { seq: seq + 2, type: 'compaction_end' as const, payload: {
        ...(typeof summary.compactionId === 'string' ? { compactionId: summary.compactionId } : {}),
        ...(endWindowId ? { windowId: endWindowId } : {}),
        ...(typeof summary.inputWindowId === 'string' ? { inputWindowId: summary.inputWindowId } : {}),
        ...(outputWindowId ? { outputWindowId } : {}),
        ...(typeof start.turnId === 'string' ? { turnId: start.turnId } : {}),
        status: 'committed', startSeq: startEvent.seq, summarySeq: summaryEvent.seq,
        ...(typeof inputSurfaceFingerprint === 'string' ? { inputSurfaceFingerprint } : {}),
        ...(typeof outputSurfaceFingerprint === 'string' ? { outputSurfaceFingerprint } : {}),
        ...(typeof summary.summaryHash === 'string' ? { summaryHash: summary.summaryHash } : {})
      } }
      events.push(startEvent, summaryEvent, endEvent)
    })
    const replay = foldCompactionEvents(events)
    return { committed: replay.committed, rejected: [...rejected, ...replay.rejected] }
  }

  /**
   * Compaction replay is a session-switch side read. Resolve and validate only marker-bearing History
   * streams; reading and parsing every message body or checking every global cursor made hydration
   * grow with unrelated session and database history.
   */
  private readValidatedCanonicalCompactionRows(sessionId: string): OrderedSessionEventRow[] | undefined {
    if (!sessionId.trim() || (this.sessionId && this.sessionId !== sessionId)) {
      throw new HistoryBatchError('sessionId is required or does not match this History port')
    }
    if (!this.conn.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) return undefined

    const hasCanonicalStreams = this.conn.prepare('SELECT 1 FROM agent_history_streams WHERE session_id=? LIMIT 1').get(sessionId)
    if (!hasCanonicalStreams) return undefined
    const hasOwnedEvents = this.conn.prepare(`SELECT 1 FROM agent_history_events events
      JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.session_id=? AND streams.session_id=? LIMIT 1`).get(sessionId, sessionId)
    if (!hasOwnedEvents) throw new HistoryCorruptionError(sessionId, 'canonical session History streams have no owned events')

    const ownerMismatch = this.conn.prepare(`SELECT events.invocation_id FROM agent_history_events events
      LEFT JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.kind='transcript-compacted' AND events.session_id=? AND streams.session_id IS NOT ? LIMIT 1`).get(sessionId, sessionId)
    const streamMismatch = this.conn.prepare(`SELECT events.invocation_id FROM agent_history_streams streams
      JOIN agent_history_events events ON events.invocation_id=streams.invocation_id
      WHERE streams.session_id=? AND events.kind='transcript-compacted' AND events.session_id IS NOT ? LIMIT 1`).get(sessionId, sessionId)
    if (ownerMismatch || streamMismatch) throw new HistoryCorruptionError(sessionId, 'canonical session History owner mismatch')

    const markerInvocations = this.conn.prepare(`SELECT events.invocation_id,events.session_seq,events.commit_order,
        EXISTS(SELECT 1 FROM agent_history_commit_cursor cursor WHERE cursor.id=events.commit_order) AS has_commit_cursor
      FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.session_id=? AND streams.session_id=? AND events.kind='transcript-compacted'
      ORDER BY events.session_seq,events.commit_order`).all(sessionId, sessionId) as Array<{
        invocation_id: string; session_seq: number; commit_order: number; has_commit_cursor: number
      }>
    if (markerInvocations.length === 0) return []
    const cursor = this.conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
    if (!cursor || markerInvocations.some((row, index) =>
      !Number.isSafeInteger(row.session_seq) || row.session_seq < 1 || row.session_seq > cursor.next_seq ||
      !Number.isSafeInteger(row.commit_order) || row.commit_order < 1 || row.has_commit_cursor !== 1 ||
      (index > 0 && (row.session_seq <= markerInvocations[index - 1]!.session_seq ||
        row.commit_order <= markerInvocations[index - 1]!.commit_order)))) {
      throw new HistoryCorruptionError(sessionId, 'canonical compaction History order is invalid')
    }

    const readInvocationRows = this.conn.prepare(`SELECT invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,
        payload_json,session_seq,commit_order,session_id,created_at FROM agent_history_events
      WHERE invocation_id=? ORDER BY sequence`)
    const validatedRows: OrderedSessionEventRow[] = []
    const seenInvocations = new Set<string>()
    for (const { invocation_id: invocationId } of markerInvocations) {
      if (seenInvocations.has(invocationId)) continue
      seenInvocations.add(invocationId)
      const invocationRows = readInvocationRows.all(invocationId) as OrderedSessionEventRow[]
      if (!this.isCanonicalSessionInvocationRowsValid(sessionId, invocationId, invocationRows)) {
        throw new HistoryCorruptionError(invocationId, 'canonical session History stream is invalid')
      }
      const events = invocationRows.map((row) => ({ invocationId, sequence: row.sequence, eventId: row.event_id,
        idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
        kind: row.kind as HistoryEvent['kind'], payload: JSON.parse(row.payload_json) as unknown })) as HistoryEvent[]
      try { validateHistoryTransition([], events) }
      catch { throw new HistoryCorruptionError(invocationId, 'canonical session History transition is invalid') }
      validatedRows.push(...invocationRows.filter((row) => row.kind === 'transcript-compacted'))
    }
    return validatedRows.sort((left, right) => left.session_seq - right.session_seq || left.commit_order - right.commit_order)
  }

  /** Rebuilds the request facts consumed by ContextMeter from session-owned canonical History. */
  readCanonicalContextMeterEvents(sessionId: string): readonly CanonicalContextMeterEvent[] | undefined {
    const rows = this.readValidatedSessionHistoryRows(sessionId)
    if (!rows) return undefined
    const result: CanonicalContextMeterEvent[] = []
    const add = (seq: number, type: CanonicalContextMeterEvent['type'], payload: Record<string, unknown>) => result.push({ seq, type, payload })
    for (const row of rows) {
      const raw: unknown = JSON.parse(row.payload_json)
      if (!isRecord(raw)) continue
      const ledger = raw.sessionLedger
      if (!isRecord(ledger)) continue
      const baseSeq = row.session_seq * 4
      if (row.kind === 'model-request-started') {
        const header = ledger.requestHeader
        const context = ledger.requestContext
        if (!isRecord(header) || !isRecord(context)) continue
        const requestId = header.requestId
        const attempt = header.attempt
        if (typeof requestId !== 'string' || !Number.isInteger(attempt) || context.requestId !== requestId || context.attempt !== attempt) continue
        add(baseSeq + 1, 'request_header', header)
        add(baseSeq + 2, 'request_context', context)
      } else if (row.kind === 'provider-retry-scheduled') {
        const retry = ledger.requestRetry
        if (isRecord(retry) && typeof retry.requestId === 'string' && Number.isInteger(retry.attempt)) add(baseSeq + 1, 'request_retry', retry)
      } else if (row.kind === 'model-response-committed' || row.kind === 'model-attempt-discarded') {
        const usage = ledger.requestUsage
        if (isRecord(usage) && typeof usage.requestId === 'string') add(baseSeq + 1, 'request_usage', usage)
        if (row.kind === 'model-response-committed' && isRecord(ledger.requestContext)) {
          const context = ledger.requestContext
          if (typeof context.requestId === 'string' && Number.isInteger(context.attempt)) {
            add(baseSeq + 2, 'request_context', { ...context, projectionStage: 'final' })
          }
        }
      }
    }
    return result
  }

  /** Retention proof: unknown or malformed History ownership must never imply no ledger dependency. */
  hasCanonicalCompactionDependency(sessionId: string): boolean {
    if (!sessionId.trim()) throw new HistoryBatchError('sessionId is required')
    const rows = this.conn.prepare(`SELECT events.invocation_id,events.session_id AS event_session_id,
        streams.session_id AS stream_session_id,events.payload_json
      FROM agent_history_events events LEFT JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.kind='transcript-compacted'`).all() as Array<{
        invocation_id: string; event_session_id: string | null; stream_session_id: string | null; payload_json: string
      }>
    for (const row of rows) {
      let raw: unknown
      try { raw = JSON.parse(row.payload_json) }
      catch { throw new HistoryCorruptionError(row.invocation_id, 'canonical compaction History is corrupt') }
      if (!isRecord(raw)) throw new HistoryCorruptionError(row.invocation_id, 'canonical compaction History payload is invalid')
      const owners = [row.event_session_id, row.stream_session_id].filter((owner): owner is string => typeof owner === 'string' && owner.trim().length > 0)
      if (owners.length === 2 && owners[0] !== owners[1]) throw new HistoryCorruptionError(row.invocation_id, 'canonical compaction History owner mismatch')
      const owner = owners[0]
      const ledger = raw.sessionLedger
      if (ledger === undefined) {
        // Provider recovery has no surface ledger. An unowned transcript-compacted event is ambiguous.
        if (!owner) return true
        continue
      }
      if (!isRecord(ledger)) throw new HistoryCorruptionError(row.invocation_id, 'canonical compaction History sidecar is invalid')
      const location = ledger.location
      if (!isRecord(location) || typeof location.sessionId !== 'string' || !location.sessionId.trim()) {
        if (!owner || owner === sessionId) return true
        throw new HistoryCorruptionError(row.invocation_id, 'canonical compaction History location is missing')
      }
      if (owner && owner !== location.sessionId) throw new HistoryCorruptionError(row.invocation_id, 'canonical compaction History location owner mismatch')
      if (owner === sessionId || location.sessionId === sessionId) return true
    }
    return false
  }

  private readValidatedSessionHistoryRows(sessionId: string): OrderedSessionEventRow[] | undefined {
    if (!sessionId.trim() || (this.sessionId && this.sessionId !== sessionId)) throw new HistoryBatchError('sessionId is required or does not match this History port')
    if (!this.conn.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) return undefined
    const rows = this.conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,events.turn_id,
        events.schema_version,events.kind,events.payload_json,events.session_seq,events.commit_order,events.session_id,events.created_at
      FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE streams.session_id=? AND events.session_id=? ORDER BY events.session_seq,events.commit_order`).all(sessionId, sessionId) as OrderedSessionEventRow[]
    if (rows.length === 0) {
      const hasCanonicalStreams = this.conn.prepare('SELECT 1 FROM agent_history_streams WHERE session_id=? LIMIT 1').get(sessionId)
      if (hasCanonicalStreams) throw new HistoryCorruptionError(sessionId, 'canonical session History streams have no owned events')
      return undefined
    }
    if (!this.isGlobalCommitCursorContiguous()) throw new HistoryCorruptionError(sessionId, 'canonical session History has an invalid global commit cursor')
    const cursor = this.conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
    if ((cursor?.next_seq ?? 0) !== rows.length || rows.some((row, index) => !Number.isSafeInteger(row.session_seq) || row.session_seq !== index + 1 ||
      !Number.isSafeInteger(row.commit_order) || row.commit_order < 1 || row.session_id !== sessionId || (index > 0 && row.commit_order <= rows[index - 1]!.commit_order))) {
      throw new HistoryCorruptionError(sessionId, 'canonical session History order is invalid')
    }
    const byInvocation = new Map<string, OrderedSessionEventRow[]>()
    for (const row of rows) byInvocation.set(row.invocation_id, [...(byInvocation.get(row.invocation_id) ?? []), row])
    for (const [invocationId, streamRows] of byInvocation) {
      if (!this.isCanonicalSessionInvocationRowsValid(sessionId, invocationId, streamRows)) {
        throw new HistoryCorruptionError(invocationId, 'canonical session History stream is invalid')
      }
      const events = streamRows.map((row) => ({ invocationId, sequence: row.sequence, eventId: row.event_id,
        idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
        kind: row.kind as HistoryEvent['kind'], payload: JSON.parse(row.payload_json) as unknown })) as HistoryEvent[]
      try { validateHistoryTransition([], events) }
      catch { throw new HistoryCorruptionError(invocationId, 'canonical session History transition is invalid') }
    }
    return rows
  }

  async appendBatch(events: readonly HistoryEvent[], expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent): Promise<HistoryAppendResult> {
    const locationKeys = [...new Set(events.flatMap((event) => {
      const sidecar = isRecord(event.payload) ? event.payload.sessionLedger : undefined
      const location = isRecord(sidecar) ? sidecar.location : undefined
      if (!isRecord(location) || typeof location.workDir !== 'string' || !location.workDir.trim() ||
        typeof location.sessionId !== 'string' || !location.sessionId.trim() || !Number.isSafeInteger(location.createdAt)) return []
      return [sessionLedgerLocationIdentity({ workDir: location.workDir, sessionId: location.sessionId, createdAt: location.createdAt as number }).key]
    }))]
    return withSessionLedgerLifecycleLocks(locationKeys, async () => this.appendBatchWithSpillFence(events, expectedVersion, transcriptCommit))
  }

  private async appendBatchWithSpillFence(events: readonly HistoryEvent[], expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent): Promise<HistoryAppendResult> {
    const withFence = this.spillStore?.withSpillRootFence
    if (typeof withFence !== 'function') return this.appendBatchUnderSpillFence(events, expectedVersion, transcriptCommit)
    let entered = false
    try {
      return await withFence(() => {
        entered = true
        return this.appendBatchUnderSpillFence(events, expectedVersion, transcriptCommit)
      })
    } catch (error) {
      if (entered) throw error
      // Fence/root failures prevent file preparation, but inline canonical payloads remain safe.
      return this.appendBatchUnderSpillFence(events, expectedVersion, transcriptCommit)
    }
  }

  private async appendBatchUnderSpillFence(events: readonly HistoryEvent[], expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent): Promise<HistoryAppendResult> {
    const hasSessionsTable = Boolean(this.conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
    const expectedSessionGeneration = this.sessionId && hasSessionsTable
      ? (this.conn.prepare('SELECT generation FROM sessions WHERE id=?').get(this.sessionId) as { generation: string } | undefined)?.generation
      : undefined
    const storedEvents = this.spillStore ? await Promise.all(events.map((event) => this.spillLargeCanonicalPayload(event))) : events
    let storedTranscriptJson: string | undefined
    if (this.spillStore && transcriptCommit) {
      const transcriptJson = JSON.stringify(transcriptCommit.messages)
      if (Buffer.byteLength(transcriptJson, 'utf8') > 64 * 1024) {
        try {
          const descriptor = await this.spillStore.commitSourceTruthUnderFence(transcriptJson)
          storedTranscriptJson = JSON.stringify({ __spaceassistant_session_transcript_spill_v1: descriptor })
        } catch {
          // Preserve the complete transcript snapshot inline when durable spill preparation fails.
        }
      }
    }
    return runInTransaction(this.conn, () => {
      if (this.sessionId && expectedSessionGeneration) {
        const liveGeneration = (this.conn.prepare('SELECT generation FROM sessions WHERE id=?').get(this.sessionId) as { generation: string } | undefined)?.generation
        if (!liveGeneration || liveGeneration !== expectedSessionGeneration) {
          throw new HistoryBatchError('history session generation changed during spill preparation')
        }
        const cleanup = this.conn.prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
          .get(this.sessionId) as { cleanup_state: string } | undefined
        if (cleanup && ['write-stopped', 'pending', 'complete'].includes(cleanup.cleanup_state)) {
          throw new HistoryBatchError('session message content writes are stopped for cleanup')
        }
      }
      if (transcriptCommit?.executionLease) {
        const lease = transcriptCommit.executionLease
        const terminal = events.length === 1 ? events[0] : undefined
        if (!this.sessionId || lease.sessionId !== this.sessionId || lease.sessionId !== transcriptCommit.sessionId ||
          !terminal || terminal.turnId !== lease.turnId || !Number.isSafeInteger(lease.generation) || lease.generation < 1 ||
          !lease.ownerId.trim()) throw new HistoryBatchError('SESSION_EXECUTION_CLAIM_FENCED')
      }
      const writeFence = events.map((event) => event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>).canonicalWriteFence : undefined).find(Boolean) as {
          sessionGeneration?: unknown; sessionSeq?: unknown; commitOrder?: unknown
          watermarkEventId?: unknown; watermarkInvocationId?: unknown; skeletonRevision?: unknown
          sessionOwnership?: unknown; sessionVisibility?: unknown
        } | undefined
      if (writeFence) {
        if (!this.sessionId || writeFence.sessionGeneration !== expectedSessionGeneration ||
          !Number.isSafeInteger(writeFence.sessionSeq) || !Number.isSafeInteger(writeFence.commitOrder) ||
          !(writeFence.watermarkEventId === null || typeof writeFence.watermarkEventId === 'string') ||
          !(writeFence.watermarkInvocationId === null || typeof writeFence.watermarkInvocationId === 'string')) {
          throw new HistoryBatchError('canonical write fence identity is invalid')
        }
        const current = this.conn.prepare(`SELECT session_seq,commit_order,event_id,invocation_id FROM agent_history_events
          WHERE session_id=? ORDER BY session_seq DESC LIMIT 1`).get(this.sessionId) as {
            session_seq: number; commit_order: number; event_id: string; invocation_id: string
          } | undefined
        const matches = current
          ? writeFence.sessionSeq === current.session_seq && writeFence.commitOrder === current.commit_order &&
            writeFence.watermarkEventId === current.event_id && writeFence.watermarkInvocationId === current.invocation_id
          : writeFence.sessionSeq === -1 && writeFence.commitOrder === -1 &&
            writeFence.watermarkEventId === null && writeFence.watermarkInvocationId === null
        if (!matches) throw new HistoryBatchError('canonical write fence no longer matches the session watermark')
        if (writeFence.skeletonRevision !== undefined) {
          const revision = this.conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?')
            .get(this.sessionId) as { message_revision: number } | undefined
          if (!revision || !Number.isSafeInteger(writeFence.skeletonRevision) || revision.message_revision !== writeFence.skeletonRevision) {
            throw new HistoryBatchError('canonical write fence no longer matches the message skeleton revision')
          }
        }
        if (writeFence.sessionOwnership !== undefined || writeFence.sessionVisibility !== undefined) {
          const scope = this.conn.prepare('SELECT ownership,visibility FROM sessions WHERE id=?').get(this.sessionId) as
            { ownership: string | null; visibility: string | null } | undefined
          if (!scope || scope.ownership !== writeFence.sessionOwnership || scope.visibility !== writeFence.sessionVisibility) {
            throw new HistoryBatchError('canonical write fence no longer matches the session scope')
          }
        }
      }
      const projectionTargets = this.sessionId && expectedSessionGeneration
        ? buildCanonicalToolResultProjectionTargets(this.conn, events, this.sessionId, expectedSessionGeneration, this.now())
        : []
      const appended = appendSqliteAgentHistoryBatchInTransaction(this.conn, storedEvents, expectedVersion, {
        schemaVersion: this.schemaVersion, now: this.now, processGeneration: this.processGeneration,
        ...(projectionTargets.length ? { projectionTargets } : {}),
        ...(this.sessionId ? { sessionId: this.sessionId } : {})
      })
      if (this.sessionId) {
        for (const event of events) {
          if (event.kind === 'replay-message-committed') {
            const payload = isRecord(event.payload) ? event.payload : undefined
            const message = payload?.message
            if (!isRecord(message) || message.role !== 'user' || !validateCanonicalInvocationMessages([message])) {
              throw new HistoryBatchError('canonical replay message is invalid')
            }
            continue
          }
          if (!['invocation-context-committed', 'transcript-compacted', 'model-response-committed'].includes(event.kind)) continue
          if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
            if (event.kind === 'model-response-committed') throw new HistoryBatchError('canonical assistant response payload is invalid')
            throw new HistoryBatchError(event.kind === 'transcript-compacted'
              ? 'canonical transcript snapshot payload is invalid'
              : 'canonical invocation context payload is invalid')
          }
          const payload = event.payload as Record<string, unknown>
          if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
            const messagesError = canonicalInvocationMessagesValidationError(payload.messages)
            if (messagesError) {
              throw new HistoryBatchError(event.kind === 'transcript-compacted'
                ? `canonical transcript snapshot payload is invalid (${messagesError})`
                : `canonical invocation context payload is invalid (${messagesError})`)
            }
            if (event.kind === 'transcript-compacted') continue
            if (!('requiredUserMessage' in payload)) {
              mirrorCanonicalContextMessages(this.conn, this.sessionId, payload.messages as unknown[], undefined,
                isCanonicalWriteFence(payload.canonicalWriteFence))
              continue
            }
            if (!payload.requiredUserMessage || typeof payload.requiredUserMessage !== 'object' || Array.isArray(payload.requiredUserMessage)) {
              throw new HistoryBatchError('required user message does not match canonical context identity')
            }
            const required = payload.requiredUserMessage as Record<string, unknown>
            if (typeof required.id !== 'string' || !required.message || typeof required.message !== 'object' || Array.isArray(required.message)) {
              throw new HistoryBatchError('required user message does not match canonical context identity')
            }
            const message = required.message as Record<string, unknown>
            if (message.role !== 'user') throw new HistoryBatchError('required user message does not match canonical context identity')
            const contextMessages = payload.messages as unknown[]
            const canonicalRequiredMatches = contextMessages.filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
              (candidate as Record<string, unknown>).id === required.id) as Array<Record<string, unknown>>
            const requiredContentKey = JSON.stringify(stableCanonicalValue(message.content))
            const fallbackMatches = canonicalRequiredMatches.length === 0 ? contextMessages.filter((candidate) => candidate && typeof candidate === 'object' &&
              !Array.isArray(candidate) && (candidate as Record<string, unknown>).role === 'user' &&
              JSON.stringify(stableCanonicalValue((candidate as Record<string, unknown>).content)) === requiredContentKey) as Array<Record<string, unknown>> : []
            const canonicalRequired = canonicalRequiredMatches.length === 1 ? canonicalRequiredMatches[0]
              : canonicalRequiredMatches.length === 0 && fallbackMatches.length === 1 ? fallbackMatches[0] : undefined
            const canonicalRequiredText = canonicalRequired ? requiredUserLegacyTextProjection(canonicalRequired.content) : undefined
            const requiredMessageText = requiredUserLegacyTextProjection(message.content)
            if (!canonicalRequired || canonicalRequired.role !== 'user' || canonicalRequiredText === undefined ||
              requiredMessageText === undefined || canonicalRequiredText !== requiredMessageText ||
              JSON.stringify(stableCanonicalValue(canonicalRequired.content)) !== JSON.stringify(stableCanonicalValue(message.content))) {
              throw new HistoryBatchError('required user message does not match canonical context identity')
            }
            const content = requiredMessageText
            if (content !== undefined) {
              const target = this.conn.prepare('SELECT session_id,role,status FROM messages WHERE id=?').get(required.id) as
                { session_id: string; role: string; status: string } | undefined
              // Hosted/SDK history may be recorded without a legacy UI skeleton (for example
              // standalone invocations and replay-only streams). In that case there is no row
              // to mirror. An existing ID, however, must belong to this accepted sent user.
              if (!target) continue
              if (target.session_id !== this.sessionId || target.role !== 'user' || target.status !== 'sent') {
                throw new HistoryBatchError('accepted user message mirror target is missing or not sent')
              }
              const result = this.conn.prepare(`UPDATE messages SET content=CASE
                WHEN content_storage_state='canonical-backed-only' THEN content ELSE ? END
                WHERE id=? AND session_id=? AND role='user' AND status='sent'`)
                .run(content, required.id, this.sessionId)
              if (Number(result.changes) !== 1) throw new HistoryBatchError('accepted user message mirror target is missing or not sent')
            }
            mirrorCanonicalContextMessages(this.conn, this.sessionId, contextMessages, required.id)
            continue
          }
          if (!payload.message || typeof payload.message !== 'object' || Array.isArray(payload.message)) {
            throw new HistoryBatchError('canonical assistant response payload is invalid')
          }
          const message = payload.message as Record<string, unknown>
          if (message.role !== 'assistant') throw new HistoryBatchError('canonical assistant response payload is invalid')
          const content = assistantLegacyTextProjection(message.content)
          if (message.content !== undefined && content === undefined) {
            throw new HistoryBatchError('canonical assistant response content cannot be mirrored exactly')
          }
          const hasTurnOwnership = Boolean(this.conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turns'").get())
          const turn = hasTurnOwnership
            ? this.conn.prepare('SELECT session_id,assistant_message_id FROM turns WHERE turn_id=?').get(event.turnId) as
              { session_id: string; assistant_message_id: string } | undefined
            : undefined
          if (turn && (turn.session_id !== this.sessionId || (typeof message.id === 'string' && turn.assistant_message_id !== message.id))) {
            throw new HistoryBatchError('canonical assistant response identity does not belong to the turn')
          }
          if (typeof message.id !== 'string') continue
          if (content === undefined && !turn) continue
          const target = this.conn.prepare(`SELECT status FROM messages WHERE id=? AND session_id=? AND role='assistant'`)
            .get(message.id, this.sessionId)
          if (!target) {
            if (!turn) continue
            throw new HistoryBatchError('canonical assistant response mirror target is missing or not streaming')
          }
          if ((target as { status: string }).status !== 'streaming') {
            throw new HistoryBatchError('canonical assistant response mirror target is missing or not streaming')
          }
          if (!turn) {
            throw new HistoryBatchError('canonical assistant response identity does not belong to the turn')
          }
          if (content === undefined) continue
          const mirrored = this.conn.prepare(`UPDATE messages SET content=CASE
            WHEN content_storage_state='canonical-backed-only' THEN content ELSE ? END
            WHERE id=? AND session_id=? AND role='assistant' AND status='streaming'`)
            .run(content, message.id, this.sessionId)
          if (Number(mirrored.changes) !== 1) throw new HistoryBatchError('canonical assistant response mirror target is missing or not streaming')
        }
      }
      if (!transcriptCommit) {
        // The source commit invalidates transcript parity; only a later full comparison may publish a current proof.
        return appended
      }
      if (!this.sessionId || transcriptCommit.sessionId !== this.sessionId) throw new HistoryBatchError('terminal transcript commit session identity mismatch')
      const terminal = events.length === 1 ? events[0] : undefined
      if (!terminal || !['invocation-completed', 'invocation-failed', 'invocation-interrupted', 'invocation-parked'].includes(terminal.kind)) {
        throw new HistoryBatchError('session transcript commit intent requires one terminal History event')
      }
      const outcomeMatchesTerminal = terminal.kind === 'invocation-completed' ? transcriptCommit.outcome === 'completed'
        : terminal.kind === 'invocation-failed' ? transcriptCommit.outcome === 'failed' || transcriptCommit.outcome === 'timed_out'
        : terminal.kind === 'invocation-parked' ? transcriptCommit.outcome === 'interrupted'
          : transcriptCommit.outcome === 'cancelled' || transcriptCommit.outcome === 'interrupted'
      if (!outcomeMatchesTerminal) throw new HistoryBatchError('terminal History kind does not match the transcript outcome')
      if (terminal.kind === 'invocation-parked' && transcriptCommit.messageMirror) {
        throw new HistoryBatchError('parked terminal cannot project an assistant completion mirror')
      }
      if (transcriptCommit.messageMirror) {
        const expectedStatus = transcriptCommit.outcome === 'completed' ? 'completed'
          : transcriptCommit.outcome === 'cancelled' ? 'cancelled' : 'failed'
        if (transcriptCommit.messageMirror.status !== expectedStatus) {
          throw new HistoryBatchError('terminal message mirror status does not match its outcome')
        }
      }
      const committed = commitSessionTranscriptInTransaction(this.conn, {
        sessionId: transcriptCommit.sessionId, turnId: terminal.turnId, baseVersion: transcriptCommit.baseVersion,
        outcome: transcriptCommit.outcome, messages: transcriptCommit.messages,
        ...(transcriptCommit.executionLease ? { executionLease: transcriptCommit.executionLease } : {}),
        ...(storedTranscriptJson ? { storedMessagesJson: storedTranscriptJson } : {}), now: this.now()
      })
      if (!committed.committed) throw new HistoryBatchError(`session transcript commit rejected: ${committed.reason}`)
      if (transcriptCommit.messageMirror) {
        const mirror = transcriptCommit.messageMirror
        const currentMessage = this.conn.prepare('SELECT content_segments FROM messages WHERE id=? AND session_id=? AND role=\'assistant\'')
          .get(mirror.messageId, transcriptCommit.sessionId) as { content_segments: string | null } | undefined
        const turn = this.conn.prepare('SELECT session_id,assistant_message_id FROM turns WHERE turn_id=?').get(terminal.turnId) as
          { session_id: string; assistant_message_id: string } | undefined
        if (!turn || turn.session_id !== transcriptCommit.sessionId || turn.assistant_message_id !== mirror.messageId) {
          throw new HistoryBatchError('terminal message mirror target does not belong to the committed turn')
        }
        const result = this.conn.prepare(`UPDATE messages SET
          content=CASE WHEN content_storage_state='canonical-backed-only' THEN content ELSE COALESCE(?,content) END,
          thinking=COALESCE(?,thinking),
          content_segments=COALESCE(?,content_segments),
          status=?,
          content_storage_state=CASE WHEN content_storage_state='canonical-backed-only' THEN content_storage_state
            WHEN (SELECT write_mode FROM session_message_content_cutover WHERE session_id=?)='canonical'
              THEN 'canonical-backed-dual-write' ELSE content_storage_state END
          WHERE id=? AND session_id=? AND role='assistant'`).run(
          mirror.content ?? null,
          mirror.thinking === undefined ? null : JSON.stringify(mirror.thinking),
          mirror.content === undefined || !currentMessage ? null : JSON.stringify(reconcileTerminalContentSegments(
            currentMessage.content_segments, mirror.content, this.now()
          )),
          mirror.status, transcriptCommit.sessionId, mirror.messageId, transcriptCommit.sessionId
        )
        if (Number(result.changes) !== 1) throw new HistoryBatchError('terminal message mirror target is missing or not an assistant message')
      }
      return appended
    })
  }

  /** Fold session-owned canonical snapshots and require exact equality for every legacy field this API can represent. */
  readCanonicalSessionTranscript(sessionId: string, legacyMessages: readonly LegacyTranscriptMessage[],
    options?: CanonicalSessionTranscriptReadOptions): CanonicalSessionTranscriptRead {
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
    if (!options?.globalCommitCursorAlreadyValidated && !this.isGlobalCommitCursorContiguous()) return { kind: 'unavailable', reason: 'order-invalid' }
    const cursor = this.conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
    if ((cursor?.next_seq ?? 0) !== rows.length) return { kind: 'unavailable', reason: 'order-invalid' }
    if (rows.length === 0) return legacyMessages.length === 0
      ? { kind: 'matched', messages: [], sessionId, sessionGeneration: session.generation, sessionSeq: -1,
          commitOrder: -1, watermarkEventId: null, watermarkInvocationId: null, eventCount: 0 }
      : { kind: 'unavailable', reason: 'history-absent' }
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
        if (!this.isCanonicalSessionInvocationRowsValid(sessionId, invocationId, streamRows)) {
          return { kind: 'unavailable', reason: 'order-invalid' }
        }
        const hasBase = streamRows.some((row) => row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')
        if (!hasBase) {
          if (isAnonymousReplayOnlyStream(streamRows)) continue
          if (streamRows.some((row) => ['model-response-committed', 'replay-message-committed', 'tool-call-finished', 'tool-call-not-dispatched'].includes(row.kind))) {
            return { kind: 'unavailable', reason: 'snapshot-invalid' }
          }
          continue
        }
        const events = streamRows.map((row) => ({ invocationId, sequence: row.sequence, eventId: row.event_id,
          idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
        kind: row.kind as HistoryEvent['kind'], payload: JSON.parse(row.payload_json) as unknown })) as HistoryEvent[]
        this.validateCanonicalSessionToolTransitions(events)
        const hydratedEvents = this.spillStore ? events.map((event) => this.hydrateLargeToolResultSync(event)) : events
        validateHistoryTransition([], hydratedEvents)
        const messages = rebuildClaudeMessagesFromHistory(canonicalSessionTranscriptEvents(hydratedEvents), { omitAnonymousReplayFromSessionTranscript: true,
          allowPendingToolCalls: streamRows.at(-1)?.kind === 'invocation-interrupted' })
        const last = streamRows.at(-1)!
        snapshots.push({ sessionId, invocationId, sessionSeq: last.session_seq, commitOrder: last.commit_order, messages })
      }
      const folded = foldClaudeSessionSnapshots(snapshots)
      const canonical = toCanonicalModelMessages(folded)
      if (JSON.stringify(projectChatBodyV1(canonical as never)) !== JSON.stringify(projectChatBodyV1(legacyMessages as never))) return { kind: 'unavailable', reason: 'legacy-mismatch' }
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

  /** Read and fold canonical transcript state without comparing to legacy or granting reader eligibility. */
  readCanonicalSessionTranscriptForShadow(sessionId: string, options?: CanonicalSessionTranscriptReadOptions): CanonicalSessionTranscriptRead {
    if (!sessionId.trim() || (this.sessionId && this.sessionId !== sessionId)) return { kind: 'unavailable', reason: 'session-missing' }
    const session = this.conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
    if (!session?.generation) return { kind: 'unavailable', reason: 'session-missing' }
    const rows = this.conn.prepare(`SELECT events.invocation_id, events.sequence, events.event_id, events.idempotency_key, events.turn_id,
      events.schema_version, events.kind, events.payload_json, events.session_seq, events.commit_order, events.session_id, events.created_at
      FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE streams.session_id=? AND events.session_id=? ORDER BY events.session_seq, events.commit_order`).all(sessionId, sessionId) as OrderedSessionEventRow[]
    if (!options?.globalCommitCursorAlreadyValidated && !this.isGlobalCommitCursorContiguous()) return { kind: 'unavailable', reason: 'order-invalid' }
    const cursor = this.conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
    if ((cursor?.next_seq ?? 0) !== rows.length) return { kind: 'unavailable', reason: 'order-invalid' }
    if (rows.length === 0) return { kind: 'matched', messages: [], sessionId, sessionGeneration: session.generation,
      sessionSeq: -1, commitOrder: -1, watermarkEventId: null, watermarkInvocationId: null, eventCount: 0 }
    if (rows.some((row, index) => !Number.isSafeInteger(row.session_seq) || row.session_seq !== index + 1 ||
      !Number.isSafeInteger(row.commit_order) || row.commit_order < 1 || row.session_id !== sessionId ||
      (index > 0 && row.commit_order <= rows[index - 1]!.commit_order))) return { kind: 'unavailable', reason: 'order-invalid' }
    try {
      const byInvocation = new Map<string, OrderedSessionEventRow[]>()
      for (const row of rows) byInvocation.set(row.invocation_id, [...(byInvocation.get(row.invocation_id) ?? []), row])
      const snapshots: CanonicalSessionSnapshot[] = []
      for (const [invocationId, streamRows] of byInvocation) {
        if (!this.isCanonicalSessionInvocationRowsValid(sessionId, invocationId, streamRows)) {
          return { kind: 'unavailable', reason: 'order-invalid' }
        }
        const hasBase = streamRows.some((row) => row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')
        if (!hasBase) {
          if (isAnonymousReplayOnlyStream(streamRows)) continue
          if (streamRows.some((row) => ['model-response-committed', 'replay-message-committed', 'tool-call-finished', 'tool-call-not-dispatched'].includes(row.kind))) {
            return { kind: 'unavailable', reason: 'snapshot-invalid' }
          }
          continue
        }
        const events = streamRows.map((row) => ({ invocationId, sequence: row.sequence, eventId: row.event_id,
          idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version, kind: row.kind,
          payload: JSON.parse(row.payload_json) as unknown })) as HistoryEvent[]
        this.validateCanonicalSessionToolTransitions(events)
        const hydrated = this.spillStore ? events.map((event) => this.hydrateLargeToolResultSync(event)) : events
        validateHistoryTransition([], hydrated)
        const messages = rebuildClaudeMessagesFromHistory(canonicalSessionTranscriptEvents(hydrated), { omitAnonymousReplayFromSessionTranscript: true,
          allowPendingToolCalls: streamRows.at(-1)?.kind === 'invocation-interrupted' })
        const last = streamRows.at(-1)!
        snapshots.push({ sessionId, invocationId, sessionSeq: last.session_seq, commitOrder: last.commit_order, messages })
      }
      const folded = foldClaudeSessionSnapshots(snapshots)
      const watermark = rows.at(-1)!
      const anchor = this.conn.prepare(`SELECT session_id, session_seq, commit_order, event_id, invocation_id FROM agent_history_events
        WHERE session_id=? AND session_seq=?`).get(sessionId, watermark.session_seq) as
        { session_id: string; session_seq: number; commit_order: number; event_id: string; invocation_id: string } | undefined
      if (!anchor || anchor.session_id !== sessionId || anchor.commit_order !== watermark.commit_order ||
        anchor.event_id !== watermark.event_id || anchor.invocation_id !== watermark.invocation_id) return { kind: 'unavailable', reason: 'order-invalid' }
      return { kind: 'matched', messages: folded, sessionId, sessionGeneration: session.generation, sessionSeq: watermark.session_seq,
        commitOrder: watermark.commit_order, watermarkEventId: watermark.event_id, watermarkInvocationId: watermark.invocation_id, eventCount: rows.length }
    } catch { return { kind: 'unavailable', reason: 'snapshot-invalid' } }
  }

  private isCanonicalSessionInvocationRowsValid(sessionId: string, invocationId: string, rows: readonly OrderedSessionEventRow[]): boolean {
    const stream = this.conn.prepare(`SELECT version, schema_version, session_id FROM agent_history_streams WHERE invocation_id=?`)
      .get(invocationId) as { version: number; schema_version: number; session_id: string | null } | undefined
    if (!stream || stream.session_id !== sessionId || !Number.isSafeInteger(stream.version) || stream.version !== rows.length ||
      !Number.isSafeInteger(stream.schema_version) || !rows.every((row, index) => row.invocation_id === invocationId &&
        row.session_id === sessionId && row.sequence === index + 1 && row.schema_version === stream.schema_version)) return false
    try {
      validateHistoryBatch(rows.map((row) => ({ invocationId, sequence: row.sequence, eventId: row.event_id,
        idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
        kind: row.kind as HistoryEvent['kind'], payload: JSON.parse(row.payload_json) as unknown })))
      return true
    } catch { return false }
  }

  /** Check that surviving ordered events map to allocated cursors and no allocation remains pending. */
  isGlobalCommitCursorContiguous(): boolean {
    const aggregate = this.conn.prepare(`SELECT COUNT(commit_order) AS count, MIN(commit_order) AS minimum, MAX(commit_order) AS maximum,
        COALESCE(SUM(CASE WHEN commit_order IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM agent_history_commit_cursor cursor WHERE cursor.id=agent_history_events.commit_order
        ) THEN 1 ELSE 0 END),0) AS missing_cursor_count
      FROM agent_history_events`).get() as { count: number; minimum: number | null; maximum: number | null; missing_cursor_count: number }
    const cursor = this.conn.prepare('SELECT COALESCE(MAX(id), 0) AS maximum FROM agent_history_commit_cursor').get() as { maximum: number }
    const integrity = this.conn.prepare(`SELECT invalid, EXISTS(SELECT 1 FROM agent_history_pending_commit_cursor) AS has_pending
      FROM agent_history_cursor_integrity WHERE singleton_id=1`).get() as { invalid: number; has_pending: number } | undefined
    return integrity?.invalid === 0 && integrity.has_pending === 0 && Number.isSafeInteger(aggregate.count) &&
      aggregate.missing_cursor_count === 0 && (aggregate.count === 0 ? aggregate.minimum === null && aggregate.maximum === null :
        aggregate.minimum !== null && aggregate.minimum > 0 && aggregate.maximum !== null && aggregate.maximum <= cursor.maximum)
  }

  /** Check full stream sequence/schema integrity without reading historical event payloads. */
  private isCanonicalSessionInvocationTailValid(sessionId: string, invocationId: string, rows: readonly OrderedSessionEventRow[]): boolean {
    const stream = this.conn.prepare(`SELECT version, schema_version, session_id FROM agent_history_streams WHERE invocation_id=?`)
      .get(invocationId) as { version: number; schema_version: number; session_id: string | null } | undefined
    if (!stream || stream.session_id !== sessionId || !Number.isSafeInteger(stream.version) || stream.version < 1 ||
      !Number.isSafeInteger(stream.schema_version) || rows.length === 0) return false
    const aggregate = this.conn.prepare(`SELECT COUNT(*) AS count, MIN(sequence) AS minimum, MAX(sequence) AS maximum,
      COUNT(DISTINCT turn_id) AS turn_identity_count,
      SUM(CASE WHEN sequence < ? THEN 1 ELSE 0 END) AS prefix_count,
      SUM(CASE WHEN schema_version != ? THEN 1 ELSE 0 END) AS schema_mismatch_count
      FROM agent_history_events WHERE invocation_id=? AND session_id=?`).get(rows[0]!.sequence, stream.schema_version, invocationId, sessionId) as
      { count: number; minimum: number | null; maximum: number | null; turn_identity_count: number; prefix_count: number; schema_mismatch_count: number }
    return aggregate.count === stream.version && aggregate.minimum === 1 && aggregate.maximum === stream.version && aggregate.turn_identity_count === 1 &&
      aggregate.prefix_count === rows[0]!.sequence - 1 && aggregate.schema_mismatch_count === 0 &&
      rows.every((row, index) => row.invocation_id === invocationId && row.session_id === sessionId &&
        row.schema_version === stream.schema_version && row.sequence === rows[0]!.sequence + index) &&
      rows.at(-1)!.sequence === stream.version && rows.every((row) => this.isCanonicalSessionEventRowStructurallyValid(row))
  }

  /** Replay tool and approval transitions over the complete invocation stream. */
  private replayCanonicalSessionToolTransitions(events: readonly HistoryEvent[]): CanonicalToolTransitionState {
    const state: CanonicalToolTransitionState = {
      pending: new Map(), toolApproval: new Map(), unboundApprovalIds: new Set(), seenApprovalIds: new Set(),
      invalidatedApprovalIds: new Map(),
      pendingApprovals: new Set(), approvalIdentity: new Map(), terminalSeen: false, turnId: null
    }
    const { pending, toolApproval, unboundApprovalIds, seenApprovalIds } = state
    for (const event of events) {
      state.turnId = state.turnId ?? event.turnId
      if (['invocation-completed', 'invocation-failed', 'invocation-interrupted', 'invocation-parked'].includes(event.kind)) {
        state.terminalSeen = true
      }
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as { message?: { toolCalls?: readonly { id?: unknown }[] }; toolCallId?: unknown; approvalId?: unknown;
          approved?: unknown; outcome?: unknown; settledAt?: unknown; cause?: unknown; success?: unknown; result?: unknown; answerer?: unknown; reasonCode?: unknown; requestedAt?: unknown;
          todoId?: unknown; invocationId?: unknown; checkpointId?: unknown; workflowRevision?: unknown }
        : undefined
      // P1-②: the same approval-lifecycle invariants validateHistoryTransition enforces over the
      // whole stream, applied incrementally against the persisted state (approval-waiting pending
      // keys, resolution payload shape, orphan/identity checks, terminal settlement).
      const historyApprovalId = typeof payload?.toolCallId === 'string'
        ? payload.toolCallId
        : typeof payload?.approvalId === 'string' ? payload.approvalId : undefined
      if (event.kind === 'approval-waiting') {
        const pendingId = historyApprovalId ?? event.eventId
        if (state.pendingApprovals.has(pendingId)) {
          throw new HistoryCorruptionError(event.invocationId, `approval is already pending: ${pendingId}`)
        }
        const hasMetadata = ['answerer', 'reasonCode', 'requestedAt'].some((key) => key in (payload ?? {}))
        if (hasMetadata && (typeof payload?.approvalId !== 'string' || !payload.approvalId.trim() ||
          (payload.answerer !== 'user' && payload.answerer !== 'agent') || typeof payload.reasonCode !== 'string' || !payload.reasonCode.trim() ||
          typeof payload.requestedAt !== 'number' || !Number.isFinite(payload.requestedAt))) {
          throw new HistoryCorruptionError(event.invocationId, `approval waiting metadata is invalid: ${pendingId}`)
        }
        state.pendingApprovals.add(pendingId)
        if (hasMetadata && typeof payload?.approvalId === 'string') state.approvalIdentity.set(pendingId, payload.approvalId)
      }
      if (event.kind === 'approval-resolved') {
        if (typeof payload?.approved !== 'boolean') {
          throw new HistoryCorruptionError(event.invocationId, 'approval resolution requires an approved boolean')
        }
        if (payload.outcome !== undefined) {
          const outcomes = ['approved', 'denied', 'timeout', 'unavailable', 'cancelled', 'invalidated']
          if (typeof payload.outcome !== 'string' || !outcomes.includes(payload.outcome) || payload.approved !== (payload.outcome === 'approved')) {
            throw new HistoryCorruptionError(event.invocationId, 'approval outcome conflicts with approved boolean')
          }
          if (payload.settledAt !== undefined && (typeof payload.settledAt !== 'number' || !Number.isFinite(payload.settledAt))) {
            throw new HistoryCorruptionError(event.invocationId, 'approval resolution settledAt is invalid')
          }
        }
        if (payload.answerer !== undefined && payload.answerer !== 'user' && payload.answerer !== 'agent') {
          throw new HistoryCorruptionError(event.invocationId, 'approval resolution answerer is invalid')
        }
        if (payload.cause !== undefined && (typeof payload.cause !== 'string' || !payload.cause.trim())) {
          throw new HistoryCorruptionError(event.invocationId, 'approval resolution cause is invalid')
        }
        if (!historyApprovalId || !state.pendingApprovals.has(historyApprovalId)) {
          throw new HistoryCorruptionError(event.invocationId, `approval is not pending: ${historyApprovalId ?? event.eventId}`)
        }
        const expectedApprovalId = state.approvalIdentity.get(historyApprovalId)
        if (expectedApprovalId && payload.approvalId !== expectedApprovalId) {
          throw new HistoryCorruptionError(event.invocationId, `approval resolution identity mismatch: ${historyApprovalId}`)
        }
        state.pendingApprovals.delete(historyApprovalId)
        state.approvalIdentity.delete(historyApprovalId)
      }
      if ((event.kind === 'invocation-completed' || event.kind === 'invocation-failed') &&
        (state.pendingApprovals.size > 0 || state.pending.size > 0)) {
        throw new HistoryCorruptionError(event.invocationId, 'cannot terminally settle an invocation with pending tool calls or approvals')
      }
      if (event.kind === 'model-response-committed') {
        const responseIds = new Set<string>()
        for (const call of payload?.message?.toolCalls ?? []) {
          if (unboundApprovalIds.size > 0) {
            throw new HistoryCorruptionError(event.invocationId, `canonical tool proposal follows an approval without tool identity: ${event.eventId}`)
          }
          if (typeof call.id !== 'string' || !call.id.trim() || responseIds.has(call.id) || pending.has(call.id)) {
            throw new HistoryCorruptionError(event.invocationId, `canonical model response has an empty or duplicate tool-call id: ${event.eventId}`)
          }
          responseIds.add(call.id)
          pending.set(call.id, 'proposed')
        }
      } else if (event.kind === 'tool-call-started') {
        if (typeof payload?.toolCallId !== 'string' || !payload.toolCallId.trim()) {
          throw new HistoryCorruptionError(event.invocationId, `canonical tool-call-started has no toolCallId: ${event.eventId}`)
        }
        if (pending.get(payload.toolCallId) !== 'proposed') {
          throw new HistoryCorruptionError(event.invocationId, `canonical tool-call-started has no unique pending proposal: ${event.eventId}`)
        }
        const approval = toolApproval.get(payload.toolCallId)
        if (approval && approval.approved !== true) {
          throw new HistoryCorruptionError(event.invocationId, `canonical tool-call-started has no approved matching approval: ${event.eventId}`)
        }
        pending.set(payload.toolCallId, 'started')
      } else if (event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched' || event.kind === 'approval-deferred') {
        if (typeof payload?.toolCallId !== 'string' || !payload.toolCallId.trim() || !pending.has(payload.toolCallId)) {
          throw new HistoryCorruptionError(event.invocationId, `canonical tool result has no matching pending call: ${event.eventId}`)
        }
        if (event.kind === 'approval-deferred') {
          const approval = toolApproval.get(payload.toolCallId)
          if (!approval || typeof payload.todoId !== 'string' || !payload.todoId.trim() || payload.invocationId !== event.invocationId ||
            typeof payload.checkpointId !== 'string' || !payload.checkpointId.trim() || !Number.isInteger(payload.workflowRevision) ||
            (payload.workflowRevision as number) <= 0 || payload.approvalId !== approval.approvalId) {
            throw new HistoryCorruptionError(event.invocationId, `canonical deferred approval binding is invalid: ${event.eventId}`)
          }
          toolApproval.delete(payload.toolCallId)
          pending.delete(payload.toolCallId)
          continue
        }
        if (event.kind === 'tool-call-finished' && pending.get(payload.toolCallId) !== 'started') {
          throw new HistoryCorruptionError(event.invocationId, `canonical tool result has no matching dispatch start: ${event.eventId}`)
        }
        const approval = toolApproval.get(payload.toolCallId)
        if (event.kind === 'tool-call-finished' && approval && approval.approved !== true) {
          throw new HistoryCorruptionError(event.invocationId, `canonical tool result has no approved matching approval: ${event.eventId}`)
        }
        if (event.kind === 'tool-call-finished') {
          const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
            ? payload.result as Record<string, unknown> : undefined
          if (typeof payload.success !== 'boolean' || (result && 'success' in result &&
            (typeof result.success !== 'boolean' || result.success !== payload.success))) {
            throw new HistoryCorruptionError(event.invocationId, `canonical tool result success facts conflict: ${event.eventId}`)
          }
        }
        toolApproval.delete(payload.toolCallId)
        pending.delete(payload.toolCallId)
      } else if (event.kind === 'approval-waiting') {
        const hasApprovalMetadata = ['answerer', 'reasonCode', 'requestedAt'].some((key) => key in (payload ?? {}))
        if (hasApprovalMetadata && (typeof payload?.toolCallId !== 'string' || !payload.toolCallId.trim())) {
          if (typeof payload?.approvalId !== 'string' || !payload.approvalId.trim() || pending.size > 0 || seenApprovalIds.has(payload.approvalId)) {
            throw new HistoryCorruptionError(event.invocationId, `canonical approval metadata has no unambiguous tool identity: ${event.eventId}`)
          }
          seenApprovalIds.add(payload.approvalId)
          unboundApprovalIds.add(payload.approvalId)
        }
        if (typeof payload?.toolCallId === 'string' && payload.toolCallId.trim()) {
          const canReuseInvalidatedId = typeof payload.approvalId === 'string' && state.invalidatedApprovalIds.get(payload.approvalId) === payload.toolCallId
          if (pending.get(payload.toolCallId) !== 'proposed' || typeof payload.approvalId !== 'string' || !payload.approvalId.trim() ||
            toolApproval.has(payload.toolCallId) || (seenApprovalIds.has(payload.approvalId) && !canReuseInvalidatedId)) {
            throw new HistoryCorruptionError(event.invocationId, `canonical approval has no unique tool identity: ${event.eventId}`)
          }
          if (canReuseInvalidatedId) state.invalidatedApprovalIds.delete(payload.approvalId)
          seenApprovalIds.add(payload.approvalId)
          toolApproval.set(payload.toolCallId, { approvalId: payload.approvalId })
        }
      } else if (event.kind === 'approval-resolved' && typeof payload?.toolCallId === 'string' && toolApproval.has(payload.toolCallId)) {
        const approval = toolApproval.get(payload.toolCallId)!
        if (payload.approvalId !== approval.approvalId || typeof payload.approved !== 'boolean') {
          throw new HistoryCorruptionError(event.invocationId, `canonical approval resolution identity or outcome is invalid: ${event.eventId}`)
        }
        if (payload.outcome === 'invalidated') {
          toolApproval.delete(payload.toolCallId)
          state.invalidatedApprovalIds.set(approval.approvalId, payload.toolCallId)
        }
        else approval.approved = payload.approved
      }
    }
    return state
  }

  /** Historical full-stream validation is the state-free form of the replay above. */
  private validateCanonicalSessionToolTransitions(events: readonly HistoryEvent[]): void {
    this.replayCanonicalSessionToolTransitions(events)
  }

  private isCanonicalSessionEventRowStructurallyValid(row: OrderedSessionEventRow): boolean {
    try {
      const payload = JSON.parse(row.payload_json) as unknown
      validateHistoryBatch([{ invocationId: row.invocation_id, sequence: row.sequence, eventId: row.event_id,
        idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
        kind: row.kind as HistoryEvent['kind'], payload }])
      if (['tool-call-started', 'tool-call-finished', 'tool-call-not-dispatched', 'approval-deferred'].includes(row.kind)) {
        const toolCallId = payload && typeof payload === 'object' ? (payload as { toolCallId?: unknown }).toolCallId : undefined
        if (typeof toolCallId !== 'string' || !toolCallId.trim()) return false
      }
      return true
    } catch { return false }
  }

  /** Verify every source-of-truth spill referenced by this session before trusting a cached transcript. */
  validateCanonicalSessionSourceTruthSpills(sessionId: string): void {
    const rows = this.conn.prepare(`SELECT events.payload_json
      FROM agent_history_events events
      JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.session_id=? AND streams.session_id=? AND events.payload_json LIKE '%spill%'`).all(sessionId, sessionId) as Array<{ payload_json: string }>
    for (const row of rows) {
      const descriptors = collectSpillDescriptorsStrict(JSON.parse(row.payload_json) as unknown)
      for (const descriptor of descriptors) {
        if (descriptor.kind === 'source-of-truth') this.readSourceTruthSync(descriptor)
      }
    }
  }

  /** Classifies pre-queue canonical projection obligations in bounded, resumable transactions. */
  async classifyLegacyProjectionRepairs(batchSize = 100): Promise<{ classified: number; recoveryClassified: number; complete: boolean }> {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new HistoryBatchError('batchSize must be a positive integer')
    return runInTransaction(this.conn, () => {
      const recoveryMigration = this.conn.prepare(`SELECT after_invocation_id, status FROM canonical_history_recovery_work_migration
        WHERE migration_key='active-invocations-v1'`).get() as { after_invocation_id: string | null; status: string } | undefined
      const migration = this.conn.prepare(`SELECT after_invocation_id, status FROM canonical_projection_repair_migration
        WHERE migration_key = 'legacy-classification-v1'`).get() as { after_invocation_id: string | null; status: string } | undefined
      // Compatibility bridge: until the session-scoped projection gate is installed,
      // legacy obligations remain resumably classified. Startup will stop calling this
      // classifier in the integration phase, after the replacement consumer is wired.
      const classifyRepairs = Boolean(migration && migration.status !== 'complete')
      const classifyRecovery = Boolean(recoveryMigration && recoveryMigration.status !== 'complete')
      let classified = 0
      let recoveryClassified = 0

      if (classifyRepairs) {
        const streams = this.conn.prepare(`
          SELECT streams.invocation_id, streams.session_id, streams.version
          FROM agent_history_streams streams
          WHERE (? IS NULL OR streams.invocation_id > ?)
          ORDER BY streams.invocation_id LIMIT ?
        `).all(migration!.after_invocation_id, migration!.after_invocation_id, batchSize + 1) as Array<{ invocation_id: string; session_id: string | null; version: number }>
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
        const after = batch.at(-1)?.invocation_id ?? migration!.after_invocation_id
        this.conn.prepare(`UPDATE canonical_projection_repair_migration SET after_invocation_id = ?, status = ?, updated_at = ?
          WHERE migration_key = 'legacy-classification-v1'`).run(after, hasMore ? 'pending' : 'complete', Date.now())
        classified = batch.length
      }

      if (classifyRecovery) {
        const streams = this.conn.prepare(`
          SELECT invocation_id, session_id, version FROM agent_history_streams
          WHERE (? IS NULL OR invocation_id > ?)
          ORDER BY invocation_id LIMIT ?
        `).all(recoveryMigration!.after_invocation_id, recoveryMigration!.after_invocation_id, batchSize + 1) as
          Array<{ invocation_id: string; session_id: string | null; version: number }>
        const hasMore = streams.length > batchSize
        const batch = hasMore ? streams.slice(0, batchSize) : streams
        const hasTerminal = this.conn.prepare(`SELECT 1 FROM agent_history_events
          WHERE invocation_id=? AND sequence=? AND kind IN ('invocation-completed','invocation-failed','invocation-interrupted','invocation-parked') LIMIT 1`)
        const addWork = this.conn.prepare(`INSERT INTO canonical_history_recovery_work(invocation_id,session_id,updated_at)
          VALUES(?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at`)
        const removeWork = this.conn.prepare('DELETE FROM canonical_history_recovery_work WHERE invocation_id=?')
        for (const stream of batch) {
          if (hasTerminal.get(stream.invocation_id, stream.version)) removeWork.run(stream.invocation_id)
          else addWork.run(stream.invocation_id, stream.session_id, Date.now())
        }
        const after = batch.at(-1)?.invocation_id ?? recoveryMigration!.after_invocation_id
        this.conn.prepare(`UPDATE canonical_history_recovery_work_migration SET after_invocation_id=?,status=?,updated_at=?
          WHERE migration_key='active-invocations-v1'`).run(after, hasMore ? 'pending' : 'complete', Date.now())
        recoveryClassified = batch.length
      }

      const currentRepairStatus = this.conn.prepare(`SELECT status FROM canonical_projection_repair_migration
        WHERE migration_key='legacy-classification-v1'`).get() as { status: string } | undefined
      const currentRecoveryStatus = this.conn.prepare(`SELECT status FROM canonical_history_recovery_work_migration
        WHERE migration_key='active-invocations-v1'`).get() as { status: string } | undefined
      const repairsComplete = !currentRepairStatus || currentRepairStatus.status === 'complete'
      const recoveryComplete = !currentRecoveryStatus || currentRecoveryStatus.status === 'complete'
      return { classified, recoveryClassified, complete: repairsComplete && recoveryComplete }
    })
  }

  /**
   * Pending obligations are retried independently; success is the only transition to completed.
   * P3-②: a deterministically unrecoverable classification (workspace root rejected, storage
   * access denied) flags the row terminal so every retry query excludes it permanently.
   */
  recordProjectionRepairResult(repairId: string, result: { success: true } | { success: false; error: unknown }): void {
    const now = Date.now()
    if (result.success) {
      this.conn.prepare(`UPDATE canonical_projection_repairs SET status = 'completed', attempts = attempts + 1,
        last_error = NULL, updated_at = ? WHERE repair_id = ?`).run(now, repairId)
    } else {
      const message = result.error instanceof Error ? result.error.message : String(result.error)
      const category = classifySessionHistoryRepairFailure(result.error)
      const terminal = REPAIR_TERMINAL_FAILURE_CATEGORIES.includes(category) ? 1 : 0
      this.conn.prepare(`UPDATE canonical_projection_repairs SET status = 'pending', terminal_failed = ?, attempts = attempts + 1,
        last_error = ?, updated_at = ? WHERE repair_id = ?`).run(terminal, message, now, repairId)
    }
  }

  /** Returns the durable unfinished-work set while legacy rows are incorporated in resumable batches. */
  listStartupRecoveryWorkset(): Array<{ invocationId: string; sessionId: string | null }> {
    const processGeneration = currentProcessGeneration(this.conn)
    const migration = this.conn.prepare(`SELECT status FROM canonical_history_recovery_work_migration
      WHERE migration_key='active-invocations-v1'`).get() as { status: string } | undefined
    const query = migration?.status === 'complete' ? `SELECT work.invocation_id,work.session_id FROM canonical_history_recovery_work work
      LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=work.session_id
      WHERE cutover.cleanup_state IS NULL OR cutover.cleanup_state NOT IN ('write-stopped','pending','complete')
        ${processGeneration > 0 ? `AND (work.owner_generation IS NULL OR work.owner_generation < ${processGeneration})` : ''}
      ORDER BY work.invocation_id` : `SELECT streams.invocation_id,streams.session_id FROM agent_history_streams streams
      LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=streams.session_id
      WHERE NOT EXISTS (SELECT 1 FROM agent_history_events terminal
          WHERE terminal.invocation_id=streams.invocation_id AND terminal.sequence=streams.version
            AND terminal.kind IN ('invocation-completed','invocation-failed','invocation-interrupted','invocation-parked'))
        ${processGeneration > 0 ? `AND NOT EXISTS (SELECT 1 FROM canonical_history_recovery_work current_work
          WHERE current_work.invocation_id=streams.invocation_id AND current_work.owner_generation>=${processGeneration})` : ''}
        AND (cutover.cleanup_state IS NULL OR cutover.cleanup_state NOT IN ('write-stopped','pending','complete'))
      ORDER BY streams.invocation_id`
    return this.conn.prepare(query).all()
      .map((row) => {
        const value = row as { invocation_id: string; session_id: string | null }
        return { invocationId: value.invocation_id, sessionId: value.session_id }
      })
  }

  /** Reports only recovery work that startup will actually attempt now; backed-off repairs stay out of this count. */
  getStartupRecoveryWorkSummary(): { unfinishedInvocationCount: number; dueProjectionRepairCount: number; hasWork: boolean } {
    const unfinishedInvocationCount = this.listStartupRecoveryWorkset().length
    const now = this.now()
    const dueProjectionRepairCount = (this.conn.prepare(`SELECT COUNT(*) AS count
        FROM canonical_projection_repairs repairs
        LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=repairs.session_id
        WHERE repairs.status='pending' AND repairs.terminal_failed=0 AND
          (cutover.cleanup_state IS NULL OR cutover.cleanup_state NOT IN ('write-stopped','pending','complete')) AND
          (repairs.attempts=0 OR repairs.updated_at<=?-CASE repairs.attempts
            WHEN 1 THEN 1800000 WHEN 2 THEN 3600000 WHEN 3 THEN 7200000 WHEN 4 THEN 14400000
            WHEN 5 THEN 28800000 WHEN 6 THEN 57600000 ELSE 86400000 END)`).get(now) as { count: number }).count
    return {
      unfinishedInvocationCount,
      dueProjectionRepairCount,
      hasWork: unfinishedInvocationCount > 0 || dueProjectionRepairCount > 0
    }
  }

  /** Lists canonical invocation streams owned by a session in their first durable commit order. */
  listInvocationIdsForSession(sessionId: string): string[] {
    if (!sessionId.trim()) throw new HistoryBatchError('sessionId is required')
    const corrupt = this.conn.prepare(`SELECT streams.invocation_id FROM agent_history_streams AS streams
      JOIN agent_history_events AS events ON events.invocation_id=streams.invocation_id
      WHERE streams.session_id=? AND events.session_id IS NOT NULL AND events.session_id<>streams.session_id
      LIMIT 1`).get(sessionId) as { invocation_id: string } | undefined
    if (corrupt) throw new HistoryCorruptionError(corrupt.invocation_id, 'event session ownership differs from its invocation stream')
    return (this.conn.prepare(`
      SELECT streams.invocation_id
      FROM agent_history_streams AS streams
      JOIN agent_history_events AS events ON events.invocation_id = streams.invocation_id
      WHERE streams.session_id = ?
      GROUP BY streams.invocation_id
      ORDER BY MIN(events.commit_order) IS NULL ASC, MIN(events.commit_order) ASC,
        MIN(events.session_seq) IS NULL ASC, MIN(events.session_seq) ASC,
        MIN(events.created_at) ASC, MIN(events.rowid) ASC, streams.invocation_id ASC
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
    // P0-⑤: the unavailable verdict already carries the stream it just read, so callers
    // (hostedTurnHandoff recovery) never re-read the same full invocation.
    | Readonly<{ kind: 'unavailable'; invocationId: string; snapshot: HistorySnapshot }>
  > {
    const excluded = new Set([...(options.excludeInvocationId ? [options.excludeInvocationId] : []), ...(options.excludeInvocationIds ?? [])])
    const invocationIds = this.listInvocationIdsForSession(sessionId).filter((id) => !excluded.has(id))
    if (invocationIds.length === 0) return { kind: 'none' }
    for (const invocationId of invocationIds.reverse()) {
      const snapshot = await this.read(invocationId)
      const terminal = snapshot.events.at(-1)
      // Open/interrupted streams may represent a crashed turn whose canonical tail is incomplete.
      if (!terminal || !['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(terminal.kind)) {
        return { kind: 'unavailable', invocationId, snapshot }
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
        return { kind: 'unavailable', invocationId, snapshot }
      }
      if (!snapshot.events.some(({ kind }) => kind === 'invocation-context-committed' || kind === 'transcript-compacted')) {
        return { kind: 'unavailable', invocationId, snapshot }
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
      SELECT invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, session_id
      FROM agent_history_events WHERE invocation_id = ? ORDER BY sequence ASC
    `).all(resolvedInvocationId) as EventRow[]
    if (!stream && rows.length > 0) throw new HistoryCorruptionError(invocationId, 'events exist without a stream record')
    if (stream && rows.some((row) => row.session_id !== null && row.session_id !== stream.session_id)) {
      throw new HistoryCorruptionError(invocationId, 'event session ownership differs from its invocation stream')
    }
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

  /** Reads one committed, session-owned event without hydrating its containing invocation. */
  readCommittedSessionEventSync(input: { sessionId: string; eventId: string; sessionSequence: number }): HistoryEvent | undefined {
    const row = this.conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,
        events.turn_id,events.schema_version,events.kind,events.payload_json,events.session_id,
        streams.version AS stream_version,streams.schema_version AS stream_schema_version,streams.session_id AS stream_session_id
      FROM agent_history_events events
      JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      JOIN agent_history_commit_cursor cursor ON cursor.id=events.commit_order
      WHERE events.event_id=? AND events.session_id=? AND events.session_seq=? LIMIT 1`)
      .get(input.eventId, input.sessionId, input.sessionSequence) as (EventRow & {
        stream_version: number; stream_schema_version: number; stream_session_id: string | null
      }) | undefined
    if (!row) return undefined
    if (row.session_id !== input.sessionId || row.stream_session_id !== input.sessionId ||
      row.schema_version !== row.stream_schema_version || row.schema_version !== this.schemaVersion ||
      !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence > row.stream_version) {
      throw new HistoryCorruptionError(input.eventId, 'committed session History event ownership or version is invalid')
    }
    try {
      const event = fromRow(row)
      const hydrated = this.spillStore ? this.hydrateLargeToolResultSync(event) : event
      validateHistoryBatch([hydrated])
      return hydrated
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'SPILL_CONTENT_UNAVAILABLE') throw error
      throw new HistoryCorruptionError(input.eventId, error instanceof Error ? error.message : String(error))
    }
  }

  private async spillLargeCanonicalPayload(event: HistoryEvent): Promise<HistoryEvent> {
    if (!event.payload || typeof event.payload !== 'object') return event
    const payload = event.payload as Record<string, unknown>
    try {
      const spillText = async (value: unknown): Promise<unknown> => {
        if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 64 * 1024) {
          const descriptor = await this.spillStore!.commitSourceTruthUnderFence(value)
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
          const validOutcomes = ['approved', 'denied', 'timeout', 'unavailable', 'cancelled', 'invalidated']
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
                : payload.outcome === 'cancelled' || payload.outcome === 'invalidated' ? 'cancelled' : 'denied'
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
  async recoverInterruptedInvocations(options: SessionHistoryRecoveryOptions = {}): Promise<RebuiltInvocationState[]> {
    const streams = this.listStartupRecoveryWorkset().map(({ invocationId, sessionId }) => ({
      invocation_id: invocationId, session_id: sessionId
    }))
    const recovered: RebuiltInvocationState[] = []
      const retryTime = this.now()
      const repairRows = this.conn.prepare(`SELECT repairs.repair_id,repairs.invocation_id,repairs.repair_kind,repairs.target_key,
          repairs.attempts,repairs.updated_at
          FROM canonical_projection_repairs repairs
          LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=repairs.session_id
          WHERE repairs.status='pending' AND repairs.terminal_failed=0 AND
            (cutover.cleanup_state IS NULL OR cutover.cleanup_state NOT IN ('write-stopped','pending','complete')) AND
            (repairs.attempts=0 OR repairs.updated_at<=?-CASE repairs.attempts
              WHEN 1 THEN 1800000 WHEN 2 THEN 3600000 WHEN 3 THEN 7200000 WHEN 4 THEN 14400000
              WHEN 5 THEN 28800000 WHEN 6 THEN 57600000 ELSE 86400000 END)
          ORDER BY repairs.updated_at,repairs.repair_id`).all(retryTime) as Array<{
            repair_id: string; invocation_id: string; repair_kind: string; target_key: string; attempts: number; updated_at: number
          }>
      const dueRepairRows = repairRows
      const work = new Map<string, { sessionId: string | null; repairIds: string[] }>()
    for (const row of streams) work.set(row.invocation_id, { sessionId: row.session_id, repairIds: [] })
    for (const row of dueRepairRows) {
      const current = work.get(row.invocation_id) ?? {
        sessionId: (this.conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id=?').get(row.invocation_id) as { session_id: string | null } | undefined)?.session_id ?? null,
        repairIds: []
      }
      current.repairIds.push(row.repair_id)
      work.set(row.invocation_id, current)
    }
    const repairTargetById = new Map(dueRepairRows.map(({ repair_id, target_key }) => [repair_id, target_key]))
    for (const [invocationId, { sessionId: streamSessionId, repairIds }] of work) {
      try {
        let snapshot = await this.read(invocationId)
        let state = rebuildInvocationStates(snapshot).get(invocationId)
        const blockedSessionLedgers = new Set<string>()
        const canonicalToolCalls = new Map<string, { location: SessionHistoryLedgerLocation; stepId: string }>()
        const canonicalProposalById = new Map<string, { name: string; input: unknown }>()
        const canonicalProposalIds = new Set<string>()
        let sawCanonicalModelResponse = false
        const ledgerKey = (location: SessionHistoryLedgerLocation) => JSON.stringify([location.workDir, location.sessionId, location.createdAt])
        const recoveryLocations = new Map<string, SessionHistoryLedgerLocation>()
        const requestIdsByTurn = new Map<string, string>()
        // S4: keep the real callback error per repair so the governance classifier can see
        // workspace-root-rejected / storage-access-denied categories; the boolean folding made
        // the terminal categories unreachable for every repair kind except invocation-terminal.
        const repairOutcomes = new Map<string, { ok: boolean; error?: unknown }>()
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
          const candidate = location as Partial<SessionHistoryLedgerLocation>
          if (typeof candidate.workDir !== 'string' || typeof candidate.sessionId !== 'string' || !Number.isFinite(candidate.createdAt)) continue
          for (const repairId of repairIdsByTarget.get(event.eventId) ?? []) repairLedgerKeys.set(repairId, ledgerKey(candidate as SessionHistoryLedgerLocation))
        }
        const flushRepairOutcomes = () => {
          for (const repairId of repairIds) {
            const outcome = repairOutcomes.get(repairId)
            const success = outcome?.ok === true && !unrepairableRepairIds.has(repairId) &&
              !blockedSessionLedgers.has(repairLedgerKeys.get(repairId) ?? '')
            this.recordProjectionRepairResult(repairId, success
              ? { success: true }
              : { success: false, error: outcome?.error ?? new Error('one or more canonical projections remain incomplete') })
          }
        }
        const markEventRepair = (eventId: string, success: boolean, error?: unknown) => {
          for (const repairId of repairIdsByTarget.get(eventId) ?? []) repairOutcomes.set(repairId, { ok: success, error })
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
          const candidate = location as Partial<SessionHistoryLedgerLocation>
          if (typeof candidate.workDir !== 'string' || !candidate.workDir.trim() || typeof candidate.sessionId !== 'string' ||
            !candidate.sessionId.trim() || !Number.isFinite(candidate.createdAt)) continue
          recoveryLocations.set(ledgerKey(candidate as SessionHistoryLedgerLocation), candidate as SessionHistoryLedgerLocation)
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
              const repairLocation = location as SessionHistoryLedgerLocation
              try {
                const processRestart = event.kind === 'invocation-interrupted' && payload.status === 'interrupted' &&
                  (event.payload as { reason?: unknown }).reason === 'process-restart'
                const toolUseIds = processRestart ? pendingInterruptedToolUseIds(snapshot.events) : []
                await options.repairInvocationTerminal(repairLocation, {
                  status: payload.status as string, turnId: ledger.turnId, reason: ledger.reason,
                  ...(processRestart ? { canonicalTerminalEventId: event.eventId, toolUseIds } : {})
                })
                markEventRepair(event.eventId, true)
              }
              catch (error) {
                markEventRepair(event.eventId, false, error)
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
              const repairLocation = location as SessionHistoryLedgerLocation
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
                  markEventRepair(event.eventId, false, error)
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
              const repairLocation = location as SessionHistoryLedgerLocation
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
                  markEventRepair(event.eventId, false, error)
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
              const key = ledgerKey(location as SessionHistoryLedgerLocation)
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
                      await options.repairUsageLedger(location as SessionHistoryLedgerLocation, usage)
                      markEventRepair(event.eventId, true)
                    }
                  }
                  catch (error) {
                    markEventRepair(event.eventId, false, error)
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
                      try { await options.repairFinalRequestContextLedger(location as SessionHistoryLedgerLocation, finalContext); markEventRepair(event.eventId, true) }
                      catch (error) {
                        blockedSessionLedgers.add(key)
                        markEventRepair(event.eventId, false, error)
                        try { options.onFinalRequestContextLedgerRepairError?.(error, invocationId, expectedUsageRequestId ?? "final-request-context") }
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
              const key = ledgerKey(location as SessionHistoryLedgerLocation)
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
                canonicalToolCalls.set(toolCall.toolUseId, { location: location as SessionHistoryLedgerLocation, stepId: ledger.stepId })
                try { await options.repairToolCallLedger?.(location as SessionHistoryLedgerLocation, { ...toolCall, turnId: event.turnId, stepId: ledger.stepId }); markEventRepair(event.eventId, true) }
                catch (error) {
                  blockedSessionLedgers.add(key)
                  markEventRepair(event.eventId, false, error)
                  try { options.onToolLedgerRepairError?.(error, invocationId, toolCall.toolUseId) }
                  catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                  break
                }
              }
            }
          } else if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && options.repairToolLedger) {
            const payload = event.payload as { toolCallId?: unknown; reason?: unknown; result?: unknown; isError?: unknown; auditRef?: unknown; sessionLedger?: unknown }
            const ledger = payload.sessionLedger as Partial<CanonicalToolLedger> | undefined
            const location = ledger?.location
            if (typeof payload.toolCallId === 'string' && location && typeof location.workDir === 'string' && typeof location.sessionId === 'string' && Number.isFinite(location.createdAt) &&
              typeof ledger.stepId === 'string') {
              const key = ledgerKey(location as SessionHistoryLedgerLocation)
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
              const canonicalProposal = canonicalProposalById.get(payload.toolCallId)
              const toolName = canonicalProposal?.name
              const expectedResult = event.kind === 'tool-call-finished' && isRecord(payload.result)
                ? projectCanonicalToolResultForSessionLedger({
                  rawResult: payload.result,
                  isError: payload.isError === true,
                  ...(toolName ? { toolName } : {}),
                  ...(typeof payload.auditRef === 'string' ? { auditRef: payload.auditRef } : {}),
                  deferredUnsurfaced: ledger.result.deferredUnsurfaced === true
                })
                : undefined
              if (event.kind === 'tool-call-finished' && (!expectedResult || !isDeepStrictEqual(expectedResult, ledger.result))) {
                blockedSessionLedgers.add(key)
                try { options.onToolLedgerRepairError?.(new Error('canonical tool result sidecar does not match the committed completion result'), invocationId, payload.toolCallId) }
                catch { /* Diagnostics must not discard the canonical repair envelope. */ }
                continue
              }
              if (blockedSessionLedgers.has(key)) continue
              try {
                await options.repairToolLedger(location as SessionHistoryLedgerLocation, {
                  toolUseId: payload.toolCallId, turnId: ledger.turnId ?? event.turnId, stepId: ledger.stepId,
                  ...(ledger.requestId !== undefined ? { requestId: ledger.requestId } : {}),
                  ...(ledger.invocationRequestId !== undefined ? { invocationRequestId: ledger.invocationRequestId } : {}),
                  ...(ledger.lane !== undefined ? { lane: ledger.lane } : {}), result: ledger.result
                })
                markEventRepair(event.eventId, true)
              } catch (error) {
                blockedSessionLedgers.add(key)
                markEventRepair(event.eventId, false, error)
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
            if (blockedSessionLedgers.has(ledgerKey(location as SessionHistoryLedgerLocation))) continue
            const compactionId = typeof summary.compactionId === 'string' ? summary.compactionId : event.eventId
            try { await options.repairCompaction(location as SessionHistoryLedgerLocation, start, summary); markEventRepair(event.eventId, true) }
            catch (error) {
              blockedSessionLedgers.add(ledgerKey(location as SessionHistoryLedgerLocation))
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
        // Parked invocations retain durable deferred-approval state; restart recovery must not
        // append an additional interrupted terminal event for them.
        if (snapshot.events.at(-1)?.kind === 'invocation-parked') {
          flushRepairOutcomes()
          continue
        }
        if (snapshot.events.at(-1)?.kind !== 'invocation-interrupted') {
          const lastEvent = snapshot.events.at(-1)
          if (!lastEvent) continue
          const sequence = snapshot.version + 1
          let recoveryLocation = recoveryLocations.size === 1 ? recoveryLocations.values().next().value as SessionHistoryLedgerLocation : undefined
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
          const processRestartEventId = `${invocationId}:history:${sequence}`
          const toolUseIds = pendingInterruptedToolUseIds(snapshot.events)
          const terminal = { status: 'interrupted', turnId: lastEvent.turnId, reason: 'interrupted',
            canonicalTerminalEventId: processRestartEventId, toolUseIds }
          await this.appendBatch([{
            invocationId,
            turnId: lastEvent.turnId,
            sequence,
            schemaVersion: snapshot.schemaVersion,
            eventId: processRestartEventId,
            idempotencyKey: `${invocationId}:invocation-interrupted:${sequence}`,
            kind: 'invocation-interrupted',
            payload: {
              status: 'interrupted', reason: 'process-restart',
              ...(recoveryLocation ? { sessionLedger: { location: recoveryLocation, turnId: lastEvent.turnId, reason: terminal.reason } } : {})
            }
          }], snapshot.version)
          if (recoveryLocation && options.repairInvocationTerminal) {
            const recoveryTerminalEventId = processRestartEventId
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
        if (state?.state === 'interrupted' && snapshot.events.at(-1)?.kind !== 'invocation-parked') recovered.push(state)
        flushRepairOutcomes()
      } catch (error) {
        if (!(error instanceof HistoryCorruptionError)) throw error
        options.onSessionRecoveryFailure?.(error, invocationId, streamSessionId)
      }
    }
    return recovered
  }
}

function pendingInterruptedToolUseIds(events: readonly HistoryEvent[]): string[] {
  const pending = new Set<string>()
  for (const event of events) {
    const payload = event.payload as { toolCallId?: unknown } | undefined
    if (event.kind === 'tool-call-started' && typeof payload?.toolCallId === 'string' && payload.toolCallId.trim()) {
      pending.add(payload.toolCallId)
    } else if (['tool-call-finished', 'tool-call-not-dispatched', 'tool-call-deferred'].includes(event.kind) && typeof payload?.toolCallId === 'string') {
      pending.delete(payload.toolCallId)
    }
  }
  return [...pending].sort()
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
