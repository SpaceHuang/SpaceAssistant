import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { StorageAudit, StorageOverview } from '../../src/shared/storageTypes'

export type StorageProfileWorkerRequest = Readonly<{ type: 'overview' | 'audit'; dbPath: string }>
export type StorageProfileWorkerResponse = Readonly<{ type: 'overview'; result: StorageOverview } | { type: 'audit'; result: StorageAudit }>
export class StorageProfileWorkerError extends Error {
  constructor(readonly code: 'STORAGE_PROFILE_TIMEOUT' | 'STORAGE_PROFILE_WORKER_ERROR' | 'STORAGE_PROFILE_WORKER_EXIT', message: string = code) {
    super(message)
    this.name = 'StorageProfileWorkerError'
  }
}

export type StorageProfileWorkerOptions = Readonly<{
  timeoutMs?: number
  signal?: AbortSignal
  createWorker?: (workerPath: string) => Worker
  workerPath?: string
}>

function resolveWorkerPath(explicit?: string) {
  if (explicit) return explicit
  const compiled = path.join(__dirname, 'storageProfileWorker.js')
  const source = path.join(__dirname, 'storageProfileWorker.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(source)) return source
  throw new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_ERROR', 'storage profile worker entry is unavailable')
}

/**
 * Source (.ts) workers need the tsx loader, but `--import=tsx` only half-works inside a worker
 * thread: the ESM hook engages, while the transpiled CJS require graph (extensionless relative
 * imports) resolves with plain Node semantics and fails (Linux/Node 22 实证；进程级同一套 flag 却
 * 正常). The thread therefore boots through this anchor-driven bootstrap: tsx is resolved from
 * the project anchor via createRequire, both loader hooks are registered in-thread, and the
 * worker module is loaded through tsImport. Compiled (.js) workers in production never take
 * this path.
 */
const TSX_WORKER_BOOTSTRAP = `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchorRequire = createRequire(process.env.SA_TSX_ANCHOR)
anchorRequire('tsx/cjs/api').register()
const { tsImport } = anchorRequire('tsx/esm/api')
tsImport(pathToFileURL(process.env.SA_TSX_TARGET).href, pathToFileURL(process.env.SA_TSX_ANCHOR).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`

function spawnSourceWorkerTsx(workerPath: string): Worker {
  let tsxCjsApiPath: string
  try {
    tsxCjsApiPath = createRequire(path.join(process.cwd(), 'package.json')).resolve('tsx/cjs/api')
  } catch (error) {
    throw new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_ERROR', `tsx loader unavailable for source worker: ${error instanceof Error ? error.message : String(error)}`)
  }
  const bootstrapPath = path.join(os.tmpdir(), `sa-tsx-worker-boot-${randomUUID()}.cjs`)
  fs.writeFileSync(bootstrapPath, TSX_WORKER_BOOTSTRAP)
  const worker = new Worker(bootstrapPath, {
    execArgv: [],
    env: { ...process.env, SA_TSX_ANCHOR: path.join(process.cwd(), 'package.json'), SA_TSX_TARGET: workerPath }
  })
  worker.once('exit', () => { fs.unlink(bootstrapPath, () => undefined) })
  return worker
}

/** Resolve only after the thread has actually exited, so callers may treat settlement as drained. */
export function runStorageProfileWorker(request: StorageProfileWorkerRequest, options: StorageProfileWorkerOptions = {}): Promise<StorageProfileWorkerResponse> {
  if (options.signal?.aborted) return Promise.reject(new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_EXIT', 'storage profile task cancelled'))
  const workerPath = resolveWorkerPath(options.workerPath)
  const worker = options.createWorker?.(workerPath) ?? (workerPath.endsWith('.ts')
    ? spawnSourceWorkerTsx(workerPath)
    : new Worker(workerPath))
  const id = randomUUID()
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise((resolve, reject) => {
    let response: StorageProfileWorkerResponse | undefined
    let failure: StorageProfileWorkerError | undefined
    let terminating = false
    const timer = setTimeout(() => terminate(new StorageProfileWorkerError('STORAGE_PROFILE_TIMEOUT')), timeoutMs)
    const onAbort = () => terminate(new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_EXIT', 'storage profile task cancelled'))
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      worker.removeAllListeners('message')
      worker.removeAllListeners('error')
      worker.removeAllListeners('exit')
    }
    const terminate = (error: StorageProfileWorkerError) => {
      if (terminating) return
      terminating = true
      failure = error
      void worker.terminate().catch(() => undefined)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: { id?: string; type?: 'overview' | 'audit'; result?: StorageOverview | StorageAudit; error?: string }) => {
      if (message?.id !== id) return
      if (message.error) { terminate(new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_ERROR')); return }
      if ((message.type === 'overview' || message.type === 'audit') && message.result) {
        response = message.type === 'overview'
          ? { type: 'overview', result: message.result as StorageOverview }
          : { type: 'audit', result: message.result as StorageAudit }
      }
    })
    worker.once('error', (error) => { terminate(new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_ERROR', error.message)) })
    worker.once('exit', (code) => {
      cleanup()
      if (failure) reject(failure)
      else if (response && code === 0) resolve(response)
      else reject(new StorageProfileWorkerError('STORAGE_PROFILE_WORKER_EXIT'))
    })
    worker.postMessage({ ...request, id })
  })
}
