import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import type { Worker } from 'node:worker_threads'
import type { AppDatabase } from '../database'
import { getDbConnection, reopenDatabaseConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { clearSessionProjectionCaches } from './sessionProjectionCacheMaintenance'
import { StorageMaintenanceError } from './storageMaintenanceError'
import { copyFileWithHash, copyTreeWithManifest } from './streamingCopy'
import type { CopyTreeWithManifestResult } from './streamingCopy'
import { runSessionMaintenanceWorker, COMPACTION_WORKER_ENTRY_UNAVAILABLE } from './sessionStorageMaintenanceWorkerClient'

export { clearSessionProjectionCaches } from './sessionProjectionCacheMaintenance'
export { StorageMaintenanceError } from './storageMaintenanceError'

export type StorageMaintenanceProgress = Readonly<{ phase: 'archive' | 'vacuum' | 'reclaim' | 'swap' | 'complete'; completedPages?: number; remainingPages?: number; completedBytes?: number; totalBytes?: number }>

export type StorageMaintenanceVacuumMode = 'none' | 'incremental' | 'full'
export type StorageMaintenanceExecutionTarget = 'worker' | 'in-process'

/** L1 快路径（仅 incremental_vacuum）允许的最大 freelist/page 比；超出则回退全量 VACUUM。 */
export const FULL_VACUUM_FREELIST_RATIO = 0.3

/** 快照一致性重做上限：data_version 连续变化达到该次数即报忙碌，永不换入过期 staging。 */
export const COMPACT_SNAPSHOT_RETRY_LIMIT = 3
/** Windows 上换入 rename 撞瞬态只读句柄（profile 收集等）的有限重试。 */
export const COMPACT_SWAP_RENAME_RETRY_LIMIT = 5
export const COMPACT_SWAP_RENAME_RETRY_DELAY_MS = 200

/** 归档复制阶段产生的字节恒等证据；verify 优先复用，避免对源/归档重复整遍哈希。 */
export type SessionMaintenanceArchiveEvidence = {
  dbSourceSha256?: string
  dbDestSha256?: string
  spillSourceManifest?: string[]
  spillDegradedSourceManifest?: string[]
}

export type CompactSessionDatabaseResult = {
  archivePath: string; bytesBefore: number; bytesAfter: number; reclaimedPages: number; durationMs: number;
  pageCountBefore: number; pageCountAfter: number; freelistCountBefore: number; freelistCountAfter: number;
  walBytesBefore: number; walBytesAfter: number; shmBytesBefore: number; shmBytesAfter: number;
  archiveBytes: number; availableBytesBefore: number; peakSpaceEstimateBytes: number; manifestPath: string;
  vacuumMode: StorageMaintenanceVacuumMode; executionTarget: StorageMaintenanceExecutionTarget;
  snapshotAttempts: number
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

/**
 * Verify the backup before VACUUM using byte identity, SQLite structural sanity and spill file content hashes.
 * evidence 缺省时两侧现算（独立调用方）；进程内压缩路径传入复制阶段的双侧哈希/清单，省掉重复整遍读。
 */
export function verifySessionMaintenanceArchive(
  sourceDbPath: string,
  archivePath: string,
  userDataDir: string,
  evidence: SessionMaintenanceArchiveEvidence = {}
): boolean {
  try {
    const archivedDbPath = path.join(archivePath, path.basename(sourceDbPath))
    const sourceSha256 = evidence.dbSourceSha256 ?? fileSha256(sourceDbPath)
    const destSha256 = evidence.dbDestSha256 ?? fileSha256(archivedDbPath)
    if (sourceSha256 !== destSha256) return false
    const archivedDb = new DatabaseSync(archivedDbPath, { readOnly: true })
    try {
      // 字节恒等（哈希对）已排除复制引入的损坏；FK 违例不可能由复制产生，逐行 foreign_key_check 属纯冗余。
      // 保留 quick_check 单遍结构校验，兜底「源库在快照前已损坏」的场景。
      const quickCheck = archivedDb.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
      if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') return false
    } finally { archivedDb.close() }
    for (const [directory, sourceManifest] of [
      ['spill', evidence.spillSourceManifest],
      ['spill-degraded', evidence.spillDegradedSourceManifest]
    ] as const) {
      const expected = sourceManifest ?? directoryContentManifest(path.join(userDataDir, directory))
      if (JSON.stringify(expected) !== JSON.stringify(directoryContentManifest(path.join(archivePath, directory)))) return false
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

export function activeSessionTurnCount(db: AppDatabase): number {
  const conn = getDbConnection(db)
  return Number((conn.prepare(`SELECT
    (SELECT COUNT(*) FROM session_execution_claims WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')) +
    (SELECT COUNT(*) FROM session_execution_queue WHERE status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')) +
    (SELECT COUNT(*) FROM turns WHERE state IN ('configuring','prepared','executing','waiting-confirm')) +
    (SELECT COUNT(*) FROM messages WHERE status IN ('queued','streaming')) AS count`).get() as { count: number }).count)
}

function maintenanceBusyError(): Error & { code: string } {
  return new StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY', 'database maintenance requires all session turns to be idle')
}

function renameWithRetry(sourcePath: string, destPath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(sourcePath, destPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (!transient || attempt >= COMPACT_SWAP_RENAME_RETRY_LIMIT) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, COMPACT_SWAP_RENAME_RETRY_DELAY_MS)
    }
  }
}

function removeStagingArtifacts(stagingPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${stagingPath}${suffix}`, { force: true })
}

/**
 * 启动对账：清理崩溃遗留的压缩 staging；live 缺失且 staging 在时完成换入（rename 原子性保证不存在半截 live）。
 * 必须在 openDatabase 之前调用——DatabaseSync 打开不存在的路径会静默建空库。
 */
export function reconcileInterruptedCompaction(dbPath: string): { recoveredAtSwap: boolean; removedStaleStaging: number } {
  const directory = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const stagingPaths = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.startsWith(`${base}.compact-staging-`)).map((name) => path.join(directory, name))
    : []
  if (!fs.existsSync(dbPath)) {
    const candidate = stagingPaths
      .map((stagingPath) => ({ stagingPath, modifiedAt: fs.statSync(stagingPath).mtimeMs }))
      // mtime 同毫秒平局时按文件名降序（staging 名含 Date.now() 时间戳，后者更新）。
      .sort((left, right) => right.modifiedAt - left.modifiedAt || (left.stagingPath < right.stagingPath ? 1 : -1))[0]
    if (!candidate) return { recoveredAtSwap: false, removedStaleStaging: 0 }
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${candidate.stagingPath}${suffix}`, { force: true })
    renameWithRetry(candidate.stagingPath, dbPath)
    for (const stagingPath of stagingPaths) if (stagingPath !== candidate.stagingPath) removeStagingArtifacts(stagingPath)
    try {
      fs.writeFileSync(`${dbPath}.compact-recovery.json`,
        `${JSON.stringify({ recoveredAtSwap: true, recordedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    } catch { /* 恢复记录失败不影响换入结果。 */ }
    return { recoveredAtSwap: true, removedStaleStaging: stagingPaths.length - 1 }
  }
  for (const stagingPath of stagingPaths) removeStagingArtifacts(stagingPath)
  return { recoveredAtSwap: false, removedStaleStaging: stagingPaths.length }
}

export async function compactSessionDatabase(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: { clearProjectionCachesAfterArchive?: boolean; signal?: AbortSignal; availableBytes?: () => number; createWorker?: (workerPath: string) => Worker; workerPath?: string; watchdogTimeoutMs?: number } = {}
): Promise<CompactSessionDatabaseResult> {
  // 发布保底开关：置位时走 P4 的进程内路径（会阻塞主进程但行为完全已知）。
  if (process.env.SPACEASSISTANT_IN_PROCESS_COMPACT === '1') {
    return compactSessionDatabaseInProcess(db, userDataDir, onProgress, options)
  }
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
  const archivedDbPath = path.join(archivePath, path.basename(dbPath))
  const stagingPath = `${dbPath}.compact-staging-${Date.now()}-${randomUUID()}`
  const schemaVersionBefore = Number((conn.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version)
  const originalPages = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
  const originalFreelist = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
  let archiveVerified = false
  let phase: StorageMaintenanceProgress['phase'] = 'archive'
  try {
    ensureNotAborted()
    fs.mkdirSync(archivePath, { recursive: true, mode: 0o700 })
    onProgress?.({ phase: 'archive' })
    let workerResult!: Awaited<ReturnType<typeof runSessionMaintenanceWorker>>
    let snapshotAttempts = 0
    for (;;) {
      ensureNotAborted()
      // 防线①：换入前重查忙碌谓词（P1）；重试时同样适用。
      if (activeSessionTurnCount(db) > 0) throw maintenanceBusyError()
      removeStagingArtifacts(stagingPath)
      snapshotAttempts += 1
      let externalActivityAt = 0
      // 整理阶段真实字节进度：VACUUM INTO 在 worker 线程内同步执行，staging 文件大小由编排器轮询。
      const vacuumPoller = setInterval(() => {
        try {
          const size = fs.statSync(stagingPath).size
          externalActivityAt = Date.now()
          onProgress?.({ phase: 'vacuum', completedBytes: size, totalBytes: bytesBefore })
        } catch { /* staging 尚未创建；下一轮再试。 */ }
      }, 200)
      vacuumPoller.unref?.()
      try {
        workerResult = await runSessionMaintenanceWorker(
          { dbPath, archivePath, spillRoot, degradedSpillRoot, stagingPath },
          {
            signal: options.signal,
            createWorker: options.createWorker,
            workerPath: options.workerPath,
            watchdogTimeoutMs: options.watchdogTimeoutMs,
            onProgress: (progress) => {
              // 防线前置：worker 只有在归档 quick_check 通过后才发 vacuum 进度 → 此后失败保留归档。
              if (progress.phase === 'vacuum') archiveVerified = true
              if (phase === 'archive') phase = 'vacuum'
              onProgress?.(progress)
            },
            externalHeartbeat: () => externalActivityAt
          })
      } catch (error) {
        // worker 入口不可用（打包缺产物/tsx 引导缺失）→ 降级 P4 进程内路径；其余失败原样上抛。
        if (error instanceof StorageMaintenanceError && error.message.includes(COMPACTION_WORKER_ENTRY_UNAVAILABLE)) {
          return compactSessionDatabaseInProcess(db, userDataDir, onProgress, options)
        }
        throw error
      } finally {
        clearInterval(vacuumPoller)
      }
      // 防线②：data_version 探针——快照期间主库有提交即丢弃 staging 重做；永不换入过期数据。
      if (workerResult.dataVersionBefore !== workerResult.dataVersionAfter) {
        removeStagingArtifacts(stagingPath)
        if (snapshotAttempts >= COMPACT_SNAPSHOT_RETRY_LIMIT) {
          throw new StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY',
            'database snapshot kept changing during compaction; retry when all session turns are idle')
        }
        continue
      }
      break
    }
    phase = 'archive'
    archiveVerified = fs.statSync(archivedDbPath).size === bytesBefore &&
      directoryFileBytes(path.join(archivePath, 'spill')) === originalSpillBytes &&
      directoryFileBytes(path.join(archivePath, 'spill-degraded')) === originalDegradedSpillBytes &&
      verifySessionMaintenanceArchive(dbPath, archivePath, userDataDir, {
        dbSourceSha256: workerResult.dbSourceSha256,
        dbDestSha256: workerResult.dbDestSha256,
        spillSourceManifest: workerResult.spillSourceManifest,
        spillDegradedSourceManifest: workerResult.spillDegradedSourceManifest
      })
    if (!archiveVerified) throw new Error('database/spill archive verification failed')
    ensureNotAborted()
    const availableBytesForSwap = getAvailableBytes()
    if (availableBytesForSwap < filesBefore.dbBytes) {
      throw new StorageMaintenanceError('STORAGE_MAINTENANCE_INSUFFICIENT_SPACE',
        `database maintenance requires ${filesBefore.dbBytes} bytes for the swap working copy; ${availableBytesForSwap} bytes are available after archiving`)
    }
    phase = 'swap'
    onProgress?.({ phase: 'swap' })
    const swapStartedAt = performance.now()
    const preSwapCheckpoint = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number }
    if (preSwapCheckpoint.busy !== 0 || preSwapCheckpoint.log !== preSwapCheckpoint.checkpointed) {
      throw new Error('database WAL checkpoint is incomplete; retry storage maintenance')
    }
    db.close()
    try {
      // worker 的快照副本让位给「最终 live 文件」：close+checkpoint 后的旧库即归档副本，免一遍复制。
      fs.rmSync(archivedDbPath, { force: true })
      renameWithRetry(dbPath, archivedDbPath)
      renameWithRetry(stagingPath, dbPath)
    } catch (swapError) {
      if (!fs.existsSync(dbPath) && fs.existsSync(archivedDbPath)) renameWithRetry(archivedDbPath, dbPath)
      reopenDatabaseConnection(db)
      removeStagingArtifacts(stagingPath)
      throw swapError
    }
    reopenDatabaseConnection(db)
    const reopenedConn = getDbConnection(db)
    const pageCountAfter = Number((reopenedConn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    const freelistCountAfter = Number((reopenedConn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    const stagedSchemaVersion = Number((reopenedConn.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version)
    const quickCheck = reopenedConn.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined
    // schema_version 不做等值断言：VACUUM INTO 会递增 schema cookie，quick_check + 页数 + freelist 已足够换入校验。
    const swapVerified = quickCheck?.quick_check === 'ok' && stagedSchemaVersion >= schemaVersionBefore &&
      pageCountAfter > 0 && freelistCountAfter === 0
    if (!swapVerified) {
      db.close()
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })
      renameWithRetry(archivedDbPath, dbPath)
      reopenDatabaseConnection(db)
      throw new Error('compaction swap verification failed; restored the pre-compaction database from the archive')
    }
    const swapDurationMs = performance.now() - swapStartedAt
    // 可重建投影缓存的清理必须在换入之后：worker 的 VACUUM INTO 快照早于清理，
    // 若在换入前清理，staging 会把已清行原样带回来（归档中仍保有这些行，语义不变）。
    if (options.clearProjectionCachesAfterArchive) clearSessionProjectionCaches(db)
    db.flushSave()
    const filesAfter = sqliteFileSizes(dbPath)
    const archiveBytes = directoryFileBytes(archivePath)
    const durationMs = performance.now() - startedAt
    phase = 'complete'
    const reclaimedPages = Math.max(0, originalPages - pageCountAfter)
    onProgress?.({ phase, completedPages: reclaimedPages, remainingPages: freelistCountAfter })
    const result: CompactSessionDatabaseResult = {
      archivePath, bytesBefore, bytesAfter: filesAfter.dbBytes, reclaimedPages, durationMs,
      pageCountBefore: originalPages, pageCountAfter, freelistCountBefore: originalFreelist, freelistCountAfter,
      walBytesBefore: filesBefore.walBytes, walBytesAfter: filesAfter.walBytes,
      shmBytesBefore: filesBefore.shmBytes, shmBytesAfter: filesAfter.shmBytes,
      archiveBytes, availableBytesBefore, peakSpaceEstimateBytes, manifestPath: '',
      vacuumMode: 'full', executionTarget: 'worker', snapshotAttempts
    }
    const roundMs = (value: number) => Math.round(value * 1000) / 1000
    result.manifestPath = writeMaintenanceReport(archivePath, {
      formatVersion: 2, recordedAt: new Date().toISOString(), status: 'complete', ...result,
      stageDurationsMs: { ...workerResult.stageDurationsMs, swap: roundMs(swapDurationMs), total: roundMs(durationMs) },
      stageBytes: { archive: workerResult.archiveBytes, staging: workerResult.stagingBytes },
      archivePath: undefined,
      note: 'peakSpaceEstimateBytes is a conservative bound for the source DB, archived DB/spills and one VACUUM working copy; it is not an observed instantaneous peak.'
    })
    return result
  } catch (error) {
    removeStagingArtifacts(stagingPath)
    if (!archiveVerified) fs.rmSync(archivePath, { recursive: true, force: true })
    else {
      const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : error instanceof Error ? error.name : 'UNKNOWN_ERROR'
      try {
        writeMaintenanceReport(archivePath, { formatVersion: 2, recordedAt: new Date().toISOString(), status: 'failed', phase, failureCode,
          ...(error instanceof Error ? { failureMessage: error.message } : {}) })
      } catch { /* Preserve the verified DB/spill archive even if its failure report cannot be written. */ }
      if (error && typeof error === 'object') Object.assign(error, { archivePath, archivePreserved: true, phase })
    }
    throw error
  }
}

async function compactSessionDatabaseInProcess(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: { clearProjectionCachesAfterArchive?: boolean; signal?: AbortSignal; availableBytes?: () => number } = {}
): Promise<CompactSessionDatabaseResult> {
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
  const stageDurationsMs = { archive: 0, verify: 0, vacuum: 0 }
  try {
    phase = 'archive'
    ensureNotAborted()
    const archiveStageStartedAt = performance.now()
    fs.mkdirSync(archivePath, { recursive: true, mode: 0o700 })
    onProgress?.({ phase: 'archive' })
    const archivedDbPath = path.join(archivePath, path.basename(dbPath))
    const copyTotalBytes = bytesBefore + originalSpillBytes + originalDegradedSpillBytes
    let copiedBytes = 0
    const copyProgress = (fileCompletedBytes: number) => {
      onProgress?.({ phase: 'archive', completedBytes: copiedBytes + fileCompletedBytes, totalBytes: copyTotalBytes })
    }
    // 归档复制阶段不接 signal：取消契约是「归档验证完成后才可取消」（取消时保留归档作为恢复副本），
    // signal 仍在 phase 边界的 ensureNotAborted 生效；chunk 级 signal 供 P5 worker 路径使用。
    const dbCopy = await copyFileWithHash(dbPath, archivedDbPath, { onProgress: copyProgress })
    copiedBytes += dbCopy.bytes
    const spillEvidence: { spill?: CopyTreeWithManifestResult; spillDegraded?: CopyTreeWithManifestResult } = {}
    if (fs.existsSync(spillRoot)) {
      spillEvidence.spill = await copyTreeWithManifest(spillRoot, path.join(archivePath, 'spill'), { onProgress: copyProgress })
      copiedBytes += spillEvidence.spill.bytes
    }
    if (fs.existsSync(degradedSpillRoot)) {
      spillEvidence.spillDegraded = await copyTreeWithManifest(degradedSpillRoot, path.join(archivePath, 'spill-degraded'), { onProgress: copyProgress })
      copiedBytes += spillEvidence.spillDegraded.bytes
    }
    onProgress?.({ phase: 'archive', completedBytes: copyTotalBytes, totalBytes: copyTotalBytes })
    const verifyStageStartedAt = performance.now()
    stageDurationsMs.archive = verifyStageStartedAt - archiveStageStartedAt
    archiveVerified = fs.statSync(archivedDbPath).size === bytesBefore &&
      directoryFileBytes(path.join(archivePath, 'spill')) === originalSpillBytes &&
      directoryFileBytes(path.join(archivePath, 'spill-degraded')) === originalDegradedSpillBytes &&
      verifySessionMaintenanceArchive(dbPath, archivePath, userDataDir, {
        dbSourceSha256: dbCopy.sourceSha256,
        dbDestSha256: dbCopy.destSha256,
        spillSourceManifest: spillEvidence.spill?.sourceManifest,
        spillDegradedSourceManifest: spillEvidence.spillDegraded?.sourceManifest
      })
    if (!archiveVerified) throw new Error('database/spill archive verification failed')
    ensureNotAborted()
    const availableBytesAtVacuum = getAvailableBytes()
    if (availableBytesAtVacuum < filesBefore.dbBytes) {
      throw new StorageMaintenanceError('STORAGE_MAINTENANCE_INSUFFICIENT_SPACE',
        `database maintenance requires ${filesBefore.dbBytes} bytes for the VACUUM working copy; ${availableBytesAtVacuum} bytes are available after archiving`)
    }
    if (options.clearProjectionCachesAfterArchive) clearSessionProjectionCaches(db)
    const vacuumStageStartedAt = performance.now()
    stageDurationsMs.verify = vacuumStageStartedAt - verifyStageStartedAt
    const originalPages = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    const originalFreelist = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    const autoVacuumBefore = Number((conn.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)
    phase = 'vacuum'
    onProgress?.({ phase: 'vacuum' })
    conn.exec('PRAGMA optimize')
    let vacuumMode: StorageMaintenanceVacuumMode
    if (originalFreelist === 0) {
      // L0：无空闲页可整理，直接进入收尾。
      vacuumMode = 'none'
    } else if (autoVacuumBefore === 2 && originalFreelist / originalPages <= FULL_VACUUM_FREELIST_RATIO) {
      // L1：auto_vacuum 已为 incremental（首次 full 后永久生效）且碎片占比小 → 秒级快路径。
      vacuumMode = 'incremental'
    } else {
      // L2：现状全量 VACUUM（首跑把库转为 incremental auto_vacuum，为后续 L1 铺路）。
      vacuumMode = 'full'
      conn.exec('PRAGMA auto_vacuum=INCREMENTAL')
      conn.exec('VACUUM')
    }
    phase = 'reclaim'
    onProgress?.({ phase, completedPages: 0, remainingPages: Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count) })
    if (vacuumMode !== 'none') conn.exec('PRAGMA incremental_vacuum')
    stageDurationsMs.vacuum = performance.now() - vacuumStageStartedAt
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
      archiveBytes, availableBytesBefore, peakSpaceEstimateBytes, vacuumMode, executionTarget: 'in-process' as const, snapshotAttempts: 0 }
    const roundMs = (value: number) => Math.round(value * 1000) / 1000
    const manifestPath = writeMaintenanceReport(archivePath, {
      formatVersion: 2, recordedAt: new Date().toISOString(), status: 'complete', ...result,
      stageDurationsMs: {
        archive: roundMs(stageDurationsMs.archive),
        verify: roundMs(stageDurationsMs.verify),
        vacuum: roundMs(stageDurationsMs.vacuum),
        total: roundMs(durationMs)
      },
      stageBytes: { archive: copiedBytes },
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
        writeMaintenanceReport(archivePath, { formatVersion: 2, recordedAt: new Date().toISOString(), status: 'failed', phase, failureCode,
          ...(error instanceof Error ? { failureMessage: error.message } : {}) })
      } catch { /* Preserve the verified DB/spill archive even if its failure report cannot be written. */ }
      if (error && typeof error === 'object') Object.assign(error, { archivePath, archivePreserved: true, phase })
    }
    throw error
  }
}
