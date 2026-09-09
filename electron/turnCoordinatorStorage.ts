import type { Message } from '../src/shared/domainTypes'
import type { PersistedMessage, TurnStorage, TurnStarted } from '../src/shared/turnCoordinator'
import {
  appendMessage,
  appendMessagesAtomically,
  createPersistedTurn,
  getTurnByRequestId,
  updatePersistedTurnState,
  getMessage,
  listStreamingAssistantMessages,
  listPersistedTurns,
  hasActiveTurn,
  updateMessageContent,
  updateMessageContentIfStreaming
  ,prepareTurnAtomically
  ,checkpointTurnAtomically
  ,claimQueuedTurnAtomically
  ,recoverPersistedTurn
} from './database'
import type { AppDatabase } from './database'

/** 将 coordinator 的持久化端口绑定到 SQLite；requestId 幂等必须跨进程重启由 turns 表保证。 */
export function createTurnCoordinatorStorage(db: AppDatabase): TurnStorage {
  return {
    findByRequestId: (sessionId, requestId) => {
      const persisted = getTurnByRequestId(db, sessionId, requestId)
      if (!persisted) return undefined
      const assistantMessage = getMessage(db, persisted.assistantMessageId)
      if (!assistantMessage) return undefined
      const userMessage = persisted.userMessageId ? getMessage(db, persisted.userMessageId) : undefined
      return {
        turnId: persisted.turnId,
        requestId: persisted.requestId,
        sessionId: persisted.sessionId,
        ...(userMessage ? { userMessage } : {}),
        assistantMessage,
        version: persisted.version,
        startToken: persisted.startToken ?? '',
        ...(persisted.intentFingerprint ? { intentFingerprint: persisted.intentFingerprint } : {}),
        ...(persisted.excludeMessageIds ? { excludeMessageIds: persisted.excludeMessageIds } : {}),
        ...(persisted.executionConfig ? { executionConfig: persisted.executionConfig } : {}),
        ...(persisted.outcome ? { persistedOutcome: persisted.outcome as TurnStarted['persistedOutcome'] } : {}),
        ...(persisted.usage !== undefined ? { persistedUsage: persisted.usage } : {}),
        ...(persisted.error ? { persistedError: persisted.error } : {})
      }
    },
    hasActiveTurn: (sessionId) => hasActiveTurn(db, sessionId),
    getMessage: (messageId) => getMessage(db, messageId),
    append: (message) => appendMessage(db, message),
    appendMany: (messages) => appendMessagesAtomically(db, messages),
    prepareAtomic: (input) => prepareTurnAtomically(db, input),
    claimQueuedAtomic: (input) => claimQueuedTurnAtomically(db, input),
    update: (messageId, patch) => updateMessageContent(db, messageId, patch),
    updateIfStreaming: (messageId, patch) => updateMessageContentIfStreaming(db, messageId, patch),
    checkpoint: (turnId, version, message) => checkpointTurnAtomically(db, turnId, version, message.id, message),
    listStreaming: () => listStreamingAssistantMessages(db),
    listUnfinishedTurns: () => listPersistedTurns(db)
      .filter((turn) => turn.state === 'configuring' || turn.state === 'prepared' || turn.state === 'executing' || turn.state === 'waiting-confirm')
      .map((turn) => ({ turnId: turn.turnId, assistantMessageId: turn.assistantMessageId })),
    recoverTurn: (turnId, assistantMessageId) => recoverPersistedTurn(db, turnId, assistantMessageId),
    saveTurn: (turn) => { createPersistedTurn(db, turn) }
    ,updateTurnState: (turnId, state, patch) => { updatePersistedTurnState(db, turnId, state, patch) }
  }
}

export type { PersistedMessage }
