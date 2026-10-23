import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionWorkerSample } from '../../domain/projectionSource'

export type ProjectionHistoryWorkerOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: number
  workerPath?: string
  createWorker?: (workerPath: string) => Worker
}>

export function resolveProjectionHistoryWorkerPath(explicit?: string): string | undefined {
  if (explicit) return explicit
  const compiled = path.join(__dirname, 'projectionHistoryChunkWorker.js')
  const source = path.join(__dirname, 'projectionHistoryChunkWorker.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(source)) return source
  return undefined
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-projection-worker-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_PROJECTION_WORKER_ANCHOR
const target = process.env.SA_PROJECTION_WORKER_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, env: {
    ...process.env, SA_PROJECTION_WORKER_ANCHOR: anchor, SA_PROJECTION_WORKER_TARGET: workerPath,
  } })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

/** One bounded worker owns its read-only SQLite handle and is considered quiescent only after exit. */
export function readProjectionHistoryChunkInWorker(
  permit: ProjectionHistoryChunkPermit,
  input: Readonly<{ afterSessionSequence: number; maxRows: number; maxBytes: number; signal?: AbortSignal;
    staging?: Readonly<{ root: string; tempLocator: string }> }>,
  options: ProjectionHistoryWorkerOptions = {}
): Promise<ProjectionHistoryChunkResult> {
  const signal = options.signal ?? input.signal
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('PROJECTION_WORKER_CANCELLED'))
  const workerPath = resolveProjectionHistoryWorkerPath(options.workerPath)
  if (!workerPath) return Promise.reject(new Error('PROJECTION_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try { worker = options.createWorker?.(workerPath) ?? (workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })) }
  catch (error) { return Promise.reject(new Error(`PROJECTION_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`)) }

  const requestId = randomUUID()
  const timeoutMs = options.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    let result: ProjectionHistoryChunkResult | undefined
    let failure: Error | undefined
    let settled = false
    const timer = setTimeout(() => stop(new Error('PROJECTION_WORKER_TIMEOUT')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const stop = (error: Error) => {
      if (failure || settled) return
      failure = error
      void worker.terminate()
    }
    const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('PROJECTION_WORKER_CANCELLED'))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: { requestId?: string; result?: ProjectionHistoryChunkResult; workerSample?: ProjectionWorkerSample }) => {
      if (message.requestId !== requestId || !message.result) { stop(new Error('PROJECTION_WORKER_PROTOCOL_MISMATCH')); return }
      if (message.result.kind === 'staged-chunk') {
        const staged = message.result.stagedBlob
        if (!input.staging || staged.tempLocator !== input.staging.tempLocator ||
          !/^\.projection-[0-9a-f-]{36}\.tmp$/.test(staged.tempLocator) ||
          !Number.isSafeInteger(staged.byteLength) || staged.byteLength < 1 || staged.byteLength > 32 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(staged.payloadDigest) || !Number.isSafeInteger(message.result.rowCount) ||
          message.result.rowCount < 1 || message.result.rowCount > input.maxRows ||
          !Number.isSafeInteger(message.result.afterSessionSequence) || !Number.isSafeInteger(message.result.nextSessionSequence) ||
          message.result.nextSessionSequence <= message.result.afterSessionSequence ||
          message.result.nextSessionSequence - message.result.afterSessionSequence !== message.result.rowCount ||
          !Number.isSafeInteger(message.result.sourceByteLength) || message.result.sourceByteLength <= input.maxBytes ||
          message.result.sourceByteLength > 32 * 1024 * 1024 || typeof message.result.hasMore !== 'boolean') {
          stop(new Error('PROJECTION_WORKER_STAGED_RESULT_INVALID'))
          return
        }
      }
      result = { ...message.result, ...(isWorkerSample(message.workerSample) ? { workerSample: message.workerSample } : {}) }
    })
    worker.once('error', (error) => stop(error))
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0 || !result) reject(new Error(`PROJECTION_WORKER_EXIT:${code}`))
      else resolve(result)
    })
    try { worker.postMessage({ requestId, permit, input }) }
    catch (error) { stop(error instanceof Error ? error : new Error('PROJECTION_WORKER_POST_FAILED')) }
  })
}

function isWorkerSample(value: unknown): value is ProjectionWorkerSample {
  if (!value || typeof value !== 'object') return false
  const sample = value as Partial<ProjectionWorkerSample>
  return Number.isFinite(sample.durationMs) && sample.durationMs! >= 0 &&
    Number.isSafeInteger(sample.heapUsedBytesAtExit) && sample.heapUsedBytesAtExit! >= 0 &&
    Number.isSafeInteger(sample.processRssBytesAtExit) && sample.processRssBytesAtExit! >= 0 &&
    Number.isSafeInteger(sample.heapUsedBytesPeakSampled) && sample.heapUsedBytesPeakSampled! >= sample.heapUsedBytesAtExit! &&
    Number.isSafeInteger(sample.processRssBytesPeakSampled) && sample.processRssBytesPeakSampled! >= sample.processRssBytesAtExit! &&
    sample.memorySampleIntervalMs === 10
}
