import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { selectVerifiedChatBodyPayload } from './projectionChatBodyCachePayload'

if (!parentPort) throw new Error('projection chat body cache worker requires a parent port')

type Input = Readonly<{
  requestId: string; root: string; sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number
  sourceIdentityJson: string; payloadDigest: string; validatedRangeJson: string; inlinePayload?: string
  blobLocator?: string; blobByteLength?: number; messageIds: readonly string[]
}>

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

parentPort.once('message', async (input: Input) => {
  try {
    if (!Array.isArray(input.messageIds) || input.messageIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(input.messageIds).size !== input.messageIds.length) throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
    const payloadBytes = await readPayload(input)
    const messages = selectVerifiedChatBodyPayload({ payload: payloadBytes, sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration, scopeKey: input.scopeKey, specVersion: input.specVersion,
      sourceIdentityJson: input.sourceIdentityJson, payloadDigest: input.payloadDigest,
      validatedRangeJson: input.validatedRangeJson, messageIds: input.messageIds })
    parentPort!.postMessage({ requestId: input.requestId, result: { messages, workerThreadId: threadId } })
  } catch (error) {
    parentPort!.postMessage({ requestId: input.requestId, error: error instanceof Error ? error.message : 'PROJECTION_CHAT_BODY_CACHE_READ_FAILED' })
  } finally { parentPort!.close() }
})
