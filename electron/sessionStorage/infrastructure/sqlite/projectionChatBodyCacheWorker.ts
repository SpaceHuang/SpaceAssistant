import { createHash } from 'node:crypto'
import path from 'node:path'
import { parentPort, threadId } from 'node:worker_threads'
import { PROJECTION_SPECS } from '../../domain/projectionSpec'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'

if (!parentPort) throw new Error('projection chat body cache worker requires a parent port')

type Input = Readonly<{
  requestId: string; root: string; sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number
  sourceIdentityJson: string; payloadDigest: string; validatedRangeJson: string; inlinePayload?: string
  blobLocator?: string; blobByteLength?: number; messageIds: readonly string[]
}>

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

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
    if (digest(payloadBytes) !== input.payloadDigest) throw new Error('PROJECTION_CHAT_BODY_CACHE_DIGEST_MISMATCH')
    const range = JSON.parse(input.validatedRangeJson) as Record<string, unknown>
    if (range.formatVersion !== 1 || range.specVersion !== input.specVersion || range.sourceIdentityJson !== input.sourceIdentityJson ||
      range.fromSequence !== 0 || range.payloadDigest !== input.payloadDigest || !Number.isSafeInteger(range.blobByteLength) ||
      range.blobByteLength !== payloadBytes.byteLength) throw new Error('PROJECTION_CHAT_BODY_CACHE_LENGTH_MISMATCH')
    const envelope = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== 'formatVersion,historyWatermarkJson,messages,scopeKey,sessionGeneration,sessionId,sourceIdentityJson,specVersion' ||
      envelope.formatVersion !== 1 || envelope.sessionId !== input.sessionId || envelope.sessionGeneration !== input.sessionGeneration ||
      envelope.scopeKey !== input.scopeKey || envelope.specVersion !== input.specVersion || envelope.sourceIdentityJson !== input.sourceIdentityJson ||
      !Array.isArray(envelope.messages)) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
    const source = JSON.parse(input.sourceIdentityJson) as { historyWatermark?: unknown }
    if (JSON.stringify(envelope.historyWatermarkJson) !== JSON.stringify(source.historyWatermark ?? null)) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_WATERMARK_INVALID')
    }
    const wanted = new Set(input.messageIds)
    const selected = new Map<string, Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>>()
    const ids = new Set<string>()
    const fields = [...PROJECTION_SPECS.chatBodyV1.outputFields].sort().join(',')
    for (const item of envelope.messages) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
      const message = item as Record<string, unknown>
      if (Object.keys(message).sort().join(',') !== fields || typeof message.id !== 'string' || !message.id || ids.has(message.id) ||
        (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || !Number.isSafeInteger(message.timestamp)) {
        throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
      }
      ids.add(message.id)
      if (wanted.has(message.id)) selected.set(message.id, Object.freeze({ id: message.id, role: message.role,
        content: message.content, timestamp: message.timestamp as number }))
    }
    if (selected.size !== wanted.size) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_MISSING')
    parentPort!.postMessage({ requestId: input.requestId, result: { messages: input.messageIds.map((id) => selected.get(id)!), workerThreadId: threadId } })
  } catch (error) {
    parentPort!.postMessage({ requestId: input.requestId, error: error instanceof Error ? error.message : 'PROJECTION_CHAT_BODY_CACHE_READ_FAILED' })
  } finally { parentPort!.close() }
})
