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
import { sanitizeCapabilityParamsForDisplay } from '../../src/shared/capabilityParamSanitize'
import { toolIdToOpenAiCompatibleApiToolName } from '../../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../../src/shared/toolNameCompatibility'
import { decodeTerminalOutcome } from './terminalOutcome'

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
type CompactionLedgerLocation = { workDir: string; sessionId: string; createdAt: number }
type CanonicalCompactionLedger = { location: CompactionLedgerLocation; start: Record<string, unknown>; summary: Record<string, unknown> }
type CanonicalToolLedger = { location: CompactionLedgerLocation; stepId: string; result: Record<string, unknown>; requestId?: string; invocationRequestId?: string; lane?: string; turnId?: string }
type CanonicalToolCallLedger = { location: CompactionLedgerLocation; stepId?: string; toolCalls?: Array<Record<string, unknown>>; requestUsage?: Record<string, unknown> }

/** SQLite adapter for canonical SDK history. Callers must run the current migrations first. */
export class SqliteAgentHistory implements HistoryPort {
  constructor(private readonly conn: DatabaseSync, private readonly schemaVersion = 1, private readonly now: () => number = Date.now, private readonly sessionId?: string) {}

  async appendBatch(events: readonly HistoryEvent[], expectedVersion: number): Promise<HistoryAppendResult> {
    return runInTransaction(this.conn, () => appendSqliteAgentHistoryBatchInTransaction(this.conn, events, expectedVersion, {
      schemaVersion: this.schemaVersion, now: this.now, ...(this.sessionId ? { sessionId: this.sessionId } : {})
    }))
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
        validateHistoryBatch([event])
        return event
      } catch (error) {
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
    const streams = this.conn.prepare('SELECT invocation_id, session_id FROM agent_history_streams ORDER BY invocation_id').all() as Array<{ invocation_id: string; session_id: string | null }>
    const recovered: RebuiltInvocationState[] = []
    for (const { invocation_id: invocationId, session_id: streamSessionId } of streams) {
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
            try { await options.repairInvocationTerminal(repairLocation, { status: payload.status as string, turnId: ledger.turnId, reason: ledger.reason }) }
            catch (error) {
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
              try { await options.repairProviderRetryLedger(repairLocation, requestRetry!) }
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
                try { if (!blockedSessionLedgers.has(key) && options.repairUsageLedger) await options.repairUsageLedger(location as CompactionLedgerLocation, usage) }
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
                    try { await options.repairFinalRequestContextLedger(location as CompactionLedgerLocation, finalContext) }
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
              try { await options.repairToolCallLedger?.(location as CompactionLedgerLocation, { ...toolCall, turnId: event.turnId, stepId: ledger.stepId }) }
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
            } catch (error) {
              blockedSessionLedgers.add(key)
              try { options.onToolLedgerRepairError?.(error, invocationId, payload.toolCallId) }
              catch { /* Diagnostics must not discard the canonical repair envelope. */ }
            }
          }
        }
      }
      if (state && state.state !== 'interrupted') continue
      if (state?.state === 'interrupted' && options.repairCompaction) {
        for (const event of snapshot.events) {
          if (event.kind !== 'transcript-compacted') continue
          const ledger = (event.payload as { sessionLedger?: unknown } | undefined)?.sessionLedger as Partial<CanonicalCompactionLedger> | undefined
          const location = ledger?.location
          const start = ledger?.start
          const summary = ledger?.summary
          if (!location || typeof location.workDir !== 'string' || typeof location.sessionId !== 'string' || !Number.isFinite(location.createdAt) || !start || !summary) continue
          if (blockedSessionLedgers.has(ledgerKey(location as CompactionLedgerLocation))) continue
          const compactionId = typeof summary.compactionId === 'string' ? summary.compactionId : event.eventId
          try { await options.repairCompaction(location as CompactionLedgerLocation, start, summary) }
          catch (error) {
            try { options.onCompactionRepairError?.(error, invocationId, compactionId) }
            catch { /* A diagnostic sink must not abort recovery or discard the retryable canonical repair record. */ }
          }
        }
      }
      if (snapshot.events.length > 0 && snapshot.events.at(-1)?.kind === 'tool-call-finished') {
        const lastEvent = snapshot.events.at(-1)!
        state = { invocationId, state: 'interrupted', lastEventId: lastEvent.eventId }
      }
      if (state?.state !== 'interrupted') continue
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
          try { await options.repairInvocationTerminal(recoveryLocation, terminal) }
          catch (error) {
            try { options.onInvocationTerminalRepairError?.(error, invocationId, lastEvent.turnId) }
            catch { /* Keep the canonical terminal sidecar for retry on the next startup. */ }
          }
        }
        snapshot = await this.read(invocationId)
        state = rebuildInvocationStates(snapshot).get(invocationId)
      }
      if (state?.state === 'interrupted') recovered.push(state)
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
