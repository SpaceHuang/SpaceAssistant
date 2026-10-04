import type { Message } from '../src/shared/domainTypes'
import type { PersistedMessage, TurnStorage, TurnStarted } from '../src/shared/turnCoordinator'
import {
  appendMessage,
  appendMessagesAtomically,
  createPersistedTurn,
  getTurnByRequestId,
  getPersistedTurn,
  updatePersistedTurnState,
  listStreamingAssistantMessages,
  listRecoverableResidues,
  finalizeResidueMessageKeepingOutcome,
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
import { getDbConnection } from './database'
import { SqliteAgentHistory } from './runtime/sqliteAgentHistory'
import { HistoryCorruptionError } from '../packages/agent-sdk/src/history'
import { decodeTerminalOutcome } from './runtime/terminalOutcome'
import { getProjectedMessage } from './runtime/sessionTranscriptProjection'

/** 将 coordinator 的持久化端口绑定到 SQLite；requestId 幂等必须跨进程重启由 turns 表保证。 */
export function createTurnCoordinatorStorage(db: AppDatabase): TurnStorage {
  const history = new SqliteAgentHistory(getDbConnection(db))
  return {
    findByRequestId: (sessionId, requestId) => {
      const persisted = getTurnByRequestId(db, sessionId, requestId)
      if (!persisted) return undefined
      const assistantMessage = getProjectedMessage(db, persisted.assistantMessageId)
      if (!assistantMessage) return undefined
      const userMessage = persisted.userMessageId ? getProjectedMessage(db, persisted.userMessageId) : undefined
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
        ...(persisted.retryOfMessageId ? { retryOfMessageId: persisted.retryOfMessageId } : {}),
        ...(persisted.retryOfInvocationId ? { retryOfInvocationId: persisted.retryOfInvocationId } : {}),
        ...(persisted.outcome ? { persistedOutcome: persisted.outcome as TurnStarted['persistedOutcome'] } : {}),
        ...(persisted.usage !== undefined ? { persistedUsage: persisted.usage } : {}),
        ...(persisted.error ? { persistedError: persisted.error } : {})
      }
    },
    hasActiveTurn: (sessionId) => hasActiveTurn(db, sessionId),
    getMessage: (messageId) => getProjectedMessage(db, messageId),
    append: (message) => appendMessage(db, message),
    appendMany: (messages) => appendMessagesAtomically(db, messages),
    prepareAtomic: (input) => prepareTurnAtomically(db, input),
    claimQueuedAtomic: (input) => claimQueuedTurnAtomically(db, input),
    update: (messageId, patch) => updateMessageContent(db, messageId, patch),
    updateIfStreaming: (messageId, patch) => updateMessageContentIfStreaming(db, messageId, patch),
    checkpoint: (turnId, version, message) => checkpointTurnAtomically(db, turnId, version, message.id, message),
    listStreaming: () => listStreamingAssistantMessages(db),
    listRecoverableResidues: () => listRecoverableResidues(db),
    finalizeResidueMessage: (messageId, targetStatus) => finalizeResidueMessageKeepingOutcome(db, messageId, targetStatus),
    listUnfinishedTurns: () => listPersistedTurns(db)
      .filter((turn) => turn.state === 'configuring' || turn.state === 'prepared' || turn.state === 'executing' || turn.state === 'waiting-confirm')
    .map((turn) => ({ turnId: turn.turnId, assistantMessageId: turn.assistantMessageId })),
    recoverTurn: (turnId, assistantMessageId) => {
      const turn = getPersistedTurn(db, turnId)
      let sessionInvocationIds: string[] = []
      let historyInvocationId: string | undefined
      let completedHistory: ReturnType<SqliteAgentHistory['readCompletedInvocationForSession']>
      let completedToolCalls: ReturnType<SqliteAgentHistory['readCompletedToolCallsForSession']>
      try {
        sessionInvocationIds = turn ? history.listInvocationIdsForSession(turn.sessionId) : []
        // Newly accepted turns own a canonical stream keyed by turnId. Read the
        // requestId stream only as a compatibility fallback for pre-cutover data.
        historyInvocationId = turn && sessionInvocationIds.includes(turn.turnId)
          ? turn.turnId
          : turn?.requestId
        completedHistory = turn?.sessionId && historyInvocationId ? history.readCompletedInvocationForSession(historyInvocationId, turn.sessionId, turn.turnId) : undefined
        completedToolCalls = turn?.sessionId && historyInvocationId ? history.readCompletedToolCallsForSession(historyInvocationId, turn.sessionId, turn.turnId) : undefined
      } catch (error) {
        if (!(error instanceof HistoryCorruptionError)) throw error
        // Corrupt canonical history cannot authorize success. Preserve startup recovery by
        // falling back to the coordinator's failed/recovered terminal for this unfinished turn.
        return recoverPersistedTurn(db, turnId, assistantMessageId)
      }
      const canonicalCompleted = Boolean(turn && turn.assistantMessageId === assistantMessageId &&
        turn.sessionId &&
        completedHistory && completedToolCalls)
      if (canonicalCompleted && recoverPersistedTurn(db, turnId, assistantMessageId, {
        completed: true,
        completedOutputText: completedHistory?.outputText,
        completedUsage: completedHistory?.usage,
        completedToolCalls
      })) return 'completed'
      let canonicalOutcome: 'failed' | 'cancelled' | 'timed-out' | 'recovered' | undefined
      try {
        if (turn && historyInvocationId && turn.assistantMessageId === assistantMessageId && sessionInvocationIds.includes(historyInvocationId)) {
          const events = history.readSync(historyInvocationId).events
          const terminal = events.at(-1)
          if (terminal?.turnId === turn.turnId) {
            const decoded = decodeTerminalOutcome(terminal)
            if (decoded === 'failed') canonicalOutcome = 'failed'
            else if (decoded === 'timed_out') canonicalOutcome = 'timed-out'
            else if (decoded === 'cancelled') canonicalOutcome = 'cancelled'
            else if (decoded === 'interrupted') canonicalOutcome = 'recovered'
          }
        }
      } catch (error) {
        if (!(error instanceof HistoryCorruptionError)) throw error
        return recoverPersistedTurn(db, turnId, assistantMessageId)
      }
      if (canonicalOutcome && recoverPersistedTurn(db, turnId, assistantMessageId, { outcome: canonicalOutcome })) return canonicalOutcome
      return recoverPersistedTurn(db, turnId, assistantMessageId)
    },
    saveTurn: (turn) => { createPersistedTurn(db, turn) }
    ,updateTurnState: (turnId, state, patch) => { updatePersistedTurnState(db, turnId, state, patch) }
  }
}

export type { PersistedMessage }
