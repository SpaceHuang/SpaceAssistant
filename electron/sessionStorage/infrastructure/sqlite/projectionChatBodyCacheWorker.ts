import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { readVerifiedChatBodyPayloadStream } from './projectionChatBodyCacheStream'
import { searchVerifiedChatBodyPayload, selectVerifiedChatBodyPayload } from './projectionChatBodyCachePayload'

if (!parentPort) throw new Error('projection chat body cache worker requires a parent port')

type Input = Readonly<{
  requestId: string; operation: 'select' | 'search'; query?: string; limit?: number
  root: string; sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number
  sourceIdentityJson: string; payloadDigest: string; validatedRangeJson: string; inlinePayload?: string
  blobLocator?: string; blobByteLength?: number; messageIds: readonly string[]
}>

function readInlinePayload(input: Input): Buffer {
  if ((input.inlinePayload === undefined) === (input.blobLocator === undefined)) throw new Error('PROJECTION_CHAT_BODY_CACHE_REFERENCE_INVALID')
  if (input.inlinePayload === undefined) throw new Error('PROJECTION_CHAT_BODY_CACHE_LOCATOR_INVALID')
  const bytes = Buffer.from(input.inlinePayload, 'utf8')
  if (bytes.byteLength > 256 * 1024) throw new Error('PROJECTION_CHAT_BODY_CACHE_INLINE_LIMIT_EXCEEDED')
  return bytes
}

async function readMessages(input: Input): Promise<readonly import('./projectionChatBodyCachePayload').VerifiedChatBody[]> {
  const metadata = { sessionId: input.sessionId, sessionGeneration: input.sessionGeneration, scopeKey: input.scopeKey,
    specVersion: input.specVersion, sourceIdentityJson: input.sourceIdentityJson, payloadDigest: input.payloadDigest,
    validatedRangeJson: input.validatedRangeJson }
  if (input.inlinePayload !== undefined) {
    const payload = { ...metadata, payload: readInlinePayload(input) }
    return input.operation === 'select'
      ? selectVerifiedChatBodyPayload({ ...payload, messageIds: input.messageIds })
      : searchVerifiedChatBodyPayload({ ...payload, query: input.query!, limit: input.limit! })
  }
  if (!input.blobLocator || !/^projection-[0-9a-f-]{36}\.blob$/.test(input.blobLocator) || path.basename(input.blobLocator) !== input.blobLocator ||
    !Number.isSafeInteger(input.blobByteLength) || input.blobByteLength! < 1) throw new Error('PROJECTION_CHAT_BODY_CACHE_LOCATOR_INVALID')
  const operation = input.operation === 'select'
    ? { kind: 'select' as const, messageIds: input.messageIds }
    : { kind: 'search' as const, query: input.query!, limit: input.limit! }
  return createSessionProjectionBlobStore(input.root).withVerifiedReadStream({ locator: input.blobLocator,
    byteLength: input.blobByteLength!, payloadDigest: input.payloadDigest }, (stream) =>
    readVerifiedChatBodyPayloadStream(stream, { ...metadata, byteLength: input.blobByteLength!, operation }))
}

parentPort.once('message', async (input: Input) => {
  try {
    if (input.operation === 'select' && (!Array.isArray(input.messageIds) || input.messageIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(input.messageIds).size !== input.messageIds.length)) throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
    if (input.operation === 'search' && (typeof input.query !== 'string' || !Number.isSafeInteger(input.limit))) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
    }
    if (input.operation !== 'select' && input.operation !== 'search') throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
    const messages = await readMessages(input)
    parentPort!.postMessage({ requestId: input.requestId, result: { messages, workerThreadId: threadId } })
  } catch (error) {
    parentPort!.postMessage({ requestId: input.requestId, error: error instanceof Error ? error.message : 'PROJECTION_CHAT_BODY_CACHE_READ_FAILED' })
  } finally { parentPort!.close() }
})
