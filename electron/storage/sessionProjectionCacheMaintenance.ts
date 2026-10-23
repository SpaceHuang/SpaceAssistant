import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { currentProcessGeneration } from '../database/processGeneration'
import { randomUUID } from 'node:crypto'
import { createSqliteProjectionStateStore, createProjectionService } from '../sessionStorage/sqliteRuntimeBindings'

/** Clear only derived projection caches and their eligibility, preserving canonical transcript and cleanup state. */
export function clearSessionProjectionCaches(db: AppDatabase): { cacheRows: number; eligibilityRows: number } {
  const conn = getDbConnection(db)
  const store = createSqliteProjectionStateStore(db)
  const service = createProjectionService(store, { processGeneration: () => currentProcessGeneration(conn), connectionEpoch: () => 0,
    createToken: randomUUID, now: Date.now })
  const cleared = runInTransaction(conn, () => {
    const oldCacheRows = Number(conn.prepare('DELETE FROM canonical_session_projection_cache').run().changes)
    const projectionCacheRows = Number(conn.prepare('DELETE FROM session_projection_cache').run().changes)
    const states = conn.prepare(`SELECT session_id,scope_key,session_generation FROM session_projection_state WHERE status<>'invalid'`)
      .all() as Array<{ session_id: string; scope_key: string; session_generation: string }>
    for (const state of states) service.invalidateInTransaction({ sessionId: state.session_id, scopeKey: state.scope_key,
      sessionGeneration: state.session_generation })
    const eligibilityRows = states.length
    return { cacheRows: oldCacheRows + projectionCacheRows, eligibilityRows }
  })
  db.save()
  return cleared
}
