import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from './transaction'

/** Current durable writer generation. Must be advanced only after Electron's single-instance lock succeeds. */
export function currentProcessGeneration(conn: DatabaseSync): number {
  const row = conn.prepare('SELECT current_generation FROM process_generation_state WHERE singleton_id=1').get() as
    { current_generation: number } | undefined
  if (!row || !Number.isSafeInteger(row.current_generation) || row.current_generation < 0) {
    throw new Error('PROCESS_GENERATION_STATE_INVALID')
  }
  return row.current_generation
}

/** Fences callbacks from prior app processes; caller owns proof of the Electron single-instance lock. */
export function advanceProcessGeneration(conn: DatabaseSync, now: () => number = Date.now): number {
  return runInTransaction(conn, () => {
    const current = currentProcessGeneration(conn)
    if (current >= Number.MAX_SAFE_INTEGER) throw new Error('PROCESS_GENERATION_EXHAUSTED')
    const next = current + 1
    const result = conn.prepare(`UPDATE process_generation_state SET current_generation=?,updated_at=?
      WHERE singleton_id=1 AND current_generation=?`).run(next, now(), current) as { changes: number | bigint }
    if (Number(result.changes) !== 1) throw new Error('PROCESS_GENERATION_ADVANCE_CONFLICT')
    return next
  })
}
