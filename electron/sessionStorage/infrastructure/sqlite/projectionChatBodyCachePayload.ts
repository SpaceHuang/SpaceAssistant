import { createHash } from 'node:crypto'
import { PROJECTION_SPECS } from '../../domain/projectionSpec'

export type VerifiedChatBody = Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>

/** Validate the complete cache envelope before returning selected bodies to either reader. */
export function selectVerifiedChatBodyPayload(input: Readonly<{
  payload: Buffer
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
  payloadDigest: string
  validatedRangeJson: string
  messageIds: readonly string[]
}>): readonly VerifiedChatBody[] {
  if (!Array.isArray(input.messageIds) || input.messageIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(input.messageIds).size !== input.messageIds.length) throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
  if (createHash('sha256').update(input.payload).digest('hex') !== input.payloadDigest) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_DIGEST_MISMATCH')
  }
  const range = JSON.parse(input.validatedRangeJson) as Record<string, unknown>
  if (range.formatVersion !== 1 || range.specVersion !== input.specVersion || range.sourceIdentityJson !== input.sourceIdentityJson ||
    range.fromSequence !== 0 || range.payloadDigest !== input.payloadDigest || range.blobByteLength !== input.payload.byteLength) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_LENGTH_MISMATCH')
  }
  const envelope = JSON.parse(input.payload.toString('utf8')) as Record<string, unknown>
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
  const selected = new Map<string, VerifiedChatBody>()
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
  return Object.freeze(input.messageIds.map((id) => selected.get(id)!))
}
