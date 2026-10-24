import type { AppDatabase } from '../database'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

/** Test-only composition owner for fixtures backed by the production SQLite adapter. */
export function createTestSessionStorage(db: AppDatabase) {
  return createSqliteSessionStorage(db)
}
