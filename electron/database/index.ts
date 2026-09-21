import path from 'path'
import { resolveDbPath, resolveJsonPathForDb } from './jsonSnapshot'
import { migrateFromJsonIfNeeded } from './migrateFromJson'
import { openSqliteDatabase, type AppDatabase } from './sqliteStore'
import { migrateThinkingEffortConfig } from './thinkingEffortMigration'

export type { AppDatabase } from './sqliteStore'
export type { StoredMessage } from './types'
// 事务入口与 changes 转换 helper 的对外桶导出；实现位于 ./transaction（canonical 路径）。
export { openSqliteDatabase, getDbConnection } from './sqliteStore'
export { changesToNumber, runInTransaction } from './transaction'

export type {
  MessagesPage,
  ApiContextBaselineResult,
  ChatMessagePage,
  QueuedMessageEntry,
  QueueInputReceipt,
  RetryContextTarget,
  PersistedMessageEntry,
  ContextHistoryDbBaseline,
  SearchCorpusPage
} from './operations'
export {
  appendMessage,
  appendMessagesAtomically,
  prepareTurnAtomically,
  appendSearchHistory,
  createSession,
  deleteConfigValue,
  deleteQueuedUserMessage,
  deleteSession,
  deleteSessionUsage,
  getAllSessionUsages,
  getApiContextBaseline,
  getChatMessagePage,
  getContextHistorySummaryBaseline,
  getSearchCorpusPage,
  getConfigValue,
  getMessageSequence,
  getMessage,
  getTurnByRequestId,
  getPersistedTurn,
  setPersistedTurnExecutionConfig,
  failConfiguringTurn,
  listPersistedTurns,
  listTurnErrorsByAssistantMessageIds,
  hasActiveTurn,
  createPersistedTurn,
  getQueueInputReceipt,
  createQueueInputReceipt,
  enqueueQueuedUserMessage,
  claimQueuedTurnAtomically,
  updateQueueInputReceiptState,
  updatePersistedTurnState,
  recoverPersistedTurn,
  getMessages,
  getRecentTurnRoutingMessages,
  hasVisionInTurnRoutingContext,
  getTurnContext,
  getMessagesPage,
  getNextQueuedMessage,
  getSession,
  getSessionUsage,
  listSearchHistory,
  listSessions,
  listStreamingAssistantMessages,
  listSessionsMissingWorkDirProfile,
  resolveRetryContext,
  searchMessages,
  setConfigValue,
  setSessionUsage,
  updateMessageContent,
  checkpointTurnAtomically,
  updateMessageContentIfStreaming,
  updateSession
} from './operations'

export function openDatabase(inputPath: string): AppDatabase {
  if (inputPath === ':memory:') {
    const memoryDb = openSqliteDatabase(':memory:')
    // §8.1：全局档位启动迁移（幂等；已合法时不写）
    migrateThinkingEffortConfig(memoryDb)
    return memoryDb
  }
  const dbPath = resolveDbPath(inputPath)
  const db = openSqliteDatabase(dbPath)
  const jsonPath = resolveJsonPathForDb(dbPath)
  migrateFromJsonIfNeeded(db, jsonPath)
  // §8.1：全局档位启动迁移须在旧 JSON 导入之后——导入的 thinkingEnabled 同样走等价推导
  migrateThinkingEffortConfig(db)
  return db
}

export function getDefaultDbPath(userData: string): string {
  return path.join(userData, 'spaceassistant-data.db')
}
