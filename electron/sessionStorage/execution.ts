import type { AppDatabase, PersistedTurn } from '../database'
import { enqueueQueuedUserMessage, getDbConnection, getPersistedTurn, getTurnByRequestId, hasActiveTurn, setPersistedTurnExecutionConfig, failConfiguringTurn } from '../database'
import { createHash } from 'node:crypto'
import { appendMessage } from '../database/operations'
import type { Message } from '../../src/shared/domainTypes'
import { createAcceptedTurn, type AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { TurnExecutionConfig } from '../../src/shared/assistantFactAggregator'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { readSessionTranscript } from '../database/sessionTranscript'
import { cancelQueuedSessionExecution, claimSessionExecution, markSessionExecutionStarted, markSessionExecutionUncertain, releaseSessionExecution } from '../database/sessionTranscript'
import { acceptTurnContext, readAcceptedTurn } from '../database/acceptedTurnStorage'
import { runInTransaction } from '../database/transaction'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { getProjectedTurnContext } from '../runtime/sessionTranscriptProjection'
import { readCanonicalApiContextIfEligible } from './certification'
import { shadowAcceptedTurnContext } from '../runtime/sessionStorageShadow'
import type { ContinuationIntentAcceptance, EnqueueResult, PreparedIdentity, SessionContinuationRecord, SessionExecutionStore, SessionHistoryPort } from './contracts'
import type { SessionQueries } from './contracts'
import type { HistoryPort } from '../../packages/agent-sdk/src/history'
import { createContinuationStartedSystemMessage } from '../../src/shared/skillHintRecords'
import { rebuildClaudeMessagesFromHistory, toCanonicalModelMessages } from '../runtime/canonicalHistory'
import { createTurnCoordinatorStorage } from './coordinator'
import { claimAgentContinuation, createOrGetAgentContinuation, setAgentContinuationStatus, setAgentContinuationStatusForTurn, startAgentContinuation, validateContinuationCheckpoint } from '../runtime/agentContinuation'

/** Narrow SQLite execution adapter for prepared acceptance and validated context loading. */
export function createSessionExecutionStore(db: AppDatabase, queries?: SessionQueries, options: { getTurnRuntime?: () => import('../turnRuntime').TurnRuntime } = {}): SessionExecutionStore {
  const conn = getDbConnection(db)
  const coordinator = createTurnCoordinatorStorage(db)
  const execution: SessionExecutionStore = {
    coordinator,
    continuations: Object.freeze({
      createOrGet: ({ sessionId, sourceInvocationId, requestIdempotencyKey, createdBy, frozenConfig }: Parameters<SessionExecutionStore['continuations']['createOrGet']>[0]) => {
        if (!sessionId.trim() || !sourceInvocationId.trim()) throw new Error('CONTINUATION_IDENTITY_REQUIRED')
        const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
        const snapshot = history.readSync(sourceInvocationId)
        return createOrGetAgentContinuation({ conn, snapshot, sessionId, requestIdempotencyKey, createdBy, frozenConfig })
      },
      claim: ({ continuationId, revalidatedFrozenConfig }: Parameters<SessionExecutionStore['continuations']['claim']>[0]) => claimAgentContinuation(conn, continuationId, revalidatedFrozenConfig),
      settle: ({ continuationId, status }: Parameters<SessionExecutionStore['continuations']['settle']>[0]) => setAgentContinuationStatus(conn, continuationId, status),
      settleForTurn: ({ targetTurnId, status }: Parameters<SessionExecutionStore['continuations']['settleForTurn']>[0]) => setAgentContinuationStatusForTurn(conn, targetTurnId, status)
    }),
    continuationLaunch: Object.freeze({
      prepareAndClaim: async (input: Parameters<SessionExecutionStore['continuationLaunch']['prepareAndClaim']>[0]) => {
        if (input.source.sessionId !== input.payload.sessionId || input.source.invocationId.trim() === '' || input.source.turnId.trim() === '') throw new Error('CONTINUATION_SOURCE_IDENTITY_REQUIRED')
        const runtime = options.getTurnRuntime?.()
        if (!runtime) throw new Error('CONTINUATION_RUNTIME_REQUIRED')
        const history = new SqliteAgentHistory(conn, 1, Date.now, input.payload.sessionId)
        const snapshot = history.readSync(input.source.invocationId)
        if (snapshot.version !== input.source.expectedHistoryVersion) throw new Error('CONTINUATION_SOURCE_STALE')
        const checkpoint = validateContinuationCheckpoint(snapshot)
        if (snapshot.events[0]?.turnId !== input.source.turnId || checkpoint.checkpointSequence !== input.source.checkpointSequence) throw new Error('CONTINUATION_SOURCE_STALE')
        return startAgentContinuation({
          conn, snapshot, sessionId: input.payload.sessionId, userMessageId: checkpoint.requiredUserMessage.id,
          requestIdempotencyKey: input.payload.requestId, createdBy: input.createdBy,
          frozenConfig: input.frozenConfig, executionConfig: input.executionConfig, runtime,
          continuationAcceptance: {
            payloadSha256: input.acceptance.payloadSha256, rawText: input.acceptance.rawText,
            attachments: input.acceptance.attachments, intentKind: input.acceptance.intentKind, route: input.acceptance.route
          }
        })
      }
    }),
    prepareTurn: (input) => coordinator.prepareAtomic(input),
    claimQueuedTurn: (input) => coordinator.claimQueuedAtomic(input),
    historyFor: ({ sessionId }) => createSessionHistoryPort(db, sessionId),
    acceptPrepared: ({ prepared, lane, config }: { prepared: PreparedIdentity; lane: NonNullable<TurnExecutionConfig['lane']>; config: TurnExecutionConfig }): AcceptedTurn => {
      if (!prepared.userMessage?.id) throw new Error('TURN_USER_MESSAGE_MISSING')
      const transcript = readSessionTranscript(db, prepared.sessionId)
      if (transcript.status !== 'ready') throw new Error('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')
      return acceptTurnContext(db, createAcceptedTurn({
        turnId: prepared.turnId, requestId: prepared.requestId, sessionId: prepared.sessionId,
        lane, startToken: prepared.startToken, currentUserMessageId: prepared.userMessage.id,
        transcriptVersion: transcript.version, config: { ...config, lane }
      }))
    },
    readTurn: ({ sessionId, turnId }) => {
      const turn = getPersistedTurn(db, turnId)
      return turn?.sessionId === sessionId ? turn : undefined
    },
    readTurnByRequest: ({ sessionId, requestId }) => getTurnByRequestId(db, sessionId, requestId),
    hasActiveTurn: (sessionId) => hasActiveTurn(db, sessionId),
    readAccepted: ({ sessionId, requestId }) => readAcceptedTurn(db, sessionId, requestId),
    readTranscriptState: (sessionId) => {
      const { messages: _messages, ...state } = readSessionTranscript(db, sessionId)
      return state
    },
    readHostedTranscript: (sessionId) => readSessionTranscript(db, sessionId),
    loadAcceptedContinuationTranscript: ({ sessionId, turnId }) => {
      const turn = getPersistedTurnInSession(db, sessionId, turnId)
      const continuationSource = turn.executionConfig?.continuationSource
      if (!continuationSource) return undefined
      if (!turn.userMessageId) throw new Error('TURN_USER_MESSAGE_MISSING')
      const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId).readSync(turn.requestId)
      const contextMarkers = history.events.filter((event) => event.kind === 'invocation-context-committed')
      const marker = contextMarkers[0]
      const payload = marker?.payload && typeof marker.payload === 'object' ? marker.payload as Record<string, unknown> : undefined
      const source = payload?.continuationSource && typeof payload.continuationSource === 'object'
        ? payload.continuationSource as Record<string, unknown> : undefined
      if (contextMarkers.length !== 1 || marker?.sequence !== 1 || marker.turnId !== turnId ||
        source?.continuationId !== continuationSource.continuationId ||
        source?.invocationId !== continuationSource.invocationId ||
        source?.turnId !== continuationSource.sourceTurnId ||
        source?.checkpointSequence !== continuationSource.checkpointSequence ||
        source?.checkpointSha256 !== continuationSource.checkpointSha256) {
        throw new Error('TURN_CONTINUATION_HISTORY_MISMATCH')
      }
      const requiredUser = payload?.requiredUserMessage && typeof payload.requiredUserMessage === 'object'
        ? payload.requiredUserMessage as { id?: unknown; message?: unknown } : undefined
      if (requiredUser?.id !== turn.userMessageId || !requiredUser.message || typeof requiredUser.message !== 'object') {
        throw new Error('TURN_CONTINUATION_REQUIRED_USER_MISSING')
      }
      const transcript = rebuildClaudeMessagesFromHistory(history.events)
      const requiredUserIndex = transcript.findIndex((message) => {
        if (message.role !== 'user') return false
        const [candidate] = toCanonicalModelMessages([message])
        if (!candidate || candidate.role !== 'user' || (candidate.id !== undefined && candidate.id !== turn.userMessageId)) return false
        const { id: _candidateId, ...candidateBody } = candidate
        const { id: _requiredId, ...requiredBody } = requiredUser.message as Record<string, unknown>
        return JSON.stringify(candidateBody) === JSON.stringify(requiredBody)
      })
      if (requiredUserIndex < 0) throw new Error('TURN_CONTINUATION_REQUIRED_USER_MISSING')
      transcript[requiredUserIndex] = { ...transcript[requiredUserIndex]!, id: turn.userMessageId }
      return transcript
    },
    claimExecution: (input) => claimSessionExecution(db, input),
    markExecutionStarted: (input) => markSessionExecutionStarted(db, input),
    releaseExecution: (input) => releaseSessionExecution(db, input),
    cancelQueuedExecution: (input) => cancelQueuedSessionExecution(db, input),
    markExecutionUncertain: (input) => markSessionExecutionUncertain(db, input),
    commitExecutionConfig: ({ ref, config, intentFingerprint, fence }) => {
      if (!queries) return false
      const snapshot = queries.readSelectionSnapshot(ref.sessionId, fence)
      if (!snapshot) return false
      return setPersistedTurnExecutionConfig(db, ref.turnId, config, intentFingerprint, snapshot)
    },
    failConfiguring: ({ ref, version, error }) => {
      const turn = getPersistedTurn(db, ref.turnId)
      if (turn?.sessionId !== ref.sessionId) return false
      return failConfiguringTurn(db, ref.turnId, version, error)
    },
    enqueueContinuation: ({ enqueue, intent }: { enqueue: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }; intent: ContinuationIntentAcceptance }): EnqueueResult => {
      if (!enqueue.sessionId.trim() || !enqueue.requestId.trim()) throw new Error('CONTINUATION_IDENTITY_REQUIRED')
      if (intent.rawText !== enqueue.content || intent.attachments?.length && JSON.stringify(intent.attachments) !== JSON.stringify(enqueue.attachments ?? [])) throw new Error('CONTINUATION_ENQUEUE_PAYLOAD_MISMATCH')
      if (intent.source && (!intent.source.invocationId.trim() || !intent.source.turnId.trim())) throw new Error('CONTINUATION_SOURCE_IDENTITY_REQUIRED')
      if (!/^[a-f0-9]{64}$/.test(intent.payloadSha256)) throw new Error('CONTINUATION_PAYLOAD_FINGERPRINT_INVALID')
      return runInTransaction(conn, () => {
        const prior = conn.prepare('SELECT session_id,payload_sha256,status FROM continuation_intents WHERE request_id=?').get(enqueue.requestId) as { session_id: string; payload_sha256: string; status: string } | undefined
        if (prior && (prior.session_id !== enqueue.sessionId || prior.payload_sha256 !== intent.payloadSha256)) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
        const queued = enqueueQueuedUserMessage(db, enqueue)
        if (prior && !['needs_source_selection', 'ordinary_fallback_pending', 'rejected_retryable', 'commit_uncertain'].includes(prior.status)) return queued
        const now = Date.now()
        const source = intent.source
        conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,continuation_context_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET route=excluded.route,source_invocation_id=excluded.source_invocation_id,source_turn_id=excluded.source_turn_id,source_sequence=excluded.source_sequence,target_id=excluded.target_id,status=excluded.status,continuation_context_json=excluded.continuation_context_json,updated_at=excluded.updated_at`)
          .run(enqueue.requestId, enqueue.sessionId, intent.payloadSha256, intent.rawText, JSON.stringify(intent.attachments ?? []), intent.intentKind, intent.route,
            source?.invocationId ?? null, source?.turnId ?? null, source?.sequence ?? null, queued.persisted.message.id, 'queued', intent.context ? JSON.stringify(intent.context) : null, now, now)
        return queued
      })
    },
    readContinuationIntent: ({ requestId, sessionId }) => {
      const row = conn.prepare(`SELECT request_id,session_id,payload_sha256,route,target_id,status,rejection_reason
        FROM continuation_intents WHERE request_id=? AND session_id=?`).get(requestId, sessionId) as {
          request_id: string; session_id: string; payload_sha256: string; route: string; target_id: string | null; status: string; rejection_reason: string | null
        } | undefined
      if (!row) return undefined
      return {
        requestId: row.request_id,
        sessionId: row.session_id,
        payloadSha256: row.payload_sha256,
        route: row.route,
        ...(row.target_id ? { targetId: row.target_id } : {}),
        status: row.status,
        ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {})
      }
    },
    enqueueAndRecordContinuation: ({ enqueue, intent }) => execution.enqueueContinuation({ enqueue, intent }),
    requireContinuationSourceSelection: (input) => writeContinuationIntentState(conn, input, { route: 'needs-source-selection', status: 'needs_source_selection' }),
    selectOrdinaryContinuation: (input) => writeContinuationIntentState(conn, input, { route: 'ordinary-selected', status: 'ordinary_fallback_pending' }),
    rejectContinuationIntent: (input) => writeContinuationIntentState(conn, input, { route: 'ordinary', status: input.status }, input.reason),
    beginContinuationIntent: (input) => runInTransaction(conn, () => {
      const prior = execution.readContinuationIntent({ requestId: input.requestId, sessionId: input.sessionId })
      if (prior) {
        if (prior.payloadSha256 !== input.payloadSha256) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
        if (prior.targetId || ['accepted_turn', 'accepted_continuation'].includes(prior.status)) return prior
      }
      const now = Date.now()
      conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET route='continuation',source_invocation_id=excluded.source_invocation_id,source_turn_id=excluded.source_turn_id,source_sequence=excluded.source_sequence,status='starting_continuation',updated_at=excluded.updated_at`)
        .run(input.requestId, input.sessionId, input.payloadSha256, input.text, JSON.stringify(input.attachments ?? []), input.intentKind, 'continuation', input.source.invocationId, input.source.turnId, input.source.checkpointSequence, 'starting_continuation', now, now)
      return execution.readContinuationIntent({ requestId: input.requestId, sessionId: input.sessionId })!
    }),
    finalizeContinuationAcceptance: ({ requestId, sessionId, payloadSha256, continuationId }) => runInTransaction(conn, () => {
      const receipt = execution.readContinuationIntent({ requestId, sessionId })
      if (!receipt || receipt.payloadSha256 !== payloadSha256) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
      if (receipt.targetId && receipt.targetId !== continuationId) throw new Error('CONTINUATION_INTENT_TARGET_CONFLICT')
      if (!['starting_continuation', 'accepted_continuation'].includes(receipt.status)) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      const continuation = conn.prepare(`SELECT t.session_id,ac.source_invocation_id,ac.source_turn_id,ac.checkpoint_sequence,ac.request_idempotency_key,ac.status
        FROM agent_continuations ac JOIN turns t ON t.turn_id=ac.source_turn_id WHERE ac.continuation_id=?`).get(continuationId) as {
          session_id?: string; source_invocation_id: string; source_turn_id: string; checkpoint_sequence: number; request_idempotency_key: string; status: string
        } | undefined
      if (!continuation || continuation.request_idempotency_key !== requestId || continuation.session_id !== sessionId) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      const sourceMatches = conn.prepare(`SELECT 1 FROM continuation_intents WHERE request_id=? AND session_id=? AND source_invocation_id=? AND source_turn_id=? AND source_sequence=?`)
        .get(requestId, sessionId, continuation.source_invocation_id, continuation.source_turn_id, continuation.checkpoint_sequence)
      if (!sourceMatches) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      const statusMessage = execution.ensureContinuationStatusMessage({ requestId, sessionId })
      conn.prepare("UPDATE continuation_intents SET route='continuation',target_id=?,status='accepted_continuation',updated_at=? WHERE request_id=? AND session_id=?")
        .run(continuationId, Date.now(), requestId, sessionId)
      return { receipt: execution.readContinuationIntent({ requestId, sessionId })!, statusMessage }
    }),
    bindStartedContinuationTurn: (input) => runInTransaction(conn, () => {
      const existing = conn.prepare('SELECT session_id,payload_sha256,target_id,status FROM continuation_intents WHERE request_id=?')
        .get(input.requestId) as { session_id: string; payload_sha256: string; target_id: string | null; status: string } | undefined
      if (existing?.target_id && existing.target_id !== input.turnId) throw new Error('CONTINUATION_INTENT_TARGET_CONFLICT')
      const turn = getTurnByRequestId(db, input.sessionId, input.requestId)
      if (!turn || turn.turnId !== input.turnId) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      if (!existing || existing.session_id !== input.sessionId || existing.payload_sha256 !== input.payloadSha256) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
      if (existing.target_id && existing.target_id !== input.turnId) throw new Error('CONTINUATION_INTENT_TARGET_CONFLICT')
      if (!['ordinary_fallback_pending', 'needs_source_selection', 'starting_continuation', 'accepted_turn'].includes(existing.status)) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      conn.prepare(`UPDATE continuation_intents SET route=?,source_invocation_id=?,source_turn_id=?,source_sequence=?,target_id=?,status='accepted_turn',updated_at=? WHERE request_id=?`)
        .run(input.route, input.source?.invocationId ?? null, input.source?.turnId ?? null, input.source?.sequence ?? null, input.turnId, Date.now(), input.requestId)
      if (input.retrySource) conn.prepare('UPDATE turns SET retry_of_message_id=?,retry_of_invocation_id=? WHERE turn_id=? AND session_id=?')
        .run(input.retrySource.assistantMessageId, input.retrySource.invocationId ?? null, input.turnId, input.sessionId)
      return execution.readContinuationIntent({ requestId: input.requestId, sessionId: input.sessionId })!
    }),
    bindExactContinueTurn: (input) => runInTransaction(conn, () => {
      const existing = conn.prepare('SELECT session_id,payload_sha256,target_id,status FROM continuation_intents WHERE request_id=?')
        .get(input.requestId) as { session_id: string; payload_sha256: string; target_id: string | null; status: string } | undefined
      if (!existing || existing.session_id !== input.sessionId || existing.payload_sha256 !== input.payloadSha256) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
      if (existing.target_id && existing.target_id !== input.turnId) throw new Error('CONTINUATION_INTENT_TARGET_CONFLICT')
      const turn = getTurnByRequestId(db, input.sessionId, input.requestId)
      if (!turn || turn.turnId !== input.turnId) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      if (!['accepted_turn', 'accepted_continuation'].includes(existing.status)) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      conn.prepare(`UPDATE continuation_intents SET route='continuation',target_id=?,status='accepted_continuation',updated_at=? WHERE request_id=?`)
        .run(input.turnId, Date.now(), input.requestId)
      return execution.readContinuationIntent({ requestId: input.requestId, sessionId: input.sessionId })!
    }),
    repairPreparedContinuationAcceptance: (input) => runInTransaction(conn, () => {
      const turn = getTurnByRequestId(db, input.sessionId, input.requestId)
      if (!turn || turn.turnId !== input.turnId || !turn.userMessageId) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
      const user = queries?.readMessage({ sessionId: input.sessionId, messageId: turn.userMessageId })
      if (!user || input.text !== user.content || JSON.stringify(input.attachments ?? []) !== JSON.stringify(user.attachments ?? [])) throw new Error('CONTINUATION_ENQUEUE_PAYLOAD_MISMATCH')
      const prior = execution.readContinuationIntent({ requestId: input.requestId, sessionId: input.sessionId })
      if (prior) {
        if (prior.payloadSha256 !== input.payloadSha256) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
        if (prior.targetId && prior.targetId !== input.turnId) throw new Error('CONTINUATION_INTENT_TARGET_CONFLICT')
        return prior
      }
      conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.requestId, input.sessionId, input.payloadSha256, input.text, JSON.stringify(input.attachments ?? []), input.intentKind,
          input.route, input.source?.invocationId ?? null, input.source?.turnId ?? null, input.source?.sequence ?? null,
          input.turnId, 'accepted_turn', Date.now(), Date.now())
      if (input.retrySource) conn.prepare('UPDATE turns SET retry_of_message_id=?,retry_of_invocation_id=? WHERE turn_id=? AND session_id=?')
        .run(input.retrySource.assistantMessageId, input.retrySource.invocationId ?? null, input.turnId, input.sessionId)
      return execution.readContinuationIntent({ requestId: input.requestId, sessionId: input.sessionId })!
    }),
    resolveContinuationAcceptance: ({ requestId, sessionId, payloadSha256 }) => {
      const receipt = execution.readContinuationIntent({ requestId, sessionId })
      if (!receipt) return { kind: 'absent' }
      if (receipt.payloadSha256 !== payloadSha256) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' }
      if (receipt.status === 'needs_source_selection') return { kind: 'selection-required', receipt }
      if (receipt.status === 'queued') {
        if (!receipt.targetId) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        const entry = queries?.readMessage({ sessionId, messageId: receipt.targetId })
        const sequence = queries?.readMessageSequence({ sessionId, messageId: receipt.targetId })
        if (!entry || sequence == null || entry.status !== 'queued') return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        return { kind: 'queued', receipt, message: { message: entry, sequence } }
      }
      if (receipt.status === 'accepted_turn') {
        if (!receipt.targetId) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        const turn = getTurnByRequestId(db, sessionId, requestId)
        if (!turn || turn.turnId !== receipt.targetId) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        const assistant = queries?.readMessage({ sessionId, messageId: turn.assistantMessageId })
        if (!assistant) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        return { kind: 'turn', receipt, turn, assistant }
      }
      if (receipt.status === 'accepted_continuation') {
        if (!receipt.targetId) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        const continuation = conn.prepare(`SELECT ac.continuation_id AS continuationId,ac.source_invocation_id AS sourceInvocationId,ac.source_turn_id AS sourceTurnId,ac.checkpoint_sequence AS checkpointSequence,ac.request_idempotency_key AS requestIdempotencyKey,ac.created_by AS createdBy,ac.frozen_config_json AS frozenConfigJson,ac.frozen_config_sha256 AS frozenConfigSha256,ac.target_invocation_id AS targetInvocationId,ac.target_turn_id AS targetTurnId,ac.target_start_token AS targetStartToken,ac.status,ac.created_at AS createdAt,ac.updated_at AS updatedAt,t.session_id AS sessionId
          FROM agent_continuations ac JOIN turns t ON t.turn_id=ac.source_turn_id WHERE ac.continuation_id=?`).get(receipt.targetId) as (SessionContinuationRecord & { sessionId: string }) | undefined
        if (!continuation || continuation.requestIdempotencyKey !== requestId || continuation.sessionId !== sessionId || receipt.route !== 'continuation') {
          const turn = getTurnByRequestId(db, sessionId, requestId)
          if (turn?.turnId === receipt.targetId && receipt.route === 'continuation') {
            const assistant = queries?.readMessage({ sessionId, messageId: turn.assistantMessageId })
            if (assistant) return { kind: 'turn', receipt, turn, assistant }
          }
          return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        }
        const source = conn.prepare('SELECT source_invocation_id,source_turn_id,source_sequence FROM continuation_intents WHERE request_id=? AND session_id=?').get(requestId, sessionId) as { source_invocation_id?: string; source_turn_id?: string; source_sequence?: number } | undefined
        if (receipt.route !== 'continuation' || continuation.sourceInvocationId !== source?.source_invocation_id || continuation.sourceTurnId !== source.source_turn_id || continuation.checkpointSequence !== source.source_sequence) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        const messageId = `continuation-status-${createHash('sha256').update(`${sessionId}\0${requestId}`).digest('hex')}`
        const sequence = queries?.readMessageSequence({ sessionId, messageId })
        const message = queries?.readMessage({ sessionId, messageId })
        if (sequence == null || !message) return { kind: 'unresolved', receipt, reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' }
        return { kind: 'continuation', receipt, continuation, message: { message, sequence } }
      }
      if (receipt.status === 'starting_continuation') {
        const continuation = conn.prepare(`SELECT ac.continuation_id AS continuationId,ac.source_invocation_id AS sourceInvocationId,ac.source_turn_id AS sourceTurnId,ac.checkpoint_sequence AS checkpointSequence,ac.request_idempotency_key AS requestIdempotencyKey,ac.created_by AS createdBy,ac.frozen_config_json AS frozenConfigJson,ac.frozen_config_sha256 AS frozenConfigSha256,ac.target_invocation_id AS targetInvocationId,ac.target_turn_id AS targetTurnId,ac.target_start_token AS targetStartToken,ac.status,ac.created_at AS createdAt,ac.updated_at AS updatedAt,t.session_id AS sessionId
          FROM agent_continuations ac JOIN turns t ON t.turn_id=ac.source_turn_id WHERE ac.request_idempotency_key=?`).get(requestId) as (SessionContinuationRecord & { sessionId: string }) | undefined
        const source = conn.prepare('SELECT source_invocation_id,source_turn_id,source_sequence FROM continuation_intents WHERE request_id=? AND session_id=?').get(requestId, sessionId) as { source_invocation_id?: string; source_turn_id?: string; source_sequence?: number } | undefined
        if (continuation && continuation.sessionId === sessionId && continuation.sourceInvocationId === source?.source_invocation_id && continuation.sourceTurnId === source.source_turn_id && continuation.checkpointSequence === source.source_sequence) return { kind: 'starting', receipt, continuation }
        return { kind: 'starting', receipt }
      }
      return { kind: 'unresolved', receipt, reason: receipt.rejectionReason ?? receipt.status }
    },
    ensureContinuationStatusMessage: ({ requestId, sessionId }) => runInTransaction(conn, () => {
      const messageId = `continuation-status-${createHash('sha256').update(`${sessionId}\0${requestId}`).digest('hex')}`
      const existing = conn.prepare('SELECT sequence FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId) as { sequence: number } | undefined
      if (existing?.sequence != null) {
        const message = queries?.readMessage({ sessionId, messageId })
        if (!message) throw new Error('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
        return { message, sequence: existing.sequence }
      }
      return appendMessage(db, createContinuationStartedSystemMessage(sessionId, messageId))
    }),
    loadAcceptedMessages: ({ sessionId, turnId }) => {
      const turn = getPersistedTurnInSession(db, sessionId, turnId)
      return loadAcceptedMessagesForTurn(db, turn, queries)
    }
  }
  return Object.freeze(execution)
}

function createSessionHistoryPort(db: AppDatabase, sessionId: string): SessionHistoryPort {
  if (!sessionId.trim()) throw new Error('SESSION_SCOPE_REQUIRED')
  const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId)
  return Object.freeze({
    appendBatch: (events: Parameters<HistoryPort['appendBatch']>[0], expectedVersion: number, transcriptCommit?: Parameters<HistoryPort['appendBatch']>[2]) => history.appendBatch(events, expectedVersion, transcriptCommit),
    read: (invocationId: string) => history.read(invocationId),
    readLatestInvocationForSession: async (requestedSessionId: string, options?: { excludeInvocationId?: string; excludeInvocationIds?: readonly string[] }) => {
      if (requestedSessionId !== sessionId) throw new Error('SESSION_SCOPE_MISMATCH')
      return await history.readLatestInvocationForSession(sessionId, options)
    }
  })
}

function writeContinuationIntentState(
  conn: ReturnType<typeof getDbConnection>,
  input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up' },
  next: { route: string; status: string },
  rejectionReason?: string
): import('./contracts').ContinuationIntentReceipt {
  if (!input.requestId.trim() || !input.sessionId.trim()) throw new Error('CONTINUATION_IDENTITY_REQUIRED')
  if (!/^[a-f0-9]{64}$/.test(input.payloadSha256)) throw new Error('CONTINUATION_PAYLOAD_FINGERPRINT_INVALID')
  return runInTransaction(conn, () => {
    const prior = conn.prepare('SELECT session_id,payload_sha256,route,target_id,status,rejection_reason FROM continuation_intents WHERE request_id=?')
      .get(input.requestId) as { session_id: string; payload_sha256: string; route: string; target_id: string | null; status: string; rejection_reason: string | null } | undefined
    if (prior && (prior.session_id !== input.sessionId || prior.payload_sha256 !== input.payloadSha256)) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
    if (prior && ['queued', 'accepted_turn', 'accepted_continuation'].includes(prior.status)) {
      return { requestId: input.requestId, sessionId: prior.session_id, payloadSha256: prior.payload_sha256, route: prior.route, ...(prior.target_id ? { targetId: prior.target_id } : {}), status: prior.status, ...(prior.rejection_reason ? { rejectionReason: prior.rejection_reason } : {}) }
    }
    const now = Date.now()
    conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,status,rejection_reason,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET route=excluded.route,status=excluded.status,rejection_reason=excluded.rejection_reason,updated_at=excluded.updated_at`)
      .run(input.requestId, input.sessionId, input.payloadSha256, input.text, JSON.stringify(input.attachments ?? []), input.intentKind, next.route, next.status, rejectionReason ?? null, now, now)
    return { requestId: input.requestId, sessionId: input.sessionId, payloadSha256: input.payloadSha256, route: next.route, status: next.status, ...(rejectionReason ? { rejectionReason } : {}) }
  })
}

function getPersistedTurnInSession(db: AppDatabase, sessionId: string, turnId: string): PersistedTurn {
  const turn = getPersistedTurn(db, turnId)
  if (!turn || turn.sessionId !== sessionId) throw new Error('TURN_NOT_FOUND')
  return turn
}

export function loadAcceptedMessagesForTurn(db: AppDatabase, turn: PersistedTurn, queries?: SessionQueries): Message[] {
  if (!turn.userMessageId) throw new Error('TURN_USER_MESSAGE_MISSING')
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const selection = { sessionId: turn.sessionId, boundarySequence: turn.contextBoundarySequence, requiredUserMessageId: turn.userMessageId!, excludeMessageIds: turn.excludeMessageIds ?? [] }
    const messages = queries
      ? queries.readTurnContext(selection)
      : getProjectedTurnContext(db, selection.sessionId, selection.boundarySequence, selection.requiredUserMessageId, selection.excludeMessageIds)
    const history = new SqliteAgentHistory(conn, 1, Date.now, turn.sessionId)
    let events = history.readSync(turn.turnId).events
    if (events.length === 0 && turn.requestId !== turn.turnId) events = history.readSync(turn.requestId).events
    const acceptedInputs = events.filter((event) => event.kind === 'session-input-committed')
    if (acceptedInputs.length > 0 && (acceptedInputs.length !== 1 || events[0] !== acceptedInputs[0])) throw new Error('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    if (acceptedInputs.length === 0 && (turn.acceptedInputHistoryVersion ?? 0) > 0) throw new Error('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    const acceptedInput = acceptedInputs[0]
    let acceptedInputForShadow: { messageId: string; fingerprint: string } | undefined
    if (acceptedInput) {
      const payload = acceptedInput.payload as { sessionId?: unknown; messageId?: unknown; role?: unknown; inputFingerprint?: unknown }
      const userMessage = messages.find((message) => message.id === turn.userMessageId)
      if (acceptedInput.turnId !== turn.turnId || !userMessage || payload.sessionId !== turn.sessionId || payload.messageId !== userMessage.id || payload.role !== 'user' ||
        typeof payload.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(payload.inputFingerprint) ||
        queueInputFingerprint({ text: userMessage.content, attachments: userMessage.attachments }) !== payload.inputFingerprint) throw new Error('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
      acceptedInputForShadow = { messageId: userMessage.id, fingerprint: payload.inputFingerprint }
    }
    let acceptedMessages = messages
    let usedCanonicalContext = false
    try {
      const canonical = readCanonicalApiContextIfEligible(db, turn.sessionId, turn.contextBoundarySequence, turn.userMessageId, turn.excludeMessageIds ?? [], acceptedInputForShadow)
      if (canonical?.status === 'available' && canonical.messages) { acceptedMessages = [...canonical.messages]; usedCanonicalContext = true }
    } catch (error) {
      if (error instanceof Error && error.message === 'TURN_USER_INPUT_FINGERPRINT_MISMATCH') throw error
    }
    if (!usedCanonicalContext) {
      try { shadowAcceptedTurnContext(db, turn.sessionId, messages, acceptedInputForShadow) } catch { /* legacy reads remain observational */ }
    }
    return acceptedMessages
  })
}
