import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

export type StorageMaintenanceProgress = Readonly<{ phase: 'archive' | 'vacuum' | 'reclaim' | 'complete'; completedPages?: number; remainingPages?: number }>
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

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

function activeSessionTurnCount(db: AppDatabase): number {
  const conn = getDbConnection(db)
  const claims = Number((conn.prepare(`SELECT COUNT(*) AS count FROM session_execution_claims
    WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')`).get() as { count: number }).count)
  const queued = Number((conn.prepare(`SELECT COUNT(*) AS count FROM session_execution_queue
    WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')`).get() as { count: number }).count)
  return claims + queued
}

function maintenanceBusyError(): Error & { code: string } {
  return Object.assign(new Error('database maintenance requires all session turns to be idle'), { code: 'STORAGE_MAINTENANCE_BUSY' })
}

export async function compactSessionDatabase(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: { clearProjectionCachesAfterArchive?: boolean } = {}
): Promise<{ archivePath: string; bytesBefore: number; bytesAfter: number; reclaimedPages: number }> {
  if (activeSessionTurnCount(db) > 0) throw maintenanceBusyError()
  const dbPath = db.filePath
  db.flushSave()
  const conn = getDbConnection(db)
  const checkpointBeforeArchive = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number }
  if (checkpointBeforeArchive.busy !== 0 || checkpointBeforeArchive.log !== checkpointBeforeArchive.checkpointed) {
    throw new Error('database WAL checkpoint is incomplete; retry storage maintenance')
  }
  const bytesBefore = fs.statSync(dbPath).size
  const archiveRoot = path.join(userDataDir, 'session-archives')
  const archivePath = path.join(archiveRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  fs.mkdirSync(archivePath, { recursive: true, mode: 0o700 })
  onProgress?.({ phase: 'archive' })
  try {
    const archivedDbPath = path.join(archivePath, path.basename(dbPath))
    fs.copyFileSync(dbPath, archivedDbPath, fs.constants.COPYFILE_EXCL)
    if (fs.statSync(archivedDbPath).size !== fs.statSync(dbPath).size) throw new Error('database archive size verification failed')
    const spillRoot = path.join(userDataDir, 'spill')
    if (fs.existsSync(spillRoot)) fs.cpSync(spillRoot, path.join(archivePath, 'spill'), { recursive: true, errorOnExist: true })
    const degradedSpillRoot = path.join(userDataDir, 'spill-degraded')
    if (fs.existsSync(degradedSpillRoot)) fs.cpSync(degradedSpillRoot, path.join(archivePath, 'spill-degraded'), { recursive: true, errorOnExist: true })
    if (options.clearProjectionCachesAfterArchive) clearSessionProjectionCaches(db)
    const originalPages = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    const originalFreelist = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    await yieldToEventLoop()
    onProgress?.({ phase: 'vacuum' })
    conn.exec('PRAGMA optimize')
    conn.exec('PRAGMA auto_vacuum=INCREMENTAL')
    conn.exec('VACUUM')
    await yieldToEventLoop()
    onProgress?.({ phase: 'reclaim', completedPages: 0, remainingPages: Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count) })
    conn.exec('PRAGMA incremental_vacuum')
    const remainingPages = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    const bytesAfter = fs.statSync(dbPath).size
    const reclaimedPages = Math.max(0, originalPages - Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count))
    db.flushSave()
    onProgress?.({ phase: 'complete', completedPages: reclaimedPages, remainingPages })
    return { archivePath, bytesBefore, bytesAfter: fs.statSync(dbPath).size, reclaimedPages }
  } catch (error) {
    fs.rmSync(archivePath, { recursive: true, force: true })
    throw error
  }
}
