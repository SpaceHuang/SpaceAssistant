import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { clearSessionProjectionCaches } from './sessionProjectionCacheMaintenance'

export { clearSessionProjectionCaches } from './sessionProjectionCacheMaintenance'

export type StorageMaintenanceProgress = Readonly<{ phase: 'archive' | 'vacuum' | 'reclaim' | 'complete'; completedPages?: number; remainingPages?: number }>

export class StorageMaintenanceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StorageMaintenanceError'
    this.code = code
  }
}

function directoryFileBytes(root: string): number {
  if (!fs.existsSync(root)) return 0
  let bytes = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) bytes += directoryFileBytes(filePath)
    else if (entry.isFile()) bytes += fs.statSync(filePath).size
  }
  return bytes
}

function fileSha256(filePath: string): string {
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const hash = createHash('sha256')
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}

function directoryContentManifest(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('archive spill root is not a regular directory')
  const entries: string[] = []
  const visit = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.posix.join(prefix, entry.name)
      if (entry.isSymbolicLink()) throw new Error('archive spill tree contains a symbolic link')
      if (entry.isDirectory()) visit(absolutePath, relativePath)
      else if (entry.isFile()) entries.push(`${relativePath}\0${fs.statSync(absolutePath).size}\0${fileSha256(absolutePath)}`)
      else throw new Error('archive spill tree contains an unsupported file type')
    }
  }
  visit(root, '')
  return entries.sort()
}

/** Verify the backup before VACUUM using byte identity, SQLite integrity and spill file content hashes. */
export function verifySessionMaintenanceArchive(sourceDbPath: string, archivePath: string, userDataDir: string): boolean {
  try {
    const archivedDbPath = path.join(archivePath, path.basename(sourceDbPath))
    if (fileSha256(sourceDbPath) !== fileSha256(archivedDbPath)) return false
    const archivedDb = new DatabaseSync(archivedDbPath, { readOnly: true })
    try {
      const integrity = archivedDb.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
      const foreignKeyErrors = archivedDb.prepare('PRAGMA foreign_key_check').all()
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeyErrors.length > 0) return false
    } finally { archivedDb.close() }
    for (const directory of ['spill', 'spill-degraded']) {
      if (JSON.stringify(directoryContentManifest(path.join(userDataDir, directory))) !==
        JSON.stringify(directoryContentManifest(path.join(archivePath, directory)))) return false
    }
    return true
  } catch {
    return false
  }
}

function sqliteFileSizes(dbPath: string): { dbBytes: number; walBytes: number; shmBytes: number } {
  const size = (filePath: string) => fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  return { dbBytes: size(dbPath), walBytes: size(`${dbPath}-wal`), shmBytes: size(`${dbPath}-shm`) }
}

function writeMaintenanceReport(archivePath: string, report: Record<string, unknown>): string {
  const reportPath = path.join(archivePath, 'maintenance.json')
  const temporaryPath = `${reportPath}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporaryPath, reportPath)
  return reportPath
}

function activeSessionTurnCount(db: AppDatabase): number {
  const conn = getDbConnection(db)
  return Number((conn.prepare(`SELECT
    (SELECT COUNT(*) FROM session_execution_claims WHERE status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')) +
    (SELECT COUNT(*) FROM session_execution_queue WHERE status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')) +
    (SELECT COUNT(*) FROM turns WHERE state IN ('configuring','prepared','executing','waiting-confirm')) +
    (SELECT COUNT(*) FROM messages WHERE status IN ('queued','streaming')) AS count`).get() as { count: number }).count)
}

function maintenanceBusyError(): Error & { code: string } {
  return new StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY', 'database maintenance requires all session turns to be idle')
}

export async function compactSessionDatabase(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: { clearProjectionCachesAfterArchive?: boolean; signal?: AbortSignal; availableBytes?: () => number } = {}
): Promise<{ archivePath: string; bytesBefore: number; bytesAfter: number; reclaimedPages: number; durationMs: number;
  pageCountBefore: number; pageCountAfter: number; freelistCountBefore: number; freelistCountAfter: number;
  walBytesBefore: number; walBytesAfter: number; shmBytesBefore: number; shmBytesAfter: number;
  archiveBytes: number; availableBytesBefore: number; peakSpaceEstimateBytes: number; manifestPath: string }> {
  const startedAt = performance.now()
  if (activeSessionTurnCount(db) > 0) throw maintenanceBusyError()
  const dbPath = db.filePath
  db.flushSave()
  const conn = getDbConnection(db)
  const checkpointBeforeArchive = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number }
  if (checkpointBeforeArchive.busy !== 0 || checkpointBeforeArchive.log !== checkpointBeforeArchive.checkpointed) {
    throw new Error('database WAL checkpoint is incomplete; retry storage maintenance')
  }
  const filesBefore = sqliteFileSizes(dbPath)
  const bytesBefore = filesBefore.dbBytes
  const spillRoot = path.join(userDataDir, 'spill')
  const degradedSpillRoot = path.join(userDataDir, 'spill-degraded')
  const originalSpillBytes = directoryFileBytes(spillRoot)
  const originalDegradedSpillBytes = directoryFileBytes(degradedSpillRoot)
  const statfs = fs.statfsSync(path.dirname(dbPath))
  const actualAvailableBytesBefore = Number(statfs.bavail ?? statfs.bfree) * Number(statfs.bsize)
  const getAvailableBytes = options.availableBytes ?? (() => {
    const current = fs.statfsSync(path.dirname(dbPath))
    return Number(current.bavail ?? current.bfree) * Number(current.bsize)
  })
  const availableBytesBefore = options.availableBytes ? getAvailableBytes() : actualAvailableBytesBefore
  const peakSpaceEstimateBytes = filesBefore.dbBytes + filesBefore.walBytes + filesBefore.shmBytes +
    originalSpillBytes + originalDegradedSpillBytes + filesBefore.dbBytes * 2
  const ensureNotAborted = () => {
    if (options.signal?.aborted) throw new StorageMaintenanceError('STORAGE_MAINTENANCE_CANCELLED', 'database maintenance was cancelled')
  }
  if (availableBytesBefore < peakSpaceEstimateBytes) {
    throw new StorageMaintenanceError('STORAGE_MAINTENANCE_INSUFFICIENT_SPACE',
      `database maintenance requires an estimated ${peakSpaceEstimateBytes} bytes; ${availableBytesBefore} bytes are available`)
  }
  const archiveRoot = path.join(userDataDir, 'session-archives')
  const archivePath = path.join(archiveRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  let archiveVerified = false
  let phase: StorageMaintenanceProgress['phase'] = 'archive'
  try {
    phase = 'archive'
    ensureNotAborted()
    fs.mkdirSync(archivePath, { recursive: true, mode: 0o700 })
    onProgress?.({ phase: 'archive' })
    const archivedDbPath = path.join(archivePath, path.basename(dbPath))
    fs.copyFileSync(dbPath, archivedDbPath, fs.constants.COPYFILE_EXCL)
    if (fs.statSync(archivedDbPath).size !== fs.statSync(dbPath).size) throw new Error('database archive size verification failed')
    if (fs.existsSync(spillRoot)) fs.cpSync(spillRoot, path.join(archivePath, 'spill'), { recursive: true, errorOnExist: true })
    if (fs.existsSync(degradedSpillRoot)) fs.cpSync(degradedSpillRoot, path.join(archivePath, 'spill-degraded'), { recursive: true, errorOnExist: true })
    archiveVerified = fs.statSync(archivedDbPath).size === bytesBefore &&
      directoryFileBytes(path.join(archivePath, 'spill')) === originalSpillBytes &&
      directoryFileBytes(path.join(archivePath, 'spill-degraded')) === originalDegradedSpillBytes &&
      verifySessionMaintenanceArchive(dbPath, archivePath, userDataDir)
    if (!archiveVerified) throw new Error('database/spill archive verification failed')
    ensureNotAborted()
    const availableBytesAtVacuum = getAvailableBytes()
    if (availableBytesAtVacuum < filesBefore.dbBytes) {
      throw new StorageMaintenanceError('STORAGE_MAINTENANCE_INSUFFICIENT_SPACE',
        `database maintenance requires ${filesBefore.dbBytes} bytes for the VACUUM working copy; ${availableBytesAtVacuum} bytes are available after archiving`)
    }
    if (options.clearProjectionCachesAfterArchive) clearSessionProjectionCaches(db)
    const originalPages = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    const originalFreelist = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    phase = 'vacuum'
    onProgress?.({ phase: 'vacuum' })
    conn.exec('PRAGMA optimize')
    conn.exec('PRAGMA auto_vacuum=INCREMENTAL')
    conn.exec('VACUUM')
    phase = 'reclaim'
    onProgress?.({ phase, completedPages: 0, remainingPages: Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count) })
    conn.exec('PRAGMA incremental_vacuum')
    const freelistCountAfter = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    const pageCountAfter = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    const remainingPages = freelistCountAfter
    const reclaimedPages = Math.max(0, originalPages - pageCountAfter)
    db.flushSave()
    const filesAfter = sqliteFileSizes(dbPath)
    const archiveBytes = directoryFileBytes(archivePath)
    const durationMs = performance.now() - startedAt
    phase = 'complete'
    onProgress?.({ phase, completedPages: reclaimedPages, remainingPages })
    const result = { archivePath, bytesBefore, bytesAfter: filesAfter.dbBytes, reclaimedPages, durationMs,
      pageCountBefore: originalPages, pageCountAfter, freelistCountBefore: originalFreelist, freelistCountAfter,
      walBytesBefore: filesBefore.walBytes, walBytesAfter: filesAfter.walBytes,
      shmBytesBefore: filesBefore.shmBytes, shmBytesAfter: filesAfter.shmBytes,
      archiveBytes, availableBytesBefore, peakSpaceEstimateBytes }
    const manifestPath = writeMaintenanceReport(archivePath, {
      formatVersion: 1, recordedAt: new Date().toISOString(), status: 'complete', ...result,
      archivePath: undefined,
      note: 'peakSpaceEstimateBytes is a conservative bound for the source DB, archived DB/spills and one VACUUM working copy; it is not an observed instantaneous peak.'
    })
    return { ...result, manifestPath }
  } catch (error) {
    if (!archiveVerified) fs.rmSync(archivePath, { recursive: true, force: true })
    else {
      const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : error instanceof Error ? error.name : 'UNKNOWN_ERROR'
      try {
        writeMaintenanceReport(archivePath, { formatVersion: 1, recordedAt: new Date().toISOString(), status: 'failed', phase, failureCode,
          ...(error instanceof Error ? { failureMessage: error.message } : {}) })
      } catch { /* Preserve the verified DB/spill archive even if its failure report cannot be written. */ }
      if (error && typeof error === 'object') Object.assign(error, { archivePath, archivePreserved: true, phase })
    }
    throw error
  }
}
