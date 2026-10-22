import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult } from '../../domain/projectionSource'

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
  const worker = new Worker(bootstrapPath, { execArgv: [], env: {
    ...process.env, SA_PROJECTION_WORKER_ANCHOR: anchor, SA_PROJECTION_WORKER_TARGET: workerPath,
  } })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

/** One bounded worker owns its read-only SQLite handle and is considered quiescent only after exit. */
export function readProjectionHistoryChunkInWorker(
  permit: ProjectionHistoryChunkPermit,
  input: Readonly<{ afterSessionSequence: number; maxRows: number; maxBytes: number; signal?: AbortSignal }>,
  options: ProjectionHistoryWorkerOptions = {}
): Promise<ProjectionHistoryChunkResult> {
  const signal = options.signal ?? input.signal
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('PROJECTION_WORKER_CANCELLED'))
  const workerPath = resolveProjectionHistoryWorkerPath(options.workerPath)
  if (!workerPath) return Promise.reject(new Error('PROJECTION_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try { worker = options.createWorker?.(workerPath) ?? (workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath)) }
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
    worker.on('message', (message: { requestId?: string; result?: ProjectionHistoryChunkResult }) => {
      if (message.requestId !== requestId || !message.result) { stop(new Error('PROJECTION_WORKER_PROTOCOL_MISMATCH')); return }
      result = message.result
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
