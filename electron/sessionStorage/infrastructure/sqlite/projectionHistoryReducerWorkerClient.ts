import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionHistoryChunkReducerPort, ProjectionHistoryChunkReduction } from '../../application/projectionBuildCoordinator'

const MAX_REDUCER_WORKER_MS = 15_000

function resolveWorkerPath(): string | undefined {
  const compiled = path.join(__dirname, 'projectionHistoryReducerWorker.js')
  const source = path.join(__dirname, 'projectionHistoryReducerWorker.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(source)) return source
  return undefined
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-projection-reducer-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_PROJECTION_REDUCER_ANCHOR
const target = process.env.SA_PROJECTION_REDUCER_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    env: { ...process.env, SA_PROJECTION_REDUCER_ANCHOR: anchor, SA_PROJECTION_REDUCER_TARGET: workerPath },
  })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

export const reduceProjectionHistoryChunkInWorker: ProjectionHistoryChunkReducerPort =
  (stateJson: string, events: readonly ProjectionHistoryChunkEvent[], messageFacts: readonly ProjectionMessageFact[],
    scopeKey: string, finalize: boolean, signal?: AbortSignal): Promise<ProjectionHistoryChunkReduction> => {
    if (signal?.aborted) return Promise.reject(new Error('PROJECTION_REDUCER_WORKER_ABORTED'))
    const workerPath = resolveWorkerPath()
    if (!workerPath) return Promise.reject(new Error('PROJECTION_REDUCER_WORKER_ENTRY_UNAVAILABLE'))
    let worker: Worker
    try {
      worker = workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      })
    } catch (error) {
      return Promise.reject(new Error(`PROJECTION_REDUCER_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      let abortRequested = false
    let candidateError: Error | undefined
    let candidateResult: ProjectionHistoryChunkReduction | undefined
      const timer = setTimeout(() => {
        void worker.terminate().then(() => finish(new Error('PROJECTION_REDUCER_WORKER_TIMEOUT')),
          () => finish(new Error('PROJECTION_REDUCER_WORKER_TERMINATION_FAILED')))
      }, MAX_REDUCER_WORKER_MS)
      const onAbort = () => {
        abortRequested = true
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_REDUCER_WORKER_ABORT_FAILED') })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (error?: Error, result?: ProjectionHistoryChunkReduction) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(result!)
      }
    const stopWithError = (error: Error) => {
      candidateError ??= error
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_REDUCER_WORKER_TERMINATION_FAILED') })
    }
      worker.once('message', (message: { requestId?: string; error?: string; result?: ProjectionHistoryChunkReduction }) => {
      if (message.requestId !== requestId) { stopWithError(new Error('PROJECTION_REDUCER_WORKER_PROTOCOL_MISMATCH')); return }
      if (message.error) { stopWithError(new Error(message.error)); return }
        if (!message.result || typeof message.result.stateJson !== 'string' || !Array.isArray(message.result.outputOperations) ||
          (message.result.finalizedOutputOperations !== undefined && !Array.isArray(message.result.finalizedOutputOperations)) ||
          !Number.isSafeInteger(message.result.workerThreadId) || message.result.workerThreadId! <= 0) {
          stopWithError(new Error('PROJECTION_REDUCER_WORKER_RESULT_INVALID'))
          return
        }
        candidateResult = message.result
      })
      worker.once('error', (error) => { candidateError ??= new Error(`PROJECTION_REDUCER_WORKER_RUNTIME_FAILED:${error.message}`) })
      worker.once('exit', (code) => {
        if (!settled) finish(candidateError ?? (abortRequested ? new Error('PROJECTION_REDUCER_WORKER_ABORTED') :
          candidateResult && code === 0 ? undefined : new Error(`PROJECTION_REDUCER_WORKER_EXIT:${code}`)), candidateResult)
      })
      try { worker.postMessage({ requestId, stateJson, events, messageFacts, scopeKey, finalize }) }
      catch (error) { stopWithError(error instanceof Error ? error : new Error('PROJECTION_REDUCER_WORKER_POST_FAILED')) }
    })
  }
