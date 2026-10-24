import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { readVerifiedChatBodyPayload, searchVerifiedChatBodies, type VerifiedChatBody } from './projectionChatBodyCachePayload'

if (!parentPort) throw new Error('projection chat body cache search worker requires a parent port')

type Input = Readonly<{
  requestId: string; root: string; sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number
  sourceIdentityJson: string; payloadDigest: string; validatedRangeJson: string; inlinePayload?: string
  blobLocator?: string; blobByteLength?: number; query: string; limit: number
}>
type Cached = Readonly<{ key: string; byteLength: number; messages: readonly VerifiedChatBody[] }>

const MAX_CACHED_PAYLOAD_BYTES = 16 * 1024 * 1024
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

async function handle(input: Input): Promise<void> {
  try {
    if (!input || typeof input.requestId !== 'string' || typeof input.query !== 'string' || !Number.isSafeInteger(input.limit)) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
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
    const messages = searchVerifiedChatBodies(entry.messages, input.query, input.limit)
    parentPort!.postMessage({ requestId: input.requestId, result: { messages, workerThreadId: threadId } })
  } catch (error) {
    parentPort!.postMessage({ requestId: input?.requestId, error: error instanceof Error ? error.message : 'PROJECTION_CHAT_BODY_CACHE_SEARCH_FAILED' })
  }
}

parentPort.on('message', (input: Input) => {
  queue = queue.then(() => handle(input), () => handle(input))
})
