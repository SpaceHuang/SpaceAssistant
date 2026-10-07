import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'

export type PeriodicSqliteMaintenanceResult = 'checkpointed' | 'busy' | 'checkpoint-incomplete'

/** Run low-priority SQLite upkeep only when persisted session turn fences are idle. */
export function runPeriodicSqliteMaintenance(db: AppDatabase): PeriodicSqliteMaintenanceResult {
  const conn = getDbConnection(db)
  const active = Number((conn.prepare(`SELECT
    (SELECT COUNT(*) FROM session_execution_claims WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')) +
    (SELECT COUNT(*) FROM session_execution_queue WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')) AS count`).get() as { count: number }).count)
  if (active > 0) return 'busy'
  conn.exec('PRAGMA optimize')
  const checkpoint = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number }
  if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) return 'checkpoint-incomplete'
  return 'checkpointed'
}

export function schedulePeriodicSqliteMaintenance(
  db: AppDatabase,
  options: { intervalMs?: number; onResult?: (result: PeriodicSqliteMaintenanceResult | 'failed') => void } = {}
): (() => void) & { quiesce(): Promise<void> } {
  let running = false
  let resolveIdle: (() => void) | undefined
  const timer = setInterval(() => {
    if (running) return
    running = true
    try { options.onResult?.(runPeriodicSqliteMaintenance(db)) }
    catch { options.onResult?.('failed') }
    finally { running = false; resolveIdle?.(); resolveIdle = undefined }
  }, options.intervalMs ?? 15 * 60 * 1000)
  timer.unref?.()
  const stop = (() => clearInterval(timer)) as (() => void) & { quiesce(): Promise<void> }
  stop.quiesce = async () => { if (running) await new Promise<void>((resolve) => { resolveIdle = resolve }) }
  return stop
}
