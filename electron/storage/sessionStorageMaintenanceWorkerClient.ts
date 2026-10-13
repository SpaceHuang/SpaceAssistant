import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { StorageMaintenanceError } from './storageMaintenanceError'
import type { SessionMaintenanceWorkerRequest, SessionMaintenanceWorkerResultMessage } from './sessionStorageMaintenanceWorkerProtocol'

export const COMPACTION_WATCHDOG_TIMEOUT_MS = 120_000

export type CompactionWorkerOutcome = SessionMaintenanceWorkerResultMessage

export type RunCompactionWorkerOptions = {
  signal?: AbortSignal
  /** 进度透传（archive/vacuum 阶段的真实字节）。 */
  onProgress?: (progress: { phase: 'archive' | 'vacuum'; completedBytes: number; totalBytes: number }) => void
  /** watchdog 之外的外部心跳源：返回最近一次外部活动的时间戳（如编排器 staging 轮询），0 表示无。 */
  externalHeartbeat?: () => number
  watchdogTimeoutMs?: number
  createWorker?: (workerPath: string) => Worker
  workerPath?: string
}

/** 与 storageProfileWorkerClient 同款双路径解析：优先 dist-electron 编译产物，vitest/dev 回落 .ts 源。 */
export function resolveCompactionWorkerPath(explicit?: string): string | undefined {
  if (explicit) return explicit
  const compiled = path.join(__dirname, 'sessionStorageMaintenanceWorker.js')
  const source = path.join(__dirname, 'sessionStorageMaintenanceWorker.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(source)) return source
  return undefined
}

/**
 * Source (.ts) workers need the tsx loader, but `--import=tsx` only half-works inside a worker
 * thread; boot through the anchor-driven bootstrap (见 storageProfileWorkerClient.ts 的注释)。
 * 导出供 worker 单测直拉同一条启动路径。
 */
export function spawnSessionMaintenanceSourceWorker(workerPath: string): Worker {
  let tsxCjsApiPath: string
  try {
    tsxCjsApiPath = createRequire(path.join(process.cwd(), 'package.json')).resolve('tsx/cjs/api')
  } catch (error) {
    throw new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', `tsx loader unavailable for source worker: ${error instanceof Error ? error.message : String(error)}`)
  }
  const bootstrapPath = path.join(os.tmpdir(), `sa-compaction-tsx-boot-${randomUUID()}.cjs`)
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchorRequire = createRequire(process.env.SA_TSX_ANCHOR)
anchorRequire('tsx/cjs/api').register()
const { tsImport } = anchorRequire('tsx/esm/api')
tsImport(pathToFileURL(process.env.SA_TSX_TARGET).href, pathToFileURL(process.env.SA_TSX_ANCHOR).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, {
    execArgv: [],
    env: { ...process.env, SA_TSX_ANCHOR: path.join(process.cwd(), 'package.json'), SA_TSX_TARGET: workerPath }
  })
  worker.once('exit', () => { fs.unlink(bootstrapPath, () => undefined) })
  return worker
}

/** 入口不可用的稳定标记：编排器据此降级进程内路径（其余失败一律上抛）。 */
export const COMPACTION_WORKER_ENTRY_UNAVAILABLE = 'compaction worker entry is unavailable'

export async function runSessionMaintenanceWorker(request: SessionMaintenanceWorkerRequest, options: RunCompactionWorkerOptions): Promise<CompactionWorkerOutcome> {
  if (options.signal?.aborted) throw new StorageMaintenanceError('STORAGE_MAINTENANCE_CANCELLED', 'database maintenance was cancelled')
  const workerPath = resolveCompactionWorkerPath(options.workerPath)
  if (!workerPath) throw new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', COMPACTION_WORKER_ENTRY_UNAVAILABLE)
  let worker: Worker
  try {
    worker = options.createWorker?.(workerPath) ?? (workerPath.endsWith('.ts')
      ? spawnSessionMaintenanceSourceWorker(workerPath)
      : new Worker(workerPath))
  } catch (error) {
    if (error instanceof StorageMaintenanceError && error.message.includes('tsx loader unavailable')) throw error
    throw new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', `compaction worker spawn failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const watchdogTimeoutMs = options.watchdogTimeoutMs ?? COMPACTION_WATCHDOG_TIMEOUT_MS
  let lastActivityAt = Date.now()
  const heartbeat = () => { lastActivityAt = Date.now() }
  return new Promise<CompactionWorkerOutcome>((resolve, reject) => {
    let settled = false
    let watchdog: ReturnType<typeof setInterval> | undefined
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      if (watchdog) clearInterval(watchdog)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      settle()
    }
    const fail = (error: Error) => finish(() => reject(error))
    const onAbort = () => fail(new StorageMaintenanceError('STORAGE_MAINTENANCE_CANCELLED', 'database maintenance was cancelled'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    watchdog = setInterval(() => {
      // 仅检查不自行续期：活动只能来自 worker 消息或 externalHeartbeat，否则超时即判死。
      const externalActivityAt = options.externalHeartbeat?.() ?? 0
      if (externalActivityAt > lastActivityAt) lastActivityAt = externalActivityAt
      if (Date.now() - lastActivityAt > watchdogTimeoutMs) {
        fail(new StorageMaintenanceError('STORAGE_MAINTENANCE_TIMEOUT', `compaction worker made no progress for ${watchdogTimeoutMs}ms`))
      }
    }, 1000)
    worker.on('message', (raw: unknown) => {
      const message = raw as {
        type?: string; phase?: string; completedBytes?: number; totalBytes?: number; code?: string; message?: string;
        dbSourceSha256?: string; dbDestSha256?: string; spillSourceManifest?: string[]; spillDegradedSourceManifest?: string[];
        archiveBytes?: number; stagingBytes?: number; dataVersionBefore?: number; dataVersionAfter?: number;
        stageDurationsMs?: { archive: number; verify: number; vacuum: number }
      }
      heartbeat()
      if (message.type === 'progress' && message.phase && typeof message.completedBytes === 'number' && typeof message.totalBytes === 'number') {
        try {
          options.onProgress?.({ phase: message.phase as 'archive' | 'vacuum', completedBytes: message.completedBytes, totalBytes: message.totalBytes })
        } catch (error) {
          // 消费方（编排器/测试注入）抛错必须以原错误落定，而不是被 worker 'error' 事件吞掉重包。
          fail(error instanceof Error ? error : new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', String(error)))
        }
      } else if (message.type === 'result') {
        finish(() => resolve({
          type: 'result',
          dbSourceSha256: message.dbSourceSha256!,
          dbDestSha256: message.dbDestSha256!,
          spillSourceManifest: message.spillSourceManifest!,
          spillDegradedSourceManifest: message.spillDegradedSourceManifest!,
          archiveBytes: message.archiveBytes!,
          stagingBytes: message.stagingBytes!,
          dataVersionBefore: message.dataVersionBefore!,
          dataVersionAfter: message.dataVersionAfter!,
          stageDurationsMs: message.stageDurationsMs!
        }))
      } else if (message.type === 'error') {
        fail(new StorageMaintenanceError(message.code ?? 'STORAGE_MAINTENANCE_FAILED', message.message ?? 'compaction worker failed'))
      }
    })
    worker.once('error', (error) => fail(new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', error.message)))
    worker.once('exit', (code) => {
      if (!settled) fail(new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', `compaction worker exited with code ${code}`))
    })
    worker.postMessage(request)
  })
}
