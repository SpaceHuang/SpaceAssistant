import { appendSearchHistory, listSearchHistory } from './operations'
import type { AppDatabase } from './sqliteStore'

/** Search history persistence belongs to the database owner; IPC receives only this domain API. */
export function createSearchHistoryStore(db: AppDatabase) {
  return Object.freeze({
    append: (query: string) => appendSearchHistory(db, query),
    list: (limit?: number) => listSearchHistory(db, limit)
  })
}
