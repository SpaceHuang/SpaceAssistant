import path from 'path'
import { resolveDbPath, resolveJsonPathForDb } from './jsonSnapshot'
import { migrateFromJsonIfNeeded } from './migrateFromJson'
import { openSqliteDatabase, type AppDatabase } from './sqliteStore'

export type { AppDatabase } from './sqliteStore'
export type { StoredMessage } from './types'
export { openSqliteDatabase } from './sqliteStore'

export {
  appendMessage,
  appendSearchHistory,
  createSession,
  deleteConfigValue,
  deleteQueuedUserMessage,
  deleteSession,
  deleteSessionUsage,
  getAllSessionUsages,
  getConfigValue,
  getMessages,
  getSession,
  getSessionUsage,
  listSearchHistory,
  listSessions,
  listSessionsMissingWorkDirProfile,
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
