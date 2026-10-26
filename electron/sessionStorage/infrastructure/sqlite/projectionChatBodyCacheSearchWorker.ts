import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { readVerifiedChatBodyPayloadStream } from './projectionChatBodyCacheStream'
import { readVerifiedChatBodyPayload, searchVerifiedChatBodies, selectVerifiedChatBodies, verifyChatBodyCandidateFacts,
  type ChatBodyCandidateFact, type VerifiedChatBody } from './projectionChatBodyCachePayload'
import { readSourceTruthSpillSync, type SpillDescriptor } from '../../../storage/spillProtocol'

if (!parentPort) throw new Error('projection chat body cache search worker requires a parent port')

type Input = Readonly<{
  requestId: string; root: string; sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number
  sourceIdentityJson: string; payloadDigest: string; validatedRangeJson: string; inlinePayload?: string
  blobLocator?: string; blobByteLength?: number; operation: 'select' | 'search'; query?: string; limit?: number; messageIds?: readonly string[]
  candidateFacts?: readonly ChatBodyCandidateFact[]
  sourceSpillRoot?: string; sourceTruthSpills?: readonly SpillDescriptor[]
}>
type Cached = Readonly<{ key: string; byteLength: number; messages: readonly VerifiedChatBody[] }>

const MAX_CACHED_PAYLOAD_BYTES = 16 * 1024 * 1024
const MAX_SEARCH_RESULTS = 10_000
const cache = new Map<string, Cached>()
let cachedBytes = 0
let queue = Promise.resolve()

async function readPayload(input: Input): Promise<Buffer> {
  if ((input.inlinePayload === undefined) === (input.blobLocator === undefined)) throw new Error('PROJECTION_CHAT_BODY_CACHE_REFERENCE_INVALID')
  if (input.inlinePayload !== undefined) {
    const bytes = Buffer.from(input.inlinePayload, 'utf8')
    if (bytes.byteLength > 256 * 1024) throw new Error('PROJECTION_CHAT_BODY_CACHE_INLINE_LIMIT_EXCEEDED')
    return bytes
  }
  if (!input.blobLocator || !/^projection-[0-9a-f-]{36}\.blob$/.test(input.blobLocator) || path.basename(input.blobLocator) !== input.blobLocator ||
    !Number.isSafeInteger(input.blobByteLength) || input.blobByteLength! < 1) throw new Error('PROJECTION_CHAT_BODY_CACHE_LOCATOR_INVALID')
  const payload = await createSessionProjectionBlobStore(input.root).readVerified({ locator: input.blobLocator,
    byteLength: input.blobByteLength!, payloadDigest: input.payloadDigest })
  return Buffer.from(payload, 'utf8')
}

async function readLargePayload(input: Input): Promise<readonly VerifiedChatBody[]> {
  if (input.inlinePayload !== undefined || !input.blobLocator || !Number.isSafeInteger(input.blobByteLength) || input.blobByteLength! <= MAX_CACHED_PAYLOAD_BYTES) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_LOCATOR_INVALID')
  }
  return createSessionProjectionBlobStore(input.root).withVerifiedReadStream({ locator: input.blobLocator,
    byteLength: input.blobByteLength!, payloadDigest: input.payloadDigest }, (stream) =>
    readVerifiedChatBodyPayloadStream(stream, { byteLength: input.blobByteLength!, sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration, scopeKey: input.scopeKey, specVersion: input.specVersion,
      sourceIdentityJson: input.sourceIdentityJson, payloadDigest: input.payloadDigest,
      validatedRangeJson: input.validatedRangeJson, operation: input.operation === 'search'
        ? { kind: 'search', query: input.query!, limit: input.limit!, candidateFacts: input.candidateFacts! }
        : { kind: 'select', messageIds: input.messageIds! } }))
}

async function handle(input: Input, enqueuedAt: number): Promise<void> {
  const workerStartedAt = performance.now()
  let sourceSpillVerifyMs = 0
  try {
    const spills = input?.sourceTruthSpills ?? []
    if (spills.length) {
      if (!input.sourceSpillRoot) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      const spillStartedAt = performance.now()
      try { for (const descriptor of spills) readSourceTruthSpillSync(input.sourceSpillRoot, descriptor) }
      catch { throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE') }
      finally { sourceSpillVerifyMs = performance.now() - spillStartedAt }
    }
    if (!input || typeof input.requestId !== 'string' || (input.operation !== 'select' && input.operation !== 'search')) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
    }
    if (input.operation === 'search' && (typeof input.query !== 'string' || !Number.isSafeInteger(input.limit) ||
      input.limit! < 0 || input.limit! > MAX_SEARCH_RESULTS || !Array.isArray(input.candidateFacts))) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
    }
    if (input.operation === 'select' && (!Array.isArray(input.messageIds) || input.messageIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(input.messageIds).size !== input.messageIds.length)) throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
    if (input.inlinePayload === undefined && Number.isSafeInteger(input.blobByteLength) && input.blobByteLength! > MAX_CACHED_PAYLOAD_BYTES) {
      const messages = await readLargePayload(input)
      parentPort!.postMessage({ requestId: input.requestId, result: { messages, workerThreadId: threadId,
        metrics: { 'worker-queue': Math.max(0, workerStartedAt - enqueuedAt), 'source-spill-verify': sourceSpillVerifyMs,
          'worker-read': Math.max(0, performance.now() - workerStartedAt - sourceSpillVerifyMs) } } })
      return
    }
    const key = `${input.sessionId}\0${input.sessionGeneration}\0${input.sourceIdentityJson}\0${input.payloadDigest}`
    let entry = cache.get(key)
    if (!entry) {
      const payload = await readPayload(input)
      const messages = readVerifiedChatBodyPayload({ payload, sessionId: input.sessionId,
        sessionGeneration: input.sessionGeneration, scopeKey: input.scopeKey, specVersion: input.specVersion,
        sourceIdentityJson: input.sourceIdentityJson, payloadDigest: input.payloadDigest,
        validatedRangeJson: input.validatedRangeJson })
      const byteLength = payload.byteLength
      if (byteLength <= MAX_CACHED_PAYLOAD_BYTES) {
        while (cachedBytes + byteLength > MAX_CACHED_PAYLOAD_BYTES && cache.size) {
          const oldest = cache.keys().next().value as string | undefined
          if (!oldest) break
          const removed = cache.get(oldest)!
          cache.delete(oldest)
          cachedBytes -= removed.byteLength
        }
        entry = { key, byteLength, messages }
        cache.set(key, entry)
        cachedBytes += byteLength
      } else entry = { key, byteLength, messages }
    } else {
      cache.delete(key)
      cache.set(key, entry)
    }
    if (input.operation === 'search') verifyChatBodyCandidateFacts(entry.messages, input.candidateFacts!)
    const messages = input.operation === 'search'
      ? searchVerifiedChatBodies(entry.messages, input.query!, input.limit!)
      : selectVerifiedChatBodies(entry.messages, input.messageIds!)
    parentPort!.postMessage({ requestId: input.requestId, result: { messages, workerThreadId: threadId,
      metrics: { 'worker-queue': Math.max(0, workerStartedAt - enqueuedAt), 'source-spill-verify': sourceSpillVerifyMs,
        'worker-read': Math.max(0, performance.now() - workerStartedAt - sourceSpillVerifyMs) } } })
  } catch (error) {
    parentPort!.postMessage({ requestId: input?.requestId, error: error instanceof Error ? error.message : 'PROJECTION_CHAT_BODY_CACHE_SEARCH_FAILED' })
  }
}

parentPort.on('message', (input: Input) => {
  const enqueuedAt = performance.now()
  queue = queue.then(() => handle(input, enqueuedAt), () => handle(input, enqueuedAt))
})
