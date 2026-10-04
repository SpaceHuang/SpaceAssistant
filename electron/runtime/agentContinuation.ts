import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { rebuildClaudeMessagesFromHistory } from './canonicalHistory'
import { runInTransaction } from '../database/transaction'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { toCanonicalModelMessages } from './canonicalHistory'
import { mirrorCanonicalContextMessages } from './sqliteAgentHistory'

export type AgentContinuationRecord = Readonly<{
  continuationId: string
  sourceInvocationId: string
  sourceTurnId: string
  checkpointSequence: number
  checkpointSha256: string
  requestIdempotencyKey: string
  createdBy: string
  frozenConfig: Record<string, unknown>
  targetInvocationId: string
  targetTurnId: string
  targetStartToken: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'
  transcript: ReturnType<typeof rebuildClaudeMessagesFromHistory>
}>

export class AgentContinuationRejectedError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AgentContinuationRejectedError' }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex') }

export function validateContinuationCheckpoint(snapshot: HistorySnapshot): Readonly<{ checkpointSequence: number; checkpointSha256: string; transcript: ReturnType<typeof rebuildClaudeMessagesFromHistory>; requiredUserMessage: Readonly<{ id: string; message: Record<string, unknown> }> }> {
  const events = snapshot.events
  const terminal = events.at(-1)
  if (!terminal || !['invocation-completed', 'invocation-failed'].includes(terminal.kind)) throw new AgentContinuationRejectedError('SOURCE_INVOCATION_NOT_RECOVERABLE')
  if (events.some(({ kind }) => kind === 'invocation-interrupted')) throw new AgentContinuationRejectedError('CANCELLED_OR_INTERRUPTED_NOT_RECOVERABLE')
  const identity = events[0]
  if (!identity || events.some((event) => event.invocationId !== snapshot.invocationId || event.turnId !== identity.turnId || event.schemaVersion !== snapshot.schemaVersion)) throw new AgentContinuationRejectedError('CHECKPOINT_IDENTITY_MISMATCH')
  const contextMarkers = events.filter((event) => event.kind === 'invocation-context-committed')
  const contextPayload = contextMarkers[0]?.payload && typeof contextMarkers[0].payload === 'object'
    ? contextMarkers[0].payload as Record<string, unknown> : undefined
  const requiredUser = contextPayload?.requiredUserMessage && typeof contextPayload.requiredUserMessage === 'object'
    ? contextPayload.requiredUserMessage as Record<string, unknown> : undefined
  if (contextMarkers.length !== 1 || contextMarkers[0]?.sequence !== 1 || typeof requiredUser?.id !== 'string' ||
    !requiredUser.message || typeof requiredUser.message !== 'object' || Array.isArray(requiredUser.message) ||
    (requiredUser.message as Record<string, unknown>).role !== 'user') {
    throw new AgentContinuationRejectedError('CHECKPOINT_REQUIRED_USER_MISSING')
  }
  const terminalPayload = terminal.payload && typeof terminal.payload === 'object' ? terminal.payload as Record<string, unknown> : {}
  if (terminalPayload.status === 'denied' || terminalPayload.reason === 'POLICY_DENY' || terminalPayload.reason === 'CONFIRMATION_DENIED') throw new AgentContinuationRejectedError('SAFETY_REJECTION_NOT_RECOVERABLE')
  const started = new Set<string>()
  const settled = new Set<string>()
  let pendingProposals = new Set<string>()
  let unsettledProposals = new Set<string>()
  let crossedResponseWithUnsettledTools = false
  const approvals = new Set<string>()
  const safetyRejectionReasons = new Set([
    'UNKNOWN_CAPABILITY', 'UNAUTHORIZED_CAPABILITY', 'MISSING_MATERIAL', 'RULES_FLOOR_VIOLATED',
    'POLICY_DENY', 'FACTS_CHANGED', 'STALE_AUTHORIZATION', 'SHELL_PRECHECK_DENY', 'FILE_AUTO_APPROVAL_DENY',
    'CONFIRMATION_DENIED'
  ])
  let latestResponse = -1
  for (const event of events) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
    if (event.kind === 'model-response-committed') {
      if (unsettledProposals.size) crossedResponseWithUnsettledTools = true
      latestResponse = event.sequence
      const message = payload.message as { toolCalls?: Array<{ id?: unknown }> } | undefined
      pendingProposals = new Set((message?.toolCalls ?? []).flatMap((call) => typeof call.id === 'string' ? [call.id] : []))
      unsettledProposals = new Set(pendingProposals)
    }
    if (event.kind === 'tool-call-started' && typeof payload.toolCallId === 'string') started.add(payload.toolCallId)
    if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && typeof payload.toolCallId === 'string') {
      if (!pendingProposals.has(payload.toolCallId) || settled.has(payload.toolCallId)) throw new AgentContinuationRejectedError('CHECKPOINT_TOOL_PAIR_CONFLICT')
      settled.add(payload.toolCallId)
      unsettledProposals.delete(payload.toolCallId)
    }
    if (event.kind === 'approval-waiting' && typeof payload.toolCallId === 'string') approvals.add(payload.toolCallId)
    if (event.kind === 'approval-resolved' && typeof payload.toolCallId === 'string') {
      approvals.delete(payload.toolCallId)
      if (payload.approved === false && (payload.outcome === 'denied' || payload.outcome === 'cancelled')) {
        throw new AgentContinuationRejectedError('SAFETY_REJECTION_NOT_RECOVERABLE')
      }
    }
    if (event.kind === 'tool-call-not-dispatched' && typeof payload.reason === 'string' && safetyRejectionReasons.has(payload.reason)) {
      throw new AgentContinuationRejectedError('SAFETY_REJECTION_NOT_RECOVERABLE')
    }
  }
  for (const toolCallId of started) if (!settled.has(toolCallId)) throw new AgentContinuationRejectedError('UNKNOWN_SIDE_EFFECT')
  if (crossedResponseWithUnsettledTools) throw new AgentContinuationRejectedError('CHECKPOINT_TOOL_PAIR_CONFLICT')
  if (approvals.size) throw new AgentContinuationRejectedError('UNRESOLVED_APPROVAL')
  if (unsettledProposals.size) throw new AgentContinuationRejectedError('CHECKPOINT_HAS_UNSETTLED_TOOL_CALL')
  if (latestResponse < 0) throw new AgentContinuationRejectedError('CHECKPOINT_RESPONSE_MISSING')
  const checkpointEvents = events.filter((event) => event.kind !== 'invocation-completed' && event.kind !== 'invocation-failed')
  let transcript: ReturnType<typeof rebuildClaudeMessagesFromHistory>
  try {
    transcript = rebuildClaudeMessagesFromHistory(checkpointEvents)
  } catch (error) {
    if (contextPayload?.requiredUserMessage) throw new AgentContinuationRejectedError('CHECKPOINT_REQUIRED_USER_MISMATCH')
    throw error
  }
  const transcriptRequiredUser = transcript.find((message) => message.role === 'user' && message.id === requiredUser.id)
  if (!transcriptRequiredUser) {
    throw new AgentContinuationRejectedError('CHECKPOINT_REQUIRED_USER_MISSING')
  }
  try {
    const [transcriptCanonical] = toCanonicalModelMessages([transcriptRequiredUser])
    const requiredCanonical = {
      ...(requiredUser.message as Record<string, unknown>),
      id: requiredUser.id
    }
    if (stableJson(transcriptCanonical) !== stableJson(requiredCanonical)) {
      throw new AgentContinuationRejectedError('CHECKPOINT_REQUIRED_USER_MISMATCH')
    }
  } catch (error) {
    if (error instanceof AgentContinuationRejectedError) throw error
    throw new AgentContinuationRejectedError('CHECKPOINT_REQUIRED_USER_MISMATCH')
  }
  return { checkpointSequence: checkpointEvents.at(-1)?.sequence ?? latestResponse, checkpointSha256: sha256(checkpointEvents), transcript, requiredUserMessage: requiredUser as { id: string; message: Record<string, unknown> } }
}

type ContinuationRow = {
  continuation_id: string; source_invocation_id: string; source_turn_id: string; checkpoint_sequence: number; checkpoint_sha256: string
  request_idempotency_key: string; created_by: string; frozen_config_json: string; target_invocation_id: string; target_turn_id: string; target_start_token: string; status: AgentContinuationRecord['status']
  frozen_config_sha256: string
}

function rowToRecord(row: ContinuationRow, transcript: AgentContinuationRecord['transcript']): AgentContinuationRecord {
  return { continuationId: row.continuation_id, sourceInvocationId: row.source_invocation_id, sourceTurnId: row.source_turn_id,
    checkpointSequence: row.checkpoint_sequence, checkpointSha256: row.checkpoint_sha256, requestIdempotencyKey: row.request_idempotency_key,
    createdBy: row.created_by, frozenConfig: JSON.parse(row.frozen_config_json), targetInvocationId: row.target_invocation_id,
    targetTurnId: row.target_turn_id, targetStartToken: row.target_start_token, status: row.status, transcript }
}

function continuationContextMessages(transcript: ReturnType<typeof rebuildClaudeMessagesFromHistory>) {
  const messages = toCanonicalModelMessages(transcript)
  const lastIndexById = new Map<string, number>()
  messages.forEach((message, index) => { if (message.role === 'assistant' && message.id) lastIndexById.set(message.id, index) })
  return messages.map((message, index) => message.role === 'assistant' && message.id && lastIndexById.get(message.id) !== index
    ? (({ id: _id, ...withoutId }) => withoutId)(message)
    : message)
}

export function createOrGetAgentContinuation(input: {
  conn: DatabaseSync; snapshot: HistorySnapshot; sessionId: string; requestIdempotencyKey: string; createdBy: string
  frozenConfig: Record<string, unknown>; newId?: () => string; now?: () => number
}): AgentContinuationRecord {
  const key = input.requestIdempotencyKey.trim()
  if (!key || !input.createdBy.trim() || !input.sessionId.trim()) throw new AgentContinuationRejectedError('CONTINUATION_IDENTITY_REQUIRED')
  const checkpoint = validateContinuationCheckpoint(input.snapshot)
  const frozenConfigJson = JSON.stringify(input.frozenConfig)
  const newId = input.newId ?? randomUUID
  const now = (input.now ?? Date.now)()
  return runInTransaction(input.conn, () => {
    const byKey = input.conn.prepare('SELECT * FROM agent_continuations WHERE request_idempotency_key=?').get(key) as ContinuationRow | undefined
    if (byKey) {
      if (byKey.created_by !== input.createdBy || byKey.source_invocation_id !== input.snapshot.invocationId || byKey.checkpoint_sequence !== checkpoint.checkpointSequence || byKey.checkpoint_sha256 !== checkpoint.checkpointSha256 || byKey.frozen_config_sha256 !== sha256(input.frozenConfig)) throw new AgentContinuationRejectedError('CONTINUATION_IDEMPOTENCY_CONFLICT')
      return rowToRecord(byKey, checkpoint.transcript)
    }
    const byCheckpoint = input.conn.prepare('SELECT * FROM agent_continuations WHERE source_invocation_id=? AND checkpoint_sequence=?').get(input.snapshot.invocationId, checkpoint.checkpointSequence) as ContinuationRow | undefined
    if (byCheckpoint) {
      if (byCheckpoint.status !== 'interrupted' || byCheckpoint.frozen_config_sha256 !== sha256(input.frozenConfig)) throw new AgentContinuationRejectedError('CONTINUATION_ALREADY_CLAIMED')
      const priorEvents = input.conn.prepare("SELECT kind FROM agent_history_events WHERE invocation_id=? AND kind='tool-call-started' LIMIT 1").get(byCheckpoint.target_invocation_id)
      if (priorEvents) throw new AgentContinuationRejectedError('CONTINUATION_ALREADY_CLAIMED')
      // Explicit user retry after startup recovery: rotate the target identity so a terminal Turn
      // and provider history from the interrupted attempt can never be resumed or replayed.
      const retry = {
        ...byCheckpoint,
        request_idempotency_key: key,
        target_invocation_id: newId(),
        target_turn_id: newId(),
        target_start_token: newId(),
        status: 'pending' as const
      }
      input.conn.prepare("UPDATE agent_continuations SET request_idempotency_key=?,target_invocation_id=?,target_turn_id=?,target_start_token=?,status='pending',updated_at=? WHERE continuation_id=? AND status='interrupted'")
        .run(key, retry.target_invocation_id, retry.target_turn_id, retry.target_start_token, now, retry.continuation_id)
      const contextEvent = {
        invocationId: retry.target_invocation_id, turnId: retry.target_turn_id, sequence: 1, schemaVersion: input.snapshot.schemaVersion,
        eventId: `${retry.continuation_id}:context:${retry.target_invocation_id}`, idempotencyKey: `${retry.continuation_id}:context:${retry.target_invocation_id}`,
        kind: 'invocation-context-committed' as const,
        payload: {
          messages: continuationContextMessages(checkpoint.transcript),
          continuationSource: { continuationId: retry.continuation_id, invocationId: retry.source_invocation_id, turnId: retry.source_turn_id, checkpointSequence: retry.checkpoint_sequence, checkpointSha256: retry.checkpoint_sha256 },
          requiredUserMessage: structuredClone(checkpoint.requiredUserMessage)
        }
      }
      appendSqliteAgentHistoryBatchInTransaction(input.conn, [contextEvent], 0, { schemaVersion: input.snapshot.schemaVersion, sessionId: input.sessionId, now: () => now })
      mirrorCanonicalContextMessages(input.conn, input.sessionId, contextEvent.payload.messages)
      return rowToRecord(retry as ContinuationRow, checkpoint.transcript)
    }
    const record = { continuation_id: newId(), source_invocation_id: input.snapshot.invocationId, source_turn_id: input.snapshot.events[0]?.turnId ?? input.snapshot.invocationId,
      checkpoint_sequence: checkpoint.checkpointSequence, checkpoint_sha256: checkpoint.checkpointSha256, request_idempotency_key: key, created_by: input.createdBy,
      frozen_config_json: frozenConfigJson, frozen_config_sha256: sha256(input.frozenConfig), target_invocation_id: newId(), target_turn_id: newId(), target_start_token: newId(), status: 'pending' as const }
    input.conn.prepare(`INSERT INTO agent_continuations(continuation_id,source_invocation_id,source_turn_id,checkpoint_sequence,checkpoint_sha256,request_idempotency_key,created_by,frozen_config_json,frozen_config_sha256,target_invocation_id,target_turn_id,target_start_token,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.continuation_id, record.source_invocation_id, record.source_turn_id, record.checkpoint_sequence, record.checkpoint_sha256, record.request_idempotency_key, record.created_by, record.frozen_config_json, sha256(input.frozenConfig), record.target_invocation_id, record.target_turn_id, record.target_start_token, record.status, now, now)
    const requiredUserMessage = checkpoint.requiredUserMessage
    const contextEvent = {
      invocationId: record.target_invocation_id,
      turnId: record.target_turn_id,
      sequence: 1,
      schemaVersion: input.snapshot.schemaVersion,
      eventId: `${record.continuation_id}:context`,
      idempotencyKey: `${record.continuation_id}:context`,
      kind: 'invocation-context-committed' as const,
      payload: {
        messages: continuationContextMessages(checkpoint.transcript),
        continuationSource: {
          continuationId: record.continuation_id,
          invocationId: record.source_invocation_id,
          turnId: record.source_turn_id,
          checkpointSequence: record.checkpoint_sequence,
          checkpointSha256: record.checkpoint_sha256
        },
        requiredUserMessage: structuredClone(requiredUserMessage)
      }
    }
    appendSqliteAgentHistoryBatchInTransaction(input.conn, [contextEvent], 0, {
      schemaVersion: input.snapshot.schemaVersion,
      sessionId: input.sessionId,
      now: () => now
    })
    mirrorCanonicalContextMessages(input.conn, input.sessionId, contextEvent.payload.messages)
    return rowToRecord(record as ContinuationRow, checkpoint.transcript)
  })
}

export function claimAgentContinuation(conn: DatabaseSync, continuationId: string, revalidatedFrozenConfig: Record<string, unknown>, now = Date.now()): boolean {
  return runInTransaction(conn, () => {
    const row = conn.prepare('SELECT frozen_config_sha256 FROM agent_continuations WHERE continuation_id=? AND status=\'pending\'').get(continuationId) as { frozen_config_sha256: string } | undefined
    if (!row || row.frozen_config_sha256 !== sha256(revalidatedFrozenConfig)) return false
    return conn.prepare("UPDATE agent_continuations SET status='running',updated_at=? WHERE continuation_id=? AND status='pending'").run(now, continuationId).changes === 1
  })
}

export function setAgentContinuationStatus(conn: DatabaseSync, continuationId: string, status: Extract<AgentContinuationRecord['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'>, now = Date.now()): boolean {
  return conn.prepare("UPDATE agent_continuations SET status=?,updated_at=? WHERE continuation_id=? AND status='running'")
    .run(status, now, continuationId).changes === 1
}

export function setAgentContinuationStatusForTurn(conn: DatabaseSync, targetTurnId: string, status: Extract<AgentContinuationRecord['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'>, now = Date.now()): boolean {
  return conn.prepare("UPDATE agent_continuations SET status=?,updated_at=? WHERE target_turn_id=? AND status='running'")
    .run(status, now, targetTurnId).changes === 1
}

/** Startup reconciliation is deliberately terminal: an interrupted continuation is never replayed automatically. */
export function reconcileRunningAgentContinuations(conn: DatabaseSync, historyRecoverySucceeded: boolean, now = Date.now()): Readonly<{ interrupted: number; unknownSideEffect: number; settled: number }> {
  return runInTransaction(conn, () => {
    const rows = conn.prepare("SELECT continuation_id, target_invocation_id FROM agent_continuations WHERE status='running'").all() as Array<{ continuation_id: string; target_invocation_id: string }>
    let interrupted = 0
    let unknownSideEffect = 0
    let settled = 0
    const eventsQuery = conn.prepare('SELECT kind, payload_json FROM agent_history_events WHERE invocation_id=? ORDER BY sequence ASC')
    const update = conn.prepare("UPDATE agent_continuations SET status=?, updated_at=? WHERE continuation_id=? AND status='running'")
    for (const row of rows) {
      let status: Extract<AgentContinuationRecord['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'> = 'interrupted'
      if (!historyRecoverySucceeded) status = 'unknown_side_effect'
      else {
        const events = eventsQuery.all(row.target_invocation_id) as Array<{ kind: string; payload_json: string }>
        const started = new Set<string>()
        const finished = new Set<string>()
        for (const event of events) {
          let payload: Record<string, unknown> = {}
          try { payload = JSON.parse(event.payload_json) as Record<string, unknown> } catch { status = 'unknown_side_effect'; break }
          if (event.kind === 'tool-call-started' && typeof payload.toolCallId === 'string') started.add(payload.toolCallId)
          if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && typeof payload.toolCallId === 'string') finished.add(payload.toolCallId)
        }
        if (status !== 'unknown_side_effect' && [...started].some((id) => !finished.has(id))) status = 'unknown_side_effect'
        const terminal = events.at(-1)
        if (status !== 'unknown_side_effect' && terminal) {
          let payload: Record<string, unknown> = {}
          try { payload = JSON.parse(terminal.payload_json) as Record<string, unknown> } catch { status = 'unknown_side_effect' }
          if (status !== 'unknown_side_effect') {
            if (terminal.kind === 'invocation-completed') status = 'completed'
            else if (terminal.kind === 'invocation-failed') status = 'failed'
            else if (terminal.kind === 'invocation-interrupted') status = payload.status === 'cancelled' ? 'cancelled' : 'interrupted'
          }
        }
      }
      if (update.run(status, now, row.continuation_id).changes !== 1) continue
      if (status === 'interrupted') interrupted++
      else if (status === 'unknown_side_effect') unknownSideEffect++
      else settled++
    }
    return { interrupted, unknownSideEffect, settled }
  })
}

export async function startAgentContinuation(input: {
  conn: DatabaseSync; snapshot: HistorySnapshot; sessionId: string; userMessageId: string; requestIdempotencyKey: string
  createdBy: string; frozenConfig: Record<string, unknown>; executionConfig: import('../../src/shared/assistantFactAggregator').TurnExecutionConfig
  continuationAcceptance?: { payloadSha256: string; rawText: string; attachments?: unknown[]; intentKind: 'exact-continue' | 'follow-up'; route: string }
  runtime: import('../turnRuntime').TurnRuntime; now?: () => number; newId?: () => string
}): Promise<{ accepted: true; started: boolean; continuation: AgentContinuationRecord; turn?: import('../../src/shared/turnCoordinator').TurnStarted }> {
  return runInTransaction(input.conn, () => {
    const checkpoint = validateContinuationCheckpoint(input.snapshot)
    if (checkpoint.requiredUserMessage.id !== input.userMessageId) throw new AgentContinuationRejectedError('CONTINUATION_SOURCE_USER_MISMATCH')
    const sourceTurnId = input.snapshot.events.at(-1)?.turnId
    const sourceAssistant = sourceTurnId ? input.conn.prepare('SELECT m.sequence FROM turns t JOIN messages m ON m.id=t.assistant_message_id WHERE t.session_id=? AND t.turn_id=?').get(input.sessionId, sourceTurnId) as { sequence?: number } | undefined : undefined
    if (sourceAssistant?.sequence == null) throw new AgentContinuationRejectedError('CONTINUATION_SOURCE_STALE')
    const newerAcceptedInput = input.conn.prepare("SELECT id FROM messages WHERE session_id=? AND role='user' AND sequence>? AND status IN ('sent','queued') ORDER BY sequence ASC LIMIT 1").get(input.sessionId, sourceAssistant.sequence)
    if (newerAcceptedInput) throw new AgentContinuationRejectedError('CONTINUATION_SOURCE_STALE')
    const continuation = createOrGetAgentContinuation({
      conn: input.conn, snapshot: input.snapshot, sessionId: input.sessionId,
      requestIdempotencyKey: input.requestIdempotencyKey, createdBy: input.createdBy,
      frozenConfig: input.frozenConfig, ...(input.newId ? { newId: input.newId } : {}), ...(input.now ? { now: input.now } : {})
    })
    if (input.continuationAcceptance) {
      const accepted = input.continuationAcceptance
      input.conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET route=excluded.route,source_invocation_id=excluded.source_invocation_id,source_turn_id=excluded.source_turn_id,source_sequence=excluded.source_sequence,target_id=excluded.target_id,status=excluded.status,updated_at=excluded.updated_at`)
        .run(input.requestIdempotencyKey, input.sessionId, accepted.payloadSha256, accepted.rawText, JSON.stringify(accepted.attachments ?? []), accepted.intentKind, accepted.route, continuation.sourceInvocationId, continuation.sourceTurnId, continuation.checkpointSequence, continuation.continuationId, 'starting_continuation', (input.now ?? Date.now)(), (input.now ?? Date.now)())
    }
    let turn: import('../../src/shared/turnCoordinator').TurnStarted | undefined
    let started = false
    let finalRecord = continuation
    if (continuation.status === 'pending') {
      const source = {
        continuationId: continuation.continuationId, invocationId: continuation.sourceInvocationId, sourceTurnId: continuation.sourceTurnId,
        checkpointSequence: continuation.checkpointSequence, checkpointSha256: continuation.checkpointSha256
      }
      const config = { ...input.executionConfig, continuationSource: source }
      turn = input.runtime.prepareContinuation({
        requestId: continuation.targetInvocationId, sessionId: input.sessionId, userMessageId: input.userMessageId,
        turnId: continuation.targetTurnId, startToken: continuation.targetStartToken, config
      })
      if (claimAgentContinuation(input.conn, continuation.continuationId, input.frozenConfig, (input.now ?? Date.now)())) {
        started = true
        finalRecord = { ...continuation, status: 'running' }
      } else {
        const status = input.conn.prepare('SELECT status FROM agent_continuations WHERE continuation_id=?').get(continuation.continuationId) as { status: AgentContinuationRecord['status'] } | undefined
        if (!status) throw new AgentContinuationRejectedError('CONTINUATION_RECORD_MISSING')
        finalRecord = { ...continuation, status: status.status }
      }
    }
    if (input.continuationAcceptance) input.conn.prepare("UPDATE continuation_intents SET status='accepted_continuation',target_id=?,updated_at=? WHERE request_id=?")
      .run(finalRecord.continuationId, (input.now ?? Date.now)(), input.requestIdempotencyKey)
    return { accepted: true as const, started, continuation: finalRecord, ...(turn ? { turn } : {}) }
  })
}
