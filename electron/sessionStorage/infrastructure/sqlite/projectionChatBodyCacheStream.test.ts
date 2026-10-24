import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { readVerifiedChatBodyPayloadStream } from './projectionChatBodyCacheStream'

function payloadFor(messages: readonly unknown[]) {
  const sessionId = 'stream-session'
  const sessionGeneration = 'stream-generation'
  const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
  const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: messages.length - 1 }, messageRevision: 4 })
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
    sourceIdentityJson, historyWatermarkJson: { sessionSeq: messages.length - 1 }, messages }))
  const payloadDigest = createHash('sha256').update(bytes).digest('hex')
  const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
    fromSequence: 0, nextSequence: messages.length, payloadDigest, blobByteLength: bytes.byteLength })
  return { bytes, sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson, payloadDigest, validatedRangeJson }
}

describe('stream-verified chatBodyV1 payload reader', () => {
  it('selects requested messages in request order while consuming message records before EOF', async () => {
    const messages = Array.from({ length: 20 }, (_, timestamp) => ({ id: `message-${timestamp}`, role: timestamp % 2 ? 'assistant' : 'user',
      content: `body-${timestamp}`, timestamp }))
    const payload = payloadFor(messages)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < payload.bytes.byteLength; offset += 64) chunks.push(payload.bytes.subarray(offset, offset + 64))
    let yielded = 0
    let recordsObservedBeforeEof = 0
    async function* source() {
      for (const chunk of chunks) { yielded += 1; yield chunk }
    }

    const result = await readVerifiedChatBodyPayloadStream(source(), { ...payload, byteLength: payload.bytes.byteLength,
      operation: { kind: 'select', messageIds: ['message-17', 'message-2'] }, onMessageScanned: () => {
        if (yielded < chunks.length) recordsObservedBeforeEof += 1
      } })

    expect(result).toEqual([messages[17], messages[2]])
    expect(recordsObservedBeforeEof).toBeGreaterThan(0)
  })

  it('validates the full stream and returns timestamp ordered search matches within the limit', async () => {
    const messages = [
      { id: 'older', role: 'user', content: 'Needle 100%_x', timestamp: 1 },
      { id: 'newer', role: 'assistant', content: 'needle 100%_x', timestamp: 3 },
      { id: 'wrong-case', role: 'user', content: 'NEEDLE 100%_x', timestamp: 4 },
      { id: 'wildcard-only', role: 'user', content: 'needle 100abc_x', timestamp: 5 }
    ]
    const payload = payloadFor(messages)
    async function* source() {
      for (let offset = 0; offset < payload.bytes.byteLength; offset += 17) yield payload.bytes.subarray(offset, offset + 17)
    }

    const result = await readVerifiedChatBodyPayloadStream(source(), { ...payload, byteLength: payload.bytes.byteLength,
      operation: { kind: 'search', query: 'needle 100%_x', limit: 1 } })

    expect(result.map(({ id }) => id)).toEqual(['wrong-case'])
  })

  it('rejects negative and unbounded search limits', async () => {
    const payload = payloadFor([{ id: 'one', role: 'user', content: 'needle', timestamp: 1 }])
    async function* source() { yield payload.bytes }
    const input = { ...payload, byteLength: payload.bytes.byteLength }
    await expect(readVerifiedChatBodyPayloadStream(source(), { ...input,
      operation: { kind: 'search', query: 'needle', limit: -1 } })).rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
    await expect(readVerifiedChatBodyPayloadStream(source(), { ...input,
      operation: { kind: 'search', query: 'needle', limit: 10_001 } })).rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
  })
})
