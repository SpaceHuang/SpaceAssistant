import { createHash } from 'node:crypto'
import { PROJECTION_SPECS } from '../../domain/projectionSpec'

export type VerifiedChatBody = Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
export type ChatBodyCandidateFact = Readonly<{ id: string; role: 'user' | 'assistant'; timestamp: number }>

type VerifiedPayloadInput = Readonly<{
  payload: Buffer
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
  payloadDigest: string
  validatedRangeJson: string
}>

export function readVerifiedChatBodyPayload(input: VerifiedPayloadInput): readonly VerifiedChatBody[] {
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
  const ids = new Set<string>()
  const fields = [...PROJECTION_SPECS.chatBodyV1.outputFields].sort().join(',')
  const messages: VerifiedChatBody[] = []
  for (const item of envelope.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
    const message = item as Record<string, unknown>
    if (Object.keys(message).sort().join(',') !== fields || typeof message.id !== 'string' || !message.id || ids.has(message.id) ||
      (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || !Number.isSafeInteger(message.timestamp)) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
    }
    ids.add(message.id)
    messages.push(Object.freeze({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp as number }))
  }
  return Object.freeze(messages)
}

/** Validate the complete cache envelope before returning selected bodies to either reader. */
export function selectVerifiedChatBodyPayload(input: VerifiedPayloadInput & Readonly<{
  messageIds: readonly string[]
}>): readonly VerifiedChatBody[] {
  const messages = readVerifiedChatBodyPayload(input)
  return selectVerifiedChatBodies(messages, input.messageIds)
}

export function selectVerifiedChatBodies(messages: readonly VerifiedChatBody[], messageIds: readonly string[]): readonly VerifiedChatBody[] {
  if (!Array.isArray(messageIds) || messageIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(messageIds).size !== messageIds.length) throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
  const wanted = new Set(messageIds)
  const selected = new Map(messages.filter(({ id }) => wanted.has(id)).map((message) => [message.id, message]))
  if (selected.size !== wanted.size) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_MISSING')
  return Object.freeze(messageIds.map((id) => selected.get(id)!))
}

/** Search verified canonical bodies using SQLite LIKE's literal, ASCII-case-insensitive semantics. */
export function verifyChatBodyCandidateFacts(messages: readonly VerifiedChatBody[], candidateFacts: readonly ChatBodyCandidateFact[]): void {
  if (!Array.isArray(candidateFacts) || candidateFacts.some((fact) => !fact || typeof fact.id !== 'string' || !fact.id ||
    (fact.role !== 'user' && fact.role !== 'assistant') || !Number.isSafeInteger(fact.timestamp)) ||
    new Set(candidateFacts.map(({ id }) => id)).size !== candidateFacts.length) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_CANDIDATE_FACTS_INVALID')
  }
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const fact of candidateFacts) {
    const message = byId.get(fact.id)
    if (!message || message.role !== fact.role || message.timestamp !== fact.timestamp) {
      throw new Error('PROJECTION_CHAT_BODY_CACHE_CANDIDATE_SOURCE_MISMATCH')
    }
  }
}

export function searchVerifiedChatBodyPayload(input: VerifiedPayloadInput & Readonly<{
  query: string; limit: number; candidateFacts: readonly ChatBodyCandidateFact[]
}>): readonly VerifiedChatBody[] {
  if (typeof input.query !== 'string' || !Number.isSafeInteger(input.limit)) throw new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
  verifyChatBodyCandidateFacts(readVerifiedChatBodyPayload(input), input.candidateFacts)
  if (!input.query || input.limit === 0) return Object.freeze([])
  return searchVerifiedChatBodies(readVerifiedChatBodyPayload(input), input.query, input.limit)
}

export function searchVerifiedChatBodies(messages: readonly VerifiedChatBody[], query: string, limit: number): readonly VerifiedChatBody[] {
  if (typeof query !== 'string' || !Number.isSafeInteger(limit)) throw new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
  if (!query || limit === 0) return Object.freeze([])
  const foldAscii = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const needle = foldAscii(query)
  const matches = messages.filter(({ content }) => foldAscii(content).includes(needle))
    .sort((left, right) => right.timestamp - left.timestamp)
  return Object.freeze(limit < 0 ? matches : matches.slice(0, limit))
}
