import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import type { Worker } from 'node:worker_threads'
import type { AppDatabase } from '../database'
import { getDbConnection, reopenDatabaseConnection, setDatabaseSaveSuspended } from '../database/sqliteStore'
import { clearSessionProjectionCaches } from './sessionProjectionCacheMaintenance'
import { StorageMaintenanceError } from './storageMaintenanceError'
import { copyFileWithHash, copyTreeWithManifest } from './streamingCopy'
import type { CopyTreeWithManifestResult } from './streamingCopy'
import { runSessionMaintenanceWorker, COMPACTION_WORKER_ENTRY_UNAVAILABLE } from './sessionStorageMaintenanceWorkerClient'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { pruneSessionArchives } from './sessionArchiveRetention'
import { sqlActiveTurnPredicate } from '../sessionStorage/domain/turnState'

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
    (SELECT COUNT(*) FROM turns WHERE ${sqlActiveTurnPredicate()}) +
    (SELECT COUNT(*) FROM messages WHERE status IN ('queued','streaming')) AS count`).get() as { count: number }).count)
}

/** 压缩失败的统一日志：失败点（phase）+ 稳定错误码 + 原因消息；经 logAgentEvent 统一脱敏。 */
function logCompactFailure(target: 'worker' | 'in-process', phase: string, error: unknown): void {
  const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : error instanceof Error ? error.name : 'UNKNOWN_ERROR'
  logAgentEvent('warn', 'storage.maintenance.compact_failed', {
    executionTarget: target, phase, errorCode: failureCode,
    reason: error instanceof Error ? error.message : String(error)
  })
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

/** 换入前快照窗口探测：主库 size/mtime 与 WAL size 的变化等价于窗口内发生了提交。 */
function liveDatabaseFileSnapshot(dbPath: string): { dbSize: number; dbMtimeMs: number; walSize: number } {
  const stat = fs.statSync(dbPath)
  const wal = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`) : undefined
  return { dbSize: stat.size, dbMtimeMs: stat.mtimeMs, walSize: wal?.size ?? 0 }
}

function liveDatabaseFileChanged(before: ReturnType<typeof liveDatabaseFileSnapshot>, after: ReturnType<typeof liveDatabaseFileSnapshot>): boolean {
  // WAL 的 mtime 在空 checkpoint 时也会刷新，只比较 size；主库 size/mtime 任一变化即视为有提交。
  return before.dbSize !== after.dbSize || before.dbMtimeMs !== after.dbMtimeMs || before.walSize !== after.walSize
}

/**
 * 启动对账：清理崩溃遗留的压缩 staging；live 缺失且 staging 在时完成换入（rename 原子性保证不存在半截 live）。
 * 必须在 openDatabase 之前调用——DatabaseSync 打开不存在的路径会静默建空库。
 */
export function reconcileInterruptedCompaction(dbPath: string): { recoveredAtSwap: boolean; removedStaleStaging: number } {
  const directory = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const allStagingNames = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.startsWith(`${base}.compact-staging-`))
    : []
  // 候选排除 staging 自身的 -wal/-shm 副作用文件——live 缺失时把它们 rename 成主库是灾难（评审 P2-1）；
  // 排除后成为孤儿的副作用文件仍须清理（removeSidecarFiles）。
  const stagingPaths = allStagingNames
    .filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
    .map((name) => path.join(directory, name))
  const removeSidecarFiles = () => {
    for (const name of allStagingNames) {
      if (name.endsWith('-wal') || name.endsWith('-shm')) fs.rmSync(path.join(directory, name), { force: true })
    }
  }
  if (!fs.existsSync(dbPath)) {
    const candidate = stagingPaths
      .map((stagingPath) => ({ stagingPath, modifiedAt: fs.statSync(stagingPath).mtimeMs }))
      // mtime 同毫秒平局时按文件名降序（staging 名含 Date.now() 时间戳，后者更新）。
      .sort((left, right) => right.modifiedAt - left.modifiedAt || (left.stagingPath < right.stagingPath ? 1 : -1))[0]
    if (!candidate) {
      removeSidecarFiles()
      return { recoveredAtSwap: false, removedStaleStaging: 0 }
    }
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${candidate.stagingPath}${suffix}`, { force: true })
    renameWithRetry(candidate.stagingPath, dbPath)
    for (const stagingPath of stagingPaths) if (stagingPath !== candidate.stagingPath) removeStagingArtifacts(stagingPath)
    removeSidecarFiles()
    try {
      fs.writeFileSync(`${dbPath}.compact-recovery.json`,
        `${JSON.stringify({ recoveredAtSwap: true, recordedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    } catch { /* 恢复记录失败不影响换入结果。 */ }
    return { recoveredAtSwap: true, removedStaleStaging: stagingPaths.length - 1 }
  }
  for (const stagingPath of stagingPaths) removeStagingArtifacts(stagingPath)
  removeSidecarFiles()
  return { recoveredAtSwap: false, removedStaleStaging: stagingPaths.length }
}

export type CompactSessionDatabaseOptions = {
  clearProjectionCachesAfterArchive?: boolean
  signal?: AbortSignal
  availableBytes?: () => number
  createWorker?: (workerPath: string) => Worker
  workerPath?: string
  watchdogTimeoutMs?: number
  /** 测试注入：归档 prune 实现（生产用 pruneSessionArchives）。 */
  pruneArchives?: (userDataDir: string, options: { protect?: string }) => Promise<unknown>
  /** 测试注入：wrapper 等待 prune 完成以保证断言确定性；生产路径 fire-and-forget 不等待。 */
  awaitArchivePrune?: boolean
}

async function compactSessionDatabaseImpl(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: CompactSessionDatabaseOptions = {}
): Promise<CompactSessionDatabaseResult> {
  // 发布保底开关：置位时走 P4 的进程内路径（会阻塞主进程但行为完全已知）。
  if (process.env.SPACEASSISTANT_IN_PROCESS_COMPACT === '1') {
    return compactSessionDatabaseInProcess(db, userDataDir, onProgress, options)
  }
  const startedAt = performance.now()
  if (activeSessionTurnCount(db) > 0) throw maintenanceBusyError()
  logAgentEvent('info', 'storage.maintenance.compact', { executionTarget: 'worker', stage: 'start' })
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
    // 每次尝试开始前复位上一轮的 worker 结果：stale/可重试失败的 continue 依赖本守卫区分
    // 「worker 失败重试」与「worker 成功待复核」，残留上一轮成功结果会让守卫失效，
    // 用上一轮的双侧哈希证据去复核本轮失败后的现场（评审 P1：成功→stale→失败 双故障序列）。
    let workerResult: Awaited<ReturnType<typeof runSessionMaintenanceWorker>> | undefined
    let snapshotAttempts = 0
    const readMainDataVersion = () => Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
    for (;;) {
      ensureNotAborted()
      if (activeSessionTurnCount(db) > 0) throw maintenanceBusyError()
      workerResult = undefined
      // B1：每次尝试从零开始。worker 复制以 'wx' 独占创建，归档残留会让第二次尝试必撞 EEXIST；
      // 归档尚未通过换入前证据复核，清理不违反「已验证归档保留」语义（archiveVerified 随之复位）。
      removeStagingArtifacts(stagingPath)
      fs.rmSync(archivePath, { recursive: true, force: true })
      fs.mkdirSync(archivePath, { recursive: true, mode: 0o700 })
      archiveVerified = false
      snapshotAttempts += 1
      // 快照窗口基线：flushSave 先把防抖写入落盘，避免把自身待检查点误报为窗口写入。
      db.flushSave()
      const windowSnapshotBefore = liveDatabaseFileSnapshot(dbPath)
      const mainDataVersionBefore = readMainDataVersion()
      let externalActivityAt = 0
      let lastPolledStagingSize = -1
      // 整理阶段真实字节进度：VACUUM INTO 在 worker 线程内同步执行，staging 文件大小由编排器轮询。
      // B2：仅当 staging 字节增长才刷新 watchdog 心跳——「staging 已建但停止增长」的卡死必须能触发 terminate。
      const vacuumPoller = setInterval(() => {
        try {
          const size = fs.statSync(stagingPath).size
          if (size === lastPolledStagingSize) return
          lastPolledStagingSize = size
          externalActivityAt = Date.now()
          onProgress?.({ phase: 'vacuum', completedBytes: size, totalBytes: bytesBefore })
        } catch { /* staging 尚未创建；下一轮再试。 */ }
      }, 200)
      vacuumPoller.unref?.()
      // 挂起防抖 checkpoint：worker 复制主库的数秒窗口内主文件必须零变化，
      // 否则并发 checkpoint 会把副本撕成新旧混合页（真机实测：quick_check 拒收 + 用户手动重试）。
      setDatabaseSaveSuspended(db, true)
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
          // N3：降级前清掉本轮归档目录（进程内路径会另建自己的归档目录）。
          fs.rmSync(archivePath, { recursive: true, force: true })
          logAgentEvent('warn', 'storage.maintenance.compact', { executionTarget: 'worker', stage: 'degraded-to-in-process' })
          return compactSessionDatabaseInProcess(db, userDataDir, onProgress, options)
        }
        // 归档副本 quick_check 被拒（复制窗口竞态兜底；挂起 checkpoint 已消除主因）→ 计数内自动重试。
        const retryableArchiveVerify = error instanceof Error &&
          error.message.includes('archived database failed quick_check') &&
          snapshotAttempts < COMPACT_SNAPSHOT_RETRY_LIMIT
        if (!retryableArchiveVerify) throw error
        removeStagingArtifacts(stagingPath)
        fs.rmSync(archivePath, { recursive: true, force: true })
        archiveVerified = false
      } finally {
        setDatabaseSaveSuspended(db, false)
        clearInterval(vacuumPoller)
      }
      if (!workerResult) continue
      // 防线②（worker 返回后立即复核）：worker 内部 data_version 探针覆盖其自身 vacuum 窗口，
      // 主库文件快照 + 主连接 data_version 覆盖「spawn 前到 worker 返回」的窗口——
      // 任一变化即丢弃 staging 与归档重做，重做读到的快照已包含该写入；永不换入过期快照。
      db.flushSave()
      const staleSnapshot = workerResult.dataVersionBefore !== workerResult.dataVersionAfter ||
        liveDatabaseFileChanged(windowSnapshotBefore, liveDatabaseFileSnapshot(dbPath)) ||
        readMainDataVersion() !== mainDataVersionBefore
      if (staleSnapshot) {
        removeStagingArtifacts(stagingPath)
        fs.rmSync(archivePath, { recursive: true, force: true })
        // 归档已删除：达到上限报错时不得谎报 archivePreserved（评审 P2-6）。
        archiveVerified = false
        if (snapshotAttempts >= COMPACT_SNAPSHOT_RETRY_LIMIT) {
          throw new StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY',
            'database snapshot kept changing during compaction; retry when all session turns are idle')
        }
        continue
      }
      // 归档证据复核（主线程同步秒级；期间的新提交由下方换入前最终复核兜住）。
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
      // 防线①（换入前最终复核，B3）：紧贴临界区。复核期间（含归档 quick_check 全量扫描）落库的
      // 任何提交——含忙碌谓词拦不住的 appendMessage 类同连接写入——都会改变文件快照或 data_version，
      // 在此拦截并重做；重做读到的快照已包含该写入。
      db.flushSave()
      const staleBeforeSwap = liveDatabaseFileChanged(windowSnapshotBefore, liveDatabaseFileSnapshot(dbPath)) ||
        readMainDataVersion() !== mainDataVersionBefore
      if (staleBeforeSwap || activeSessionTurnCount(db) > 0) {
        removeStagingArtifacts(stagingPath)
        fs.rmSync(archivePath, { recursive: true, force: true })
        archiveVerified = false
        if (snapshotAttempts >= COMPACT_SNAPSHOT_RETRY_LIMIT) {
          throw new StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY',
            'database changed while the swap was being prepared; retry when all session turns are idle')
        }
        continue
      }
      break
    }
    phase = 'swap'
    onProgress?.({ phase: 'swap' })
    const swapStartedAt = performance.now()
    // 写栅栏：BEGIN IMMEDIATE 阻塞其它连接提交，把「最终复核 → close」的残余窗口压到同语句级；
    // 空写事务 COMMIT 不产生任何变更。栅栏获取失败说明有并发写入者，按忙碌处理（保留归档）。
    // 注：此处刻意不走 runInTransaction——这不是业务事务，而是跨连接的换入临界区写栅栏，
    // 空事务必须立即 COMMIT 释放写锁，事务包装器的语义（嵌套/长持锁）在此不适用。
    try {
      conn.exec('BEGIN IMMEDIATE')
      conn.exec('COMMIT')
    } catch (fenceError) {
      throw new StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY',
        `could not take the pre-swap write fence: ${fenceError instanceof Error ? fenceError.message : String(fenceError)}`)
    }
    const preSwapCheckpoint = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number }
    if (preSwapCheckpoint.busy !== 0 || preSwapCheckpoint.log !== preSwapCheckpoint.checkpointed) {
      throw new Error('database WAL checkpoint is incomplete; retry storage maintenance')
    }
    try {
      db.close()
    } catch (closeError) {
      // N4：close 抛错也必须尽力恢复连接可用性，否则全部持有方挂到重启。
      // 已知盲区（低概率）：若抛错发生在 arm 之前的 flushNow/checkpoint 阶段，旧 conn 未武装
      // 旧连接哨兵且可能仍打开——换入后旧 conn 会静默读写旧文件句柄，不触发哨兵打点。
      try { reopenDatabaseConnection(db) } catch { /* 连接不可恢复时保持关闭，仅上抛 */ }
      throw closeError
    }
    try {
      // worker 的快照副本让位给「最终 live 文件」：close+checkpoint 后的旧库即归档副本，免一遍复制。
      fs.rmSync(archivedDbPath, { force: true })
      renameWithRetry(dbPath, archivedDbPath)
      renameWithRetry(stagingPath, dbPath)
    } catch (swapError) {
      // 回滚 rename 失败时 live 缺失、归档 DB 是压缩前唯一完好副本：复位 archiveVerified 会让外层
      // catch 删除归档（数据丢失），reopen 会对缺失路径静默建空库——两者都必须以「live 真正恢复」为前提。
      let liveRestored = fs.existsSync(dbPath)
      if (!liveRestored && fs.existsSync(archivedDbPath)) {
        try {
          renameWithRetry(archivedDbPath, dbPath)
          liveRestored = fs.existsSync(dbPath)
        } catch { /* 回滚 rename 失败不掩盖原 swapError（评审跟进 P1） */ }
      }
      if (liveRestored) {
        // 归档 DB 已移回 live（空心归档）：外层 catch 不得按已验证归档保留（评审 P2-3）。
        archiveVerified = false
        try { reopenDatabaseConnection(db) } catch { /* 连接不可恢复时保持关闭，仅上抛 */ }
      }
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
      // 同上：回滚 rename 失败时归档是唯一完好副本，归档保护与 reopen 都以 live 恢复为前提（评审跟进 P1）。
      let liveRestored = false
      try {
        renameWithRetry(archivedDbPath, dbPath)
        liveRestored = fs.existsSync(dbPath)
      } catch { /* 回滚 rename 失败：验证失败继续上抛 */ }
      if (liveRestored) {
        // 归档 DB 已移回 live（空心归档）：外层 catch 不得按已验证归档保留（评审 P2-3）。
        archiveVerified = false
        try { reopenDatabaseConnection(db) } catch { /* 连接不可恢复时保持关闭，仅上抛 */ }
      }
      throw new Error('compaction swap verification failed; restored the pre-compaction database from the archive')
    }
    const swapDurationMs = performance.now() - swapStartedAt
    // N2：VACUUM INTO 即全量重建，vacuumMode 如实报 'full'；staging 继承源库 auto_vacuum，
    // 非空库上该 pragma 需 VACUUM 才能生效（实测），legacy 库由进程内回退路径首次运行时经 L2 转换。
    // 可重建投影缓存的清理必须在换入之后：worker 的 VACUUM INTO 快照早于清理，
    // 若在换入前清理，staging 会把已清行原样带回来（归档中仍保有这些行，语义不变）。
    if (options.clearProjectionCachesAfterArchive) await clearSessionProjectionCaches(db)
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
    logAgentEvent('info', 'storage.maintenance.compact', {
      executionTarget: 'worker', stage: 'complete', durationMs: Math.round(durationMs),
      vacuumMode: 'full', snapshotAttempts, bytesBefore, bytesAfter: filesAfter.dbBytes
    })
    return result
  } catch (error) {
    logCompactFailure('worker', phase, error)
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

/**
 * 压缩入口（归档保留策略的结构性单点，N3）：三条成功路径（worker / 降级 / 进程内）都从 impl 返回
 * 含 archivePath 的结果，wrapper 在成功后 fire-and-forget prune（rejected 不 prune）。
 * 同时覆盖两个调用方：IPC storage:compact（withMaintenance 租约内）与 runSafeDbMaintenance
 * （直调、绕过租约——并发安全由 sessionArchiveRetention 的宽限期设计兜住，不依赖租约）。
 */
export async function compactSessionDatabase(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: CompactSessionDatabaseOptions = {}
): Promise<CompactSessionDatabaseResult> {
  const result = await compactSessionDatabaseImpl(db, userDataDir, onProgress, options)
  const prune = options.pruneArchives ?? pruneSessionArchives
  // pruneSessionArchives 本身不抛错；catch 防御注入实现的意外失败成为未处理拒绝。
  const pending = Promise.resolve().then(() => prune(userDataDir, { protect: result.archivePath })).catch(() => undefined)
  if (options.awaitArchivePrune) await pending
  return result
}

async function compactSessionDatabaseInProcess(
  db: AppDatabase,
  userDataDir: string,
  onProgress?: (progress: StorageMaintenanceProgress) => void,
  options: { clearProjectionCachesAfterArchive?: boolean; signal?: AbortSignal; availableBytes?: () => number } = {}
): Promise<CompactSessionDatabaseResult> {
  const startedAt = performance.now()
  if (activeSessionTurnCount(db) > 0) throw maintenanceBusyError()
  logAgentEvent('info', 'storage.maintenance.compact', { executionTarget: 'in-process', stage: 'start' })
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
    if (options.clearProjectionCachesAfterArchive) await clearSessionProjectionCaches(db)
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
    logAgentEvent('info', 'storage.maintenance.compact', {
      executionTarget: 'in-process', stage: 'complete', durationMs: Math.round(durationMs),
      vacuumMode, snapshotAttempts: 0, bytesBefore, bytesAfter: filesAfter.dbBytes
    })
    return { ...result, manifestPath }
  } catch (error) {
    logCompactFailure('in-process', phase, error)
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
