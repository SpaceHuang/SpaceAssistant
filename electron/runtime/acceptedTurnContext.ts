import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase, PersistedTurn } from '../database'
import { getDbConnection, getTurnContext } from '../database'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { createAcceptedTurn, type AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { TurnExecutionConfig } from '../../src/shared/assistantFactAggregator'
import { readSessionTranscript } from '../database/sessionTranscript'
import { acceptTurnContext } from '../database/acceptedTurnStorage'

/** Construct the frozen identity at an entry adapter after TurnRuntime has durably accepted it. */
export function createAcceptedTurnFromPrepared(
  db: AppDatabase,
  prepared: { turnId: string; requestId: string; sessionId: string; startToken: string; userMessage?: Pick<Message, 'id'> },
  lane: NonNullable<TurnExecutionConfig['lane']>,
  config: TurnExecutionConfig
): AcceptedTurn {
  if (!prepared.userMessage?.id) throw new Error('TURN_USER_MESSAGE_MISSING')
  const transcript = readSessionTranscript(db, prepared.sessionId)
  if (transcript.status !== 'ready') throw new Error('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')
  const accepted = createAcceptedTurn({
    turnId: prepared.turnId,
    requestId: prepared.requestId,
    sessionId: prepared.sessionId,
    lane,
    startToken: prepared.startToken,
    currentUserMessageId: prepared.userMessage.id,
    transcriptVersion: transcript.version,
    config: { ...config, lane }
  })
  return acceptTurnContext(db, accepted)
}

/** Resolve the accepted user message from the durable turn and verify its History commitment. */
export function loadAcceptedTurnMessages(db: AppDatabase, turn: PersistedTurn): Message[] {
  if (!turn.userMessageId) throw new Error('TURN_USER_MESSAGE_MISSING')
  const messages = getTurnContext(db, turn.sessionId, turn.contextBoundarySequence, turn.userMessageId, turn.excludeMessageIds ?? [])
  const history = new SqliteAgentHistory(getDbConnection(db))
  let events = history.readSync(turn.turnId).events
  // Legacy accepted turns wrote their first canonical receipt under requestId. New turns use turnId.
  if (events.length === 0 && turn.requestId !== turn.turnId) events = history.readSync(turn.requestId).events
  const acceptedInputs = events.filter((event) => event.kind === 'session-input-committed')
  if (acceptedInputs.length > 0 && (acceptedInputs.length !== 1 || events[0] !== acceptedInputs[0])) {
    throw new Error('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
  }
  if (acceptedInputs.length === 0 && (turn.acceptedInputHistoryVersion ?? 0) > 0) {
    throw new Error('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
  }
  const acceptedInput = acceptedInputs[0]
  if (acceptedInput) {
    const payload = acceptedInput.payload as { sessionId?: unknown; messageId?: unknown; role?: unknown; inputFingerprint?: unknown }
    const userMessage = messages.find((message) => message.id === turn.userMessageId)
    if (acceptedInput.turnId !== turn.turnId || !userMessage || payload.sessionId !== turn.sessionId || payload.messageId !== userMessage.id || payload.role !== 'user' ||
      typeof payload.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(payload.inputFingerprint) ||
      queueInputFingerprint({ text: userMessage.content, attachments: userMessage.attachments }) !== payload.inputFingerprint) {
      throw new Error('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    }
  }
  return messages
}
