import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

/** Clear only derived projection caches and their eligibility, preserving canonical transcript and cleanup state. */
export function clearSessionProjectionCaches(db: AppDatabase): { cacheRows: number; eligibilityRows: number } {
  const conn = getDbConnection(db)
  const cleared = runInTransaction(conn, () => {
    const cacheRows = Number(conn.prepare('DELETE FROM canonical_session_projection_cache').run().changes)
    const eligibilityRows = Number(conn.prepare('DELETE FROM canonical_session_projection_eligibility').run().changes)
    return { cacheRows, eligibilityRows }
  })
  db.save()
  return cleared
}
