import type { SessionAcceptedTurn, SessionCanonicalMessage, SessionCommitEvent, SessionCommitIntent, SessionCommitPort, SessionCommitResult } from '../public/ports'
import type { ClaimQueuedTurnInput, ClaimedQueuedTurnResult, PrepareTurnInput, PreparedTurnResult } from './ports'

export type CanonicalMessageRevision = Readonly<{
  messages: readonly SessionCanonicalMessage[]
  canonicalWriteFence: Readonly<{
    sessionGeneration: string
    sessionSeq: number
    commitOrder: number
    watermarkEventId: string | null
    watermarkInvocationId: string | null
  }>
  completedAt: number
}>

export type SessionCommitService = Readonly<{
  historyPort: SessionCommitPort
  commitHistory(events: readonly SessionCommitEvent[], expectedVersion: number): Promise<SessionCommitResult>
  commitTerminal(events: readonly SessionCommitEvent[], expectedVersion: number, intent: SessionCommitIntent): Promise<SessionCommitResult>
  reviseCanonicalMessage(revision: CanonicalMessageRevision, expectedVersion: number): Promise<SessionCommitResult>
  acceptTurn(candidate: SessionAcceptedTurn, participant: (candidate: SessionAcceptedTurn) => SessionAcceptedTurn): SessionAcceptedTurn
  prepareTurn(input: PrepareTurnInput, participant: (input: PrepareTurnInput) => PreparedTurnResult): PreparedTurnResult
  claimQueuedTurn(input: ClaimQueuedTurnInput, participant: (input: ClaimQueuedTurnInput) => ClaimedQueuedTurnResult): ClaimedQueuedTurnResult
}>

/**
 * Binds SDK History writes to the accepted session/invocation/turn identity before
 * they reach the storage participant. The SQLite participant remains responsible
 * for transactional version, lease, and receipt checks.
 */
export function createSessionCommitService(input: Readonly<{
  sessionId: string
  invocationId: string
  turnId: string
  history: SessionCommitPort
}>): SessionCommitService {
  if (!input.sessionId.trim() || !input.invocationId.trim() || !input.turnId.trim()) {
    throw new Error('SESSION_COMMIT_IDENTITY_REQUIRED')
  }
  const assertEvents = (events: readonly SessionCommitEvent[]) => {
    if (!events.length) throw new Error('SESSION_COMMIT_EVENTS_REQUIRED')
    if (events.some((event) => event.invocationId !== input.invocationId || event.turnId !== input.turnId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !event.eventId.trim() || !event.idempotencyKey.trim() || !Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1)) {
      throw new Error('SESSION_COMMIT_EVENT_IDENTITY_MISMATCH')
    }
  }
  const commitHistory = async (events: readonly SessionCommitEvent[], expectedVersion: number): Promise<SessionCommitResult> => {
    assertEvents(events)
    return await input.history.appendBatch(events, expectedVersion)
  }
  const commitTerminal = async (events: readonly SessionCommitEvent[], expectedVersion: number, intent: SessionCommitIntent): Promise<SessionCommitResult> => {
    assertEvents(events)
    if (intent.sessionId !== input.sessionId) throw new Error('SESSION_COMMIT_SESSION_MISMATCH')
    if (intent.executionLease && (intent.executionLease.sessionId !== input.sessionId || intent.executionLease.turnId !== input.turnId)) {
      throw new Error('SESSION_COMMIT_LEASE_MISMATCH')
    }
    return await input.history.appendBatch(events, expectedVersion, intent)
  }
  const reviseCanonicalMessage = async (revision: CanonicalMessageRevision, expectedVersion: number): Promise<SessionCommitResult> => {
    const events: SessionCommitEvent[] = [
      { invocationId: input.invocationId, turnId: input.turnId, sequence: 1, schemaVersion: 1,
        eventId: `message-revision-${input.invocationId}-context`, idempotencyKey: `message-revision-${input.invocationId}-context`, kind: 'invocation-context-committed',
        payload: { messages: revision.messages, canonicalWriteFence: revision.canonicalWriteFence } },
      { invocationId: input.invocationId, turnId: input.turnId, sequence: 2, schemaVersion: 1,
        eventId: `message-revision-${input.invocationId}-completed`, idempotencyKey: `message-revision-${input.invocationId}-completed`, kind: 'invocation-completed',
        payload: { status: 'completed', completedAt: revision.completedAt } }
    ]
    return await commitHistory(events, expectedVersion)
  }
  const acceptTurn = (candidate: SessionAcceptedTurn,
    participant: (candidate: SessionAcceptedTurn) => SessionAcceptedTurn): SessionAcceptedTurn => {
    if (candidate.sessionId !== input.sessionId || candidate.requestId !== input.invocationId || candidate.turnId !== input.turnId) {
      throw new Error('SESSION_COMMIT_ACCEPTANCE_IDENTITY_MISMATCH')
    }
    return participant(candidate)
  }
  const prepareTurn = (command: PrepareTurnInput, participant: (command: PrepareTurnInput) => PreparedTurnResult): PreparedTurnResult => {
    if (command.turn.sessionId !== input.sessionId || command.turn.requestId !== input.invocationId || command.turn.turnId !== input.turnId ||
      command.user.sessionId !== input.sessionId || command.assistant.sessionId !== input.sessionId ||
      command.assistant.id !== command.turn.assistantMessageId || (command.turn.userMessageId && command.turn.userMessageId !== command.user.id)) {
      throw new Error('SESSION_COMMIT_PREPARE_IDENTITY_MISMATCH')
    }
    return participant(command)
  }
  const claimQueuedTurn = (command: ClaimQueuedTurnInput,
    participant: (command: ClaimQueuedTurnInput) => ClaimedQueuedTurnResult): ClaimedQueuedTurnResult => {
    if (command.sessionId !== input.sessionId || command.requestId !== input.invocationId || command.turnId !== input.turnId) {
      throw new Error('SESSION_COMMIT_CLAIM_IDENTITY_MISMATCH')
    }
    return participant(command)
  }
  const historyPort: SessionCommitPort = {
    appendBatch: (events, expectedVersion, intent) => intent
      ? commitTerminal(events, expectedVersion, intent)
      : commitHistory(events, expectedVersion),
    read: async (invocationId) => {
      if (invocationId !== input.invocationId) throw new Error('SESSION_COMMIT_INVOCATION_MISMATCH')
      return await input.history.read(invocationId)
    }
  }
  return Object.freeze({ historyPort, commitHistory, commitTerminal, reviseCanonicalMessage, acceptTurn, prepareTurn, claimQueuedTurn })
}
