import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase, PersistedTurn } from '../database'
import { getDbConnection, getTurnContext } from '../database'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { SqliteAgentHistory } from './sqliteAgentHistory'

/** Resolve the accepted user message from the durable turn and verify its History commitment. */
export function loadAcceptedTurnMessages(db: AppDatabase, turn: PersistedTurn): Message[] {
  if (!turn.userMessageId) throw new Error('TURN_USER_MESSAGE_MISSING')
  const messages = getTurnContext(db, turn.sessionId, turn.contextBoundarySequence, turn.userMessageId, turn.excludeMessageIds ?? [])
  const events = new SqliteAgentHistory(getDbConnection(db)).readSync(turn.requestId).events
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
