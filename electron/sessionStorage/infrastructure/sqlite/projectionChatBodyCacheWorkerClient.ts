import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { PreparedChatBodyView } from '../../public/model'
import { searchVerifiedChatBodyPayload, selectVerifiedChatBodyPayload } from './projectionChatBodyCachePayload'
import type { SpillDescriptor } from '../../../storage/spillProtocol'

export type PreparedChatBodySelection = Readonly<{
  messages: readonly Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>[]
  /** Zero identifies a fully verified <=256 KiB inline payload read on the caller thread. */
  workerThreadId: number
}>
export type PreparedChatBodySearch = PreparedChatBodySelection

const MAX_CACHE_WORKER_MS = 30_000
const MAX_CHAT_BODY_SEARCH_RESULTS = 10_000
const pendingSearchRequests = new Map<string, Readonly<{
  resolve(value: PreparedChatBodySearch): void; reject(error: Error): void; timer: NodeJS.Timeout
  operation: 'select' | 'search'; limit?: number; messageIds?: readonly string[]
}>>()
let preparedSearchWorker: Worker | undefined

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
  sourceSpillRoot?: string
  sourceTruthSpills?: readonly SpillDescriptor[]
  view: PreparedChatBodyView
  messageIds: readonly string[]
  signal?: AbortSignal
}>): Promise<PreparedChatBodySelection> {
  return !input.sourceTruthSpills?.length && input.view.inlinePayload !== undefined
    ? readPreparedChatBodyCache({ ...input, operation: 'select' })
    : readWithPreparedCacheWorker({ ...input, operation: 'select' })
}

/** Search a verified prepared snapshot, returning only bounded matches from the cache worker. */
export function searchPreparedChatBodiesInWorker(input: Readonly<{
  root: string
  sourceSpillRoot?: string
  sourceTruthSpills?: readonly SpillDescriptor[]
  view: PreparedChatBodyView
  query: string
  limit: number
  signal?: AbortSignal
}>): Promise<PreparedChatBodySearch> {
  return !input.sourceTruthSpills?.length && input.view.inlinePayload !== undefined
    ? readPreparedChatBodyCache({ ...input, operation: 'search' })
    : readWithPreparedCacheWorker({ ...input, operation: 'search' })
}

function readWithPreparedCacheWorker(input: Readonly<{
  root: string; sourceSpillRoot?: string; sourceTruthSpills?: readonly SpillDescriptor[]
  view: PreparedChatBodyView; operation: 'select' | 'search'; query?: string; limit?: number; messageIds?: readonly string[]; signal?: AbortSignal
}>): Promise<PreparedChatBodySearch> {
  if (input.signal?.aborted) return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED'))
  const workerPath = path.join(__dirname, 'projectionChatBodyCacheSearchWorker.js')
  const sourcePath = path.join(__dirname, 'projectionChatBodyCacheSearchWorker.ts')
  const resolvedPath = fs.existsSync(workerPath) ? workerPath : fs.existsSync(sourcePath) ? sourcePath : undefined
  if (!resolvedPath) return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ENTRY_UNAVAILABLE'))
  try {
    if (!preparedSearchWorker) {
      const worker = resolvedPath.endsWith('.ts') ? spawnSourceWorker(resolvedPath) : new Worker(resolvedPath, {
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
      })
      preparedSearchWorker = worker
      worker.on('message', (message: { requestId?: string; error?: string; result?: PreparedChatBodySearch }) => {
        if (!message || typeof message.requestId !== 'string') return
        const pending = pendingSearchRequests.get(message.requestId)
        if (!pending) return
        pendingSearchRequests.delete(message.requestId)
        clearTimeout(pending.timer)
        if (message.error) { pending.reject(new Error(message.error)); return }
        const result = message.result
        if (!result || !Array.isArray(result.messages) ||
          (pending.operation === 'search' && result.messages.length > Math.max(0, pending.limit ?? 0)) ||
          (pending.operation === 'select' && result.messages.length !== pending.messageIds?.length) ||
          !Number.isSafeInteger(result.workerThreadId) || result.workerThreadId <= 0 ||
          result.messages.some((item, index) => !item || typeof item.id !== 'string' || !item.id ||
            (pending.operation === 'select' && item.id !== pending.messageIds?.[index]) ||
            (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !Number.isSafeInteger(item.timestamp) ||
            (pending.operation === 'search' && index > 0 && item.timestamp > result.messages[index - 1]!.timestamp))) {
          pending.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_RESULT_INVALID'))
          return
        }
        pending.resolve(result)
      })
      const fail = (error: Error) => {
        if (preparedSearchWorker !== worker) return
        preparedSearchWorker = undefined
        for (const pending of pendingSearchRequests.values()) { clearTimeout(pending.timer); pending.reject(error) }
        pendingSearchRequests.clear()
      }
      worker.once('error', fail)
      worker.once('exit', (code) => fail(new Error(`PROJECTION_CHAT_BODY_CACHE_SEARCH_WORKER_EXIT:${code}`)))
      // This worker is a bounded, reusable search service; its requests do not represent worker completion.
      worker.unref()
    }
  } catch (error) {
    preparedSearchWorker = undefined
    return Promise.reject(new Error(`PROJECTION_CHAT_BODY_CACHE_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`))
  }
  const worker = preparedSearchWorker!
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      for (const [id, pending] of pendingSearchRequests) {
        clearTimeout(pending.timer)
        if (id !== requestId) pending.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_TIMEOUT'))
      }
      pendingSearchRequests.clear()
      const failedWorker = preparedSearchWorker
      preparedSearchWorker = undefined
      if (failedWorker) void failedWorker.terminate()
      reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_TIMEOUT'))
    }, MAX_CACHE_WORKER_MS)
    const onAbort = () => {
      const pending = pendingSearchRequests.get(requestId)
      if (!pending) return
      pendingSearchRequests.delete(requestId)
      clearTimeout(pending.timer)
      reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED'))
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const settleResolve = (value: PreparedChatBodySearch) => { input.signal?.removeEventListener('abort', onAbort); resolve(value) }
    const settleReject = (error: Error) => { input.signal?.removeEventListener('abort', onAbort); reject(error) }
    pendingSearchRequests.set(requestId, { resolve: settleResolve, reject: settleReject, timer,
      operation: input.operation, ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.messageIds ? { messageIds: input.messageIds } : {}) })
    try { worker.postMessage({ requestId, root: input.root, sessionId: input.view.sessionId,
      sessionGeneration: input.view.sessionGeneration, scopeKey: input.view.scopeKey, specVersion: input.view.specVersion,
      sourceIdentityJson: input.view.sourceIdentityJson, payloadDigest: input.view.payloadDigest,
      validatedRangeJson: input.view.validatedRangeJson, inlinePayload: input.view.inlinePayload,
      blobLocator: input.view.blobLocator, blobByteLength: input.view.blobByteLength, operation: input.operation,
      query: input.query, limit: input.limit, messageIds: input.messageIds,
      sourceSpillRoot: input.sourceSpillRoot, sourceTruthSpills: input.sourceTruthSpills }) }
    catch (error) {
      pendingSearchRequests.delete(requestId)
      clearTimeout(timer)
      settleReject(error instanceof Error ? error : new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_WORKER_POST_FAILED'))
    }
  })
}

function readPreparedChatBodyCache(input: Readonly<{
  root: string
  sourceSpillRoot?: string
  sourceTruthSpills?: readonly SpillDescriptor[]
  view: PreparedChatBodyView
  operation: 'select' | 'search'
  messageIds?: readonly string[]
  query?: string
  limit?: number
  signal?: AbortSignal
}>): Promise<PreparedChatBodySelection> {
  if (input.operation === 'select' && !input.messageIds) return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID'))
  if (input.operation === 'search' && (typeof input.query !== 'string' || !Number.isSafeInteger(input.limit) ||
    input.limit! < 0 || input.limit! > MAX_CHAT_BODY_SEARCH_RESULTS)) {
    return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID'))
  }
  if (input.signal?.aborted) return Promise.reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED'))
  if (!input.sourceTruthSpills?.length && input.view.inlinePayload !== undefined && Buffer.byteLength(input.view.inlinePayload, 'utf8') <= 256 * 1024) {
    try {
      const payload = { payload: Buffer.from(input.view.inlinePayload, 'utf8'),
        sessionId: input.view.sessionId, sessionGeneration: input.view.sessionGeneration, scopeKey: input.view.scopeKey,
        specVersion: input.view.specVersion, sourceIdentityJson: input.view.sourceIdentityJson,
        payloadDigest: input.view.payloadDigest, validatedRangeJson: input.view.validatedRangeJson }
      const messages = input.operation === 'select'
        ? selectVerifiedChatBodyPayload({ ...payload, messageIds: input.messageIds! })
        : searchVerifiedChatBodyPayload({ ...payload, query: input.query!, limit: input.limit! })
      return Promise.resolve({ messages,
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
      if (!result || !Array.isArray(result.messages) || (input.operation === 'select' && result.messages.length !== input.messageIds!.length) ||
        (input.operation === 'search' && ((input.limit! >= 0 && result.messages.length > input.limit!) || result.messages.some((item, index) =>
          index > 0 && item.timestamp > result.messages[index - 1]!.timestamp))) ||
        !Number.isSafeInteger(result.workerThreadId) || result.workerThreadId <= 0 ||
        result.messages.some((item, index) => !item || typeof item.id !== 'string' || !item.id ||
          (input.operation === 'select' && item.id !== input.messageIds![index]) ||
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
    try { worker.postMessage({ requestId, operation: input.operation, query: input.query, limit: input.limit,
      root: input.root, sessionId: input.view.sessionId,
      sessionGeneration: input.view.sessionGeneration, scopeKey: input.view.scopeKey, specVersion: input.view.specVersion,
      sourceIdentityJson: input.view.sourceIdentityJson, payloadDigest: input.view.payloadDigest,
      validatedRangeJson: input.view.validatedRangeJson, inlinePayload: input.view.inlinePayload,
      blobLocator: input.view.blobLocator, blobByteLength: input.view.blobByteLength, messageIds: input.messageIds,
      sourceSpillRoot: input.sourceSpillRoot, sourceTruthSpills: input.sourceTruthSpills }) }
    catch (error) { terminateWithError(error instanceof Error ? error : new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_POST_FAILED')) }
  })
}
