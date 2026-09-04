import path from 'path'
import { resolveDbPath, resolveJsonPathForDb } from './jsonSnapshot'
import { migrateFromJsonIfNeeded } from './migrateFromJson'
import { openSqliteDatabase, type AppDatabase } from './sqliteStore'

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
  RetryContextTarget,
  PersistedMessageEntry,
  ContextHistoryDbBaseline,
  SearchCorpusPage
} from './operations'
export {
  appendMessage,
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
  getMessages,
  getMessagesPage,
  getNextQueuedMessage,
  getSession,
  getSessionUsage,
  listSearchHistory,
  listSessions,
  listSessionsMissingWorkDirProfile,
  resolveRetryContext,
  searchMessages,
  setConfigValue,
  setSessionUsage,
  updateMessageContent,
  updateSession
} from './operations'

export function openDatabase(inputPath: string): AppDatabase {
  if (inputPath === ':memory:') {
    return openSqliteDatabase(':memory:')
  }
  const dbPath = resolveDbPath(inputPath)
  const db = openSqliteDatabase(dbPath)
  const jsonPath = resolveJsonPathForDb(dbPath)
  migrateFromJsonIfNeeded(db, jsonPath)
  return db
}

export function getDefaultDbPath(userData: string): string {
  return path.join(userData, 'spaceassistant-data.db')
}

export function getLegacyJsonDbPath(userData: string): string {
  return path.join(userData, 'spaceassistant-data.json')
}
