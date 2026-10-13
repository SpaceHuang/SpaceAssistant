import fs from 'node:fs'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { copyFileWithHash, copyTreeWithManifest, directoryBytes } from './streamingCopy'
import type { SessionMaintenanceWorkerRequest, SessionMaintenanceWorkerResultMessage } from './sessionStorageMaintenanceWorkerProtocol'
import type { SessionMaintenanceWorkerPhase } from './sessionStorageMaintenanceWorkerProtocol'

if (!parentPort) throw new Error('session storage maintenance worker requires a parent port')

const PROGRESS_THROTTLE_MS = 100
const PROGRESS_THROTTLE_BYTES = 8 * 1024 * 1024

function quickCheckOk(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    return rows.length === 1 && rows[0]?.quick_check === 'ok'
  } finally { db.close() }
}

function readDataVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
}

async function runWorkerCompaction(request: SessionMaintenanceWorkerRequest): Promise<SessionMaintenanceWorkerResultMessage> {
  const startedAt = performance.now()
  const stageDurationsMs = { archive: 0, verify: 0, vacuum: 0 }
  fs.mkdirSync(request.archivePath, { recursive: true, mode: 0o700 })
  const dbBytes = fs.statSync(request.dbPath).size
  const copyTotalBytes = dbBytes + directoryBytes(request.spillRoot) + directoryBytes(request.degradedSpillRoot)
  let copiedBytes = 0
  let lastPostedAt = 0
  let lastPostedBytes = 0
  const post = (phase: SessionMaintenanceWorkerPhase, completedBytes: number, totalBytes: number) => {
    parentPort!.postMessage({ type: 'progress', phase, completedBytes, totalBytes })
    lastPostedAt = performance.now()
    lastPostedBytes = completedBytes
  }
  const throttledPost = (phase: SessionMaintenanceWorkerPhase, completedBytes: number, totalBytes: number) => {
    const now = performance.now()
    if (now - lastPostedAt >= PROGRESS_THROTTLE_MS || completedBytes - lastPostedBytes >= PROGRESS_THROTTLE_BYTES) {
      post(phase, completedBytes, totalBytes)
    }
  }

  const archiveStageStartedAt = performance.now()
  const archivedDbPath = path.join(request.archivePath, path.basename(request.dbPath))
  const copyProgress = (fileCompletedBytes: number) => throttledPost('archive', copiedBytes + fileCompletedBytes, copyTotalBytes)
  const dbCopy = await copyFileWithHash(request.dbPath, archivedDbPath, { onProgress: copyProgress })
  copiedBytes += dbCopy.bytes
  let spillSourceManifest: string[] = []
  let spillDegradedSourceManifest: string[] = []
  if (fs.existsSync(request.spillRoot)) {
    const copied = await copyTreeWithManifest(request.spillRoot, path.join(request.archivePath, 'spill'), { onProgress: copyProgress })
    copiedBytes += copied.bytes
    spillSourceManifest = copied.sourceManifest
  }
  if (fs.existsSync(request.degradedSpillRoot)) {
    const copied = await copyTreeWithManifest(request.degradedSpillRoot, path.join(request.archivePath, 'spill-degraded'), { onProgress: copyProgress })
    copiedBytes += copied.bytes
    spillDegradedSourceManifest = copied.sourceManifest
  }
  post('archive', copyTotalBytes, copyTotalBytes)
  const verifyStageStartedAt = performance.now()
  stageDurationsMs.archive = verifyStageStartedAt - archiveStageStartedAt

  // 归档校验（quick_check 单遍结构兜底；字节恒等由双侧哈希清单承担）
  if (!quickCheckOk(archivedDbPath)) throw Object.assign(new Error('archived database failed quick_check'), { code: 'STORAGE_MAINTENANCE_FAILED' })
  stageDurationsMs.verify = performance.now() - verifyStageStartedAt

  // 只读连接 + data_version 探针 + VACUUM INTO（staging 先确保不存在）
  const vacuumStageStartedAt = performance.now()
  if (fs.existsSync(request.stagingPath)) fs.rmSync(request.stagingPath, { force: true })
  const source = new DatabaseSync(request.dbPath, { readOnly: true })
  try {
    const dataVersionBefore = readDataVersion(source)
    post('vacuum', 0, dbBytes)
    source.exec(`VACUUM INTO '${request.stagingPath.replace(/'/g, "''")}'`)
    const dataVersionAfter = readDataVersion(source)
    stageDurationsMs.vacuum = performance.now() - vacuumStageStartedAt
    const stagingBytes = fs.statSync(request.stagingPath).size
    if (!quickCheckOk(request.stagingPath)) throw Object.assign(new Error('compacted staging database failed quick_check'), { code: 'STORAGE_MAINTENANCE_FAILED' })
    post('vacuum', stagingBytes, Math.max(dbBytes, stagingBytes))
    return {
      type: 'result',
      dbSourceSha256: dbCopy.sourceSha256,
      dbDestSha256: dbCopy.destSha256,
      spillSourceManifest,
      spillDegradedSourceManifest,
      archiveBytes: directoryBytes(request.archivePath),
      stagingBytes,
      dataVersionBefore,
      dataVersionAfter,
      stageDurationsMs: {
        archive: Math.round(stageDurationsMs.archive * 1000) / 1000,
        verify: Math.round(stageDurationsMs.verify * 1000) / 1000,
        vacuum: Math.round(stageDurationsMs.vacuum * 1000) / 1000
      }
    }
  } finally { source.close() }
}

parentPort.on('message', (request: SessionMaintenanceWorkerRequest) => {
  runWorkerCompaction(request)
    .then((result) => parentPort!.postMessage(result))
    .catch((error: unknown) => {
      // 只透传本域稳定码；SQLite/IO 的底层 code（如 ERR_SQLITE_ERROR）一律收敛为通用失败码。
      const rawCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined
      const code = rawCode && rawCode.startsWith('STORAGE_MAINTENANCE_') ? rawCode : 'STORAGE_MAINTENANCE_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      parentPort!.postMessage({ type: 'error', code, message })
    })
})
