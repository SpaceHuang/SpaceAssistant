import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { currentProcessGeneration } from '../database/processGeneration'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { createSqliteProjectionStateStore, createProjectionService } from '../sessionStorage/sqliteRuntimeBindings'

const LEGACY_CACHE_DELETE_MAX_ROWS = 64
const LEGACY_CACHE_DELETE_MAX_BYTES = 1024 * 1024

type LegacyCacheCursor = Readonly<{ sessionId: string; cacheKey: string }>
type LegacyCacheKeyRow = Readonly<{ session_id: string; cache_key: string; byte_length: number }>

/** Delete the retired transcript namespace by its existing composite primary key and yield between bounded transactions. */
async function deleteRetiredTranscriptCache(db: AppDatabase, conn: ReturnType<typeof getDbConnection>): Promise<number> {
  let cursor: LegacyCacheCursor | undefined
  let deletedRows = 0
  while (true) {
    const candidates = (cursor
      ? conn.prepare(`SELECT session_id,cache_key,length(CAST(value AS BLOB)) AS byte_length
          FROM canonical_session_projection_cache
          WHERE session_id>? OR (session_id=? AND cache_key>?)
          ORDER BY session_id,cache_key LIMIT ?`).all(cursor.sessionId, cursor.sessionId, cursor.cacheKey, LEGACY_CACHE_DELETE_MAX_ROWS)
      : conn.prepare(`SELECT session_id,cache_key,length(CAST(value AS BLOB)) AS byte_length
          FROM canonical_session_projection_cache ORDER BY session_id,cache_key LIMIT ?`).all(LEGACY_CACHE_DELETE_MAX_ROWS)) as LegacyCacheKeyRow[]
    if (candidates.length === 0) return deletedRows

    const page: LegacyCacheKeyRow[] = []
    let pageBytes = 0
    for (const row of candidates) {
      const rowBytes = Math.max(0, Number(row.byte_length) || 0)
      if (page.length > 0 && pageBytes + rowBytes > LEGACY_CACHE_DELETE_MAX_BYTES) break
      page.push(row)
      pageBytes += rowBytes
      if (pageBytes >= LEGACY_CACHE_DELETE_MAX_BYTES) break
    }
    if (page.length === 0) throw new Error('SESSION_PROJECTION_CACHE_DELETE_NO_PROGRESS')

    const deleted = runInTransaction(conn, () => {
      const remove = conn.prepare('DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key=?')
      let count = 0
      for (const row of page) count += Number(remove.run(row.session_id, row.cache_key).changes)
      return count
    })
    deletedRows += deleted
    cursor = { sessionId: page.at(-1)!.session_id, cacheKey: page.at(-1)!.cache_key }
    db.save()
    await yieldToEventLoop()
  }
}

/** Clear derived projection data and invalidate its proof before bounded old-cache reclamation. */
export async function clearSessionProjectionCaches(db: AppDatabase): Promise<{ cacheRows: number; eligibilityRows: number }> {
  const conn = getDbConnection(db)
  const store = createSqliteProjectionStateStore(db)
  const service = createProjectionService(store, { processGeneration: () => currentProcessGeneration(conn), connectionEpoch: () => 0,
    createToken: randomUUID, now: Date.now })
  const cleared = runInTransaction(conn, () => {
    const projectionCacheRows = Number(conn.prepare('DELETE FROM session_projection_cache').run().changes)
    const states = conn.prepare(`SELECT session_id,scope_key,session_generation FROM session_projection_state WHERE status<>'invalid'`)
      .all() as Array<{ session_id: string; scope_key: string; session_generation: string }>
    for (const state of states) service.invalidateInTransaction({ sessionId: state.session_id, scopeKey: state.scope_key,
      sessionGeneration: state.session_generation })
    const eligibilityRows = states.length
    return { projectionCacheRows, eligibilityRows }
  })
  try {
    const oldCacheRows = await deleteRetiredTranscriptCache(db, conn)
    return { cacheRows: oldCacheRows + cleared.projectionCacheRows, eligibilityRows: cleared.eligibilityRows }
  } finally {
    db.save()
  }
}
