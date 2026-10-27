import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { SpillDescriptor } from '../../../storage/spillProtocol'
import type { PreparedChatBodySelection } from './projectionChatBodyCacheWorkerClient'

export type ProjectionSourceBodyFragment = Readonly<{ id: string; sequence: number; locator: string; byteLength: number; sha256: string }>

function resolveWorkerPath(): string | undefined {
  const compiled = path.join(__dirname, 'projectionSourceChatBodyWorker.js')
  const source = path.join(__dirname, 'projectionSourceChatBodyWorker.ts')
  return fs.existsSync(compiled) ? compiled : fs.existsSync(source) ? source : undefined
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-projection-source-page-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_PROJECTION_SOURCE_PAGE_ANCHOR
const target = process.env.SA_PROJECTION_SOURCE_PAGE_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, env: { ...process.env,
    SA_PROJECTION_SOURCE_PAGE_ANCHOR: anchor, SA_PROJECTION_SOURCE_PAGE_TARGET: workerPath } })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

/** Reads and verifies only selected immutable body fragments off the main thread. */
export function readProjectionSourceChatBodiesInWorker(input: Readonly<{
  root: string; sessionId: string; sessionGeneration: string; sourceRevision: number
  fragments: readonly ProjectionSourceBodyFragment[]; sourceSpillRoot?: string; sourceTruthSpills: readonly SpillDescriptor[]
  expectedMessageIds: readonly string[]; timeoutMs?: number
}>): Promise<PreparedChatBodySelection> {
  const workerPath = resolveWorkerPath()
  if (!workerPath) return Promise.reject(new Error('PROJECTION_SOURCE_PAGE_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try { worker = workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }) }
  catch (error) { return Promise.reject(new Error(`PROJECTION_SOURCE_PAGE_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`)) }
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let result: PreparedChatBodySelection | undefined
    let failure: Error | undefined
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('PROJECTION_SOURCE_PAGE_WORKER_RESULT_MISSING'))
    }
    const timer = setTimeout(() => {
      failure = new Error('PROJECTION_SOURCE_PAGE_WORKER_TIMEOUT')
      void worker.terminate()
    }, input.timeoutMs ?? 30_000)
    worker.once('message', (message: { requestId?: string; error?: string; result?: { messages?: PreparedChatBodySelection['messages']; workerThreadId?: number } }) => {
      if (message?.requestId !== requestId) return
      if (message.error) { failure = new Error(message.error); return }
      const messages = message.result?.messages
      if (!Array.isArray(messages) || messages.length !== input.expectedMessageIds.length ||
        !Number.isSafeInteger(message.result?.workerThreadId) || message.result!.workerThreadId! <= 0 ||
        messages.some((item, index) => !item || item.id !== input.expectedMessageIds[index] ||
          (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !Number.isSafeInteger(item.timestamp))) {
        failure = new Error('PROJECTION_SOURCE_PAGE_WORKER_RESULT_INVALID')
        return
      }
      result = { messages, workerThreadId: message.result!.workerThreadId! }
    })
    worker.once('error', (error) => { failure = error; void worker.terminate() })
    worker.once('exit', (code) => settle(failure ?? (code === 0 ? undefined : new Error(`PROJECTION_SOURCE_PAGE_WORKER_EXIT:${code}`))))
    try { worker.postMessage({ requestId, root: input.root, sessionId: input.sessionId, sessionGeneration: input.sessionGeneration,
      sourceRevision: input.sourceRevision, fragments: input.fragments, sourceSpillRoot: input.sourceSpillRoot,
      sourceTruthSpills: input.sourceTruthSpills }) }
    catch (error) { failure = error instanceof Error ? error : new Error('PROJECTION_SOURCE_PAGE_WORKER_POST_FAILED'); void worker.terminate() }
  })
}
