import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { PreparedChatBodyView } from '../../public/model'
import { selectVerifiedChatBodyPayload } from './projectionChatBodyCachePayload'

export type PreparedChatBodySelection = Readonly<{
  messages: readonly Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>[]
  /** Zero identifies a fully verified <=256 KiB inline payload read on the caller thread. */
  workerThreadId: number
}>

const MAX_CACHE_WORKER_MS = 30_000

function resolveWorkerPath(): string | undefined {
  const compiled = path.join(__dirname, 'projectionChatBodyCacheWorker.js')
  const source = path.join(__dirname, 'projectionChatBodyCacheWorker.ts')
  return fs.existsSync(compiled) ? compiled : fs.existsSync(source) ? source : undefined
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-projection-chat-cache-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_PROJECTION_CHAT_CACHE_ANCHOR
const target = process.env.SA_PROJECTION_CHAT_CACHE_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, { execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    env: { ...process.env, SA_PROJECTION_CHAT_CACHE_ANCHOR: anchor, SA_PROJECTION_CHAT_CACHE_TARGET: workerPath } })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

export function readPreparedChatBodiesInWorker(input: Readonly<{
  root: string
  view: PreparedChatBodyView
  messageIds: readonly string[]
  signal?: AbortSignal
}>): Promise<PreparedChatBodySelection> {
  if (input.signal?.aborted) return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED'))
  if (input.view.inlinePayload !== undefined && Buffer.byteLength(input.view.inlinePayload, 'utf8') <= 256 * 1024) {
    try {
      return Promise.resolve({ messages: selectVerifiedChatBodyPayload({ payload: Buffer.from(input.view.inlinePayload, 'utf8'),
        sessionId: input.view.sessionId, sessionGeneration: input.view.sessionGeneration, scopeKey: input.view.scopeKey,
        specVersion: input.view.specVersion, sourceIdentityJson: input.view.sourceIdentityJson,
        payloadDigest: input.view.payloadDigest, validatedRangeJson: input.view.validatedRangeJson, messageIds: input.messageIds }),
      workerThreadId: 0 })
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('PROJECTION_CHAT_BODY_CACHE_INLINE_READ_FAILED')) }
  }
  const workerPath = resolveWorkerPath()
  if (!workerPath) return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try { worker = workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  }) } catch (error) {
    return Promise.reject(new Error(`PROJECTION_CHAT_BODY_CACHE_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`))
  }
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let settled = false
    let abortRequested = false
    let candidateError: Error | undefined
    let candidateResult: PreparedChatBodySelection | undefined
    const timer = setTimeout(() => {
      candidateError = new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_TIMEOUT')
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_TERMINATION_FAILED') })
    }, MAX_CACHE_WORKER_MS)
    const onAbort = () => {
      abortRequested = true
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORT_FAILED') })
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (error?: Error, result?: PreparedChatBodySelection) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(result!)
    }
    const terminateWithError = (error: Error) => {
      candidateError ??= error
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_TERMINATION_FAILED') })
    }
    worker.once('message', (message: { requestId?: string; error?: string; result?: PreparedChatBodySelection }) => {
      if (message.requestId !== requestId) { terminateWithError(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_PROTOCOL_MISMATCH')); return }
      if (message.error) { terminateWithError(new Error(message.error)); return }
      const result = message.result
      if (!result || !Array.isArray(result.messages) || result.messages.length !== input.messageIds.length ||
        !Number.isSafeInteger(result.workerThreadId) || result.workerThreadId <= 0 ||
        result.messages.some((item, index) => !item || item.id !== input.messageIds[index] ||
          (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !Number.isSafeInteger(item.timestamp))) {
        terminateWithError(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_RESULT_INVALID'))
        return
      }
      candidateResult = result
    })
    worker.once('error', (error) => { candidateError ??= error })
    worker.once('exit', (code) => {
      if (!settled) finish(candidateError ?? (abortRequested ? new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED') :
        candidateResult && code === 0 ? undefined : new Error(`PROJECTION_CHAT_BODY_CACHE_WORKER_EXIT:${code}`)), candidateResult)
    })
    try { worker.postMessage({ requestId, root: input.root, sessionId: input.view.sessionId,
      sessionGeneration: input.view.sessionGeneration, scopeKey: input.view.scopeKey, specVersion: input.view.specVersion,
      sourceIdentityJson: input.view.sourceIdentityJson, payloadDigest: input.view.payloadDigest,
      validatedRangeJson: input.view.validatedRangeJson, inlinePayload: input.view.inlinePayload,
      blobLocator: input.view.blobLocator, blobByteLength: input.view.blobByteLength, messageIds: input.messageIds }) }
    catch (error) { terminateWithError(error instanceof Error ? error : new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_POST_FAILED')) }
  })
}
