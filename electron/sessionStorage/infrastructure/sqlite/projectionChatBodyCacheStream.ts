import { StringDecoder } from 'node:string_decoder'
import { PROJECTION_SPECS } from '../../domain/projectionSpec'
import type { VerifiedChatBody } from './projectionChatBodyCachePayload'

const MAX_METADATA_VALUE_BYTES = 64 * 1024
const MAX_SEARCH_RESULTS = 10_000
const ENVELOPE_FIELDS = new Set(['formatVersion', 'scopeKey', 'specVersion', 'sessionId', 'sessionGeneration',
  'sourceIdentityJson', 'historyWatermarkJson', 'messages'])
const MESSAGE_FIELD_NAMES = [...PROJECTION_SPECS.chatBodyV1.outputFields].sort()
const MESSAGE_FIELDS = new Set<string>(MESSAGE_FIELD_NAMES)

type StreamOperation = Readonly<{ kind: 'select'; messageIds: readonly string[] }> |
  Readonly<{ kind: 'search'; query: string; limit: number }>
type StreamInput = Readonly<{
  byteLength: number
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
  payloadDigest: string
  validatedRangeJson: string
  operation: StreamOperation
  onMessageScanned?: (ordinal: number) => void
}>

/** Parse a verified cache blob one JSON value at a time; only one message object is materialized at once. */
export async function readVerifiedChatBodyPayloadStream(
  source: AsyncIterable<Uint8Array>, input: StreamInput
): Promise<readonly VerifiedChatBody[]> {
  validateRequest(input)
  const reader = new JsonValueStreamReader(source)
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let messagesSeen = false
  let messageCount = 0
  const ids = new Set<string>()
  const wanted = input.operation.kind === 'select' ? new Set(input.operation.messageIds) : undefined
  const selected = new Map<string, VerifiedChatBody>()
  const matches: Array<{ message: VerifiedChatBody; ordinal: number }> = []
  const needle = input.operation.kind === 'search' ? foldAscii(input.operation.query) : ''

  await reader.skipWhitespace()
  await reader.expect('{')
  await reader.skipWhitespace()
  if (await reader.peek() !== 0x7d) {
    while (true) {
      const key = await reader.readJsonValue(MAX_METADATA_VALUE_BYTES)
      if (typeof key !== 'string' || Object.hasOwn(metadata, key)) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
      await reader.skipWhitespace()
      await reader.expect(':')
      await reader.skipWhitespace()
      if (key === 'messages') {
        messagesSeen = true
        await reader.expect('[')
        await reader.skipWhitespace()
        if (await reader.peek() !== 0x5d) {
          while (true) {
            const message = validateMessage(await reader.readMessage(), messageCount, ids)
            if (input.operation.kind === 'select') {
              if (wanted!.has(message.id)) selected.set(message.id, message)
            } else if (needle && foldAscii(message.content).includes(needle)) {
              matches.push({ message, ordinal: messageCount })
              if (input.operation.limit >= 0 && matches.length > input.operation.limit) {
                matches.sort(compareSearchMatches)
                matches.length = input.operation.limit
              }
            }
            input.onMessageScanned?.(messageCount)
            messageCount += 1
            await reader.skipWhitespace()
            const separator = await reader.read()
            if (separator === 0x5d) break
            if (separator !== 0x2c) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
            await reader.skipWhitespace()
          }
        } else {
          await reader.expect(']')
        }
        metadata[key] = true
      } else {
        metadata[key] = await reader.readJsonValue(MAX_METADATA_VALUE_BYTES)
      }
      await reader.skipWhitespace()
      const separator = await reader.read()
      if (separator === 0x7d) break
      if (separator !== 0x2c) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
      await reader.skipWhitespace()
    }
  } else {
    await reader.expect('}')
  }
  await reader.skipWhitespace()
  if ((await reader.peek()) !== undefined) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')

  validateEnvelope(metadata, messagesSeen, input)
  if (input.operation.kind === 'select') {
    if (selected.size !== wanted!.size) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_MISSING')
    return Object.freeze(input.operation.messageIds.map((id) => selected.get(id)!))
  }
  matches.sort(compareSearchMatches)
  return Object.freeze(matches.map(({ message }) => message))
}

function validateRequest(input: StreamInput): void {
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) throw new Error('PROJECTION_CHAT_BODY_CACHE_LENGTH_MISMATCH')
  let range: Record<string, unknown>
  let source: { historyWatermark?: unknown }
  try {
    range = JSON.parse(input.validatedRangeJson) as Record<string, unknown>
    source = JSON.parse(input.sourceIdentityJson) as { historyWatermark?: unknown }
  } catch { throw new Error('PROJECTION_CHAT_BODY_CACHE_LENGTH_MISMATCH') }
  if (!range || range.formatVersion !== 1 || range.specVersion !== input.specVersion || range.sourceIdentityJson !== input.sourceIdentityJson ||
    range.fromSequence !== 0 || range.payloadDigest !== input.payloadDigest || range.blobByteLength !== input.byteLength ||
    !source || typeof source !== 'object' || Array.isArray(source)) throw new Error('PROJECTION_CHAT_BODY_CACHE_LENGTH_MISMATCH')
  if (input.operation.kind === 'select' && (!Array.isArray(input.operation.messageIds) ||
    input.operation.messageIds.some((id) => typeof id !== 'string' || !id) || new Set(input.operation.messageIds).size !== input.operation.messageIds.length)) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_REQUEST_INVALID')
  }
  if (input.operation.kind === 'search' && (typeof input.operation.query !== 'string' || !Number.isSafeInteger(input.operation.limit) ||
    input.operation.limit < 0 || input.operation.limit > MAX_SEARCH_RESULTS)) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_SEARCH_REQUEST_INVALID')
  }
}

function validateEnvelope(metadata: Record<string, unknown>, messagesSeen: boolean, input: StreamInput): void {
  if (!messagesSeen || Object.keys(metadata).length !== ENVELOPE_FIELDS.size || Object.keys(metadata).some((key) => !ENVELOPE_FIELDS.has(key)) ||
    metadata.formatVersion !== 1 || metadata.sessionId !== input.sessionId || metadata.sessionGeneration !== input.sessionGeneration ||
    metadata.scopeKey !== input.scopeKey || metadata.specVersion !== input.specVersion || metadata.sourceIdentityJson !== input.sourceIdentityJson) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
  }
  let source: { historyWatermark?: unknown }
  try { source = JSON.parse(input.sourceIdentityJson) as { historyWatermark?: unknown } }
  catch { throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID') }
  if (JSON.stringify(metadata.historyWatermarkJson) !== JSON.stringify(source.historyWatermark ?? null)) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_WATERMARK_INVALID')
  }
}

function validateMessage(value: unknown, _ordinal: number, ids: Set<string>): VerifiedChatBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
  const message = value as Record<string, unknown>
  if (Object.keys(message).length !== MESSAGE_FIELD_NAMES.length || Object.keys(message).some((key) => !MESSAGE_FIELDS.has(key)) ||
    typeof message.id !== 'string' || !message.id || ids.has(message.id) ||
    (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || !Number.isSafeInteger(message.timestamp)) {
    throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
  }
  ids.add(message.id)
  return Object.freeze({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp as number })
}

function foldAscii(value: string): string { return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) }

function compareSearchMatches(left: { message: VerifiedChatBody; ordinal: number }, right: { message: VerifiedChatBody; ordinal: number }): number {
  return right.message.timestamp - left.message.timestamp || left.ordinal - right.ordinal
}

/** Byte-oriented JSON value scanner; structural bytes are ASCII and UTF-8 body bytes pass through unchanged. */
class JsonValueStreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private chunk = Buffer.alloc(0)
  private offset = 0
  private ended = false

  constructor(source: AsyncIterable<Uint8Array>) { this.iterator = source[Symbol.asyncIterator]() }

  async peek(): Promise<number | undefined> {
    await this.ensureChunk()
    return this.offset < this.chunk.byteLength ? this.chunk[this.offset] : undefined
  }

  async read(): Promise<number | undefined> {
    const value = await this.peek()
    if (value !== undefined) this.offset += 1
    return value
  }

  async expect(char: string): Promise<void> {
    const expected = char.charCodeAt(0)
    if (await this.read() !== expected) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
  }

  async skipWhitespace(): Promise<void> {
    while (true) {
      const value = await this.peek()
      if (value !== 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) return
      this.offset += 1
    }
  }

  async readJsonValue(maxBytes = Number.POSITIVE_INFINITY): Promise<unknown> {
    const raw = await this.readRawValue(maxBytes)
    try { return JSON.parse(raw.toString('utf8')) as unknown }
    catch { throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID') }
  }

  async readJsonString(maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
    await this.expect('"')
    const fragments: string[] = []
    let decoder = new StringDecoder('utf8')
    let rawBytes = 0
    const countBytes = (count: number) => {
      rawBytes += count
      if (rawBytes > maxBytes) throw new Error('PROJECTION_CHAT_BODY_CACHE_METADATA_LIMIT_EXCEEDED')
    }
    const append = (buffer: Buffer) => {
      countBytes(buffer.byteLength)
      const decoded = decoder.write(buffer)
      if (decoded) fragments.push(decoded)
    }

    while (true) {
      await this.ensureChunk()
      if (this.offset >= this.chunk.byteLength) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
      const start = this.offset
      while (this.offset < this.chunk.byteLength) {
        const byte = this.chunk[this.offset]!
        if (byte === 0x22 || byte === 0x5c || byte < 0x20) break
        this.offset += 1
      }
      append(this.chunk.subarray(start, this.offset))
      if (this.offset >= this.chunk.byteLength) continue
      const delimiter = await this.read()
      if (delimiter === 0x22) {
        const tail = decoder.end()
        if (tail) fragments.push(tail)
        return fragments.join('')
      }
      if (delimiter === 0x5c) {
        countBytes(2)
        const tail = decoder.end()
        if (tail) fragments.push(tail)
        const escaped = await this.read()
        const escapeMap: Record<number, string> = {
          0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t'
        }
        if (escaped === 0x75) {
          countBytes(4)
          let codeUnit = 0
          for (let index = 0; index < 4; index += 1) {
            const hex = await this.read()
            const digit = hex === undefined ? -1 : parseInt(String.fromCharCode(hex), 16)
            if (digit < 0 || digit > 15) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
            codeUnit = codeUnit * 16 + digit
          }
          fragments.push(String.fromCharCode(codeUnit))
        } else if (escaped !== undefined && Object.hasOwn(escapeMap, escaped)) {
          fragments.push(escapeMap[escaped]!)
        } else {
          throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
        }
        decoder = new StringDecoder('utf8')
        continue
      }
      throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
    }
  }

  async readMessage(): Promise<unknown> {
    await this.skipWhitespace()
    await this.expect('{')
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const fields = new Set<string>()
    await this.skipWhitespace()
    if (await this.peek() !== 0x7d) {
      while (true) {
        const key = await this.readJsonString(1024)
        if (fields.has(key) || !MESSAGE_FIELDS.has(key)) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
        fields.add(key)
        await this.skipWhitespace()
        await this.expect(':')
        await this.skipWhitespace()
        value[key] = key === 'content' || key === 'id' || key === 'role'
          ? await this.readJsonString(key === 'content' ? Number.POSITIVE_INFINITY : 64 * 1024)
          : await this.readJsonValue(64)
        await this.skipWhitespace()
        const separator = await this.read()
        if (separator === 0x7d) break
        if (separator !== 0x2c) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
        await this.skipWhitespace()
      }
    } else {
      await this.expect('}')
    }
    if (fields.size !== MESSAGE_FIELD_NAMES.length) throw new Error('PROJECTION_CHAT_BODY_CACHE_MESSAGE_INVALID')
    return value
  }

  private async readRawValue(maxBytes: number): Promise<Buffer> {
    await this.skipWhitespace()
    const first = await this.peek()
    if (first === undefined) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
    const fragments: Buffer[] = []
    let totalBytes = 0
    const append = (chunk: Buffer, start: number, end: number) => {
      if (end <= start) return
      totalBytes += end - start
      if (totalBytes > maxBytes) throw new Error('PROJECTION_CHAT_BODY_CACHE_METADATA_LIMIT_EXCEEDED')
      fragments.push(chunk.subarray(start, end))
    }

    if (first === 0x7b || first === 0x5b) {
      const expectedClose = new Uint8Array(first === 0x7b ? [0x7d] : [0x5d])
      const stack: number[] = [expectedClose[0]!]
      let inString = false
      let escaped = false
      const valueStart = this.offset
      this.offset += 1
      append(this.chunk, valueStart, this.offset)
      while (stack.length > 0) {
        await this.ensureChunk()
        if (this.offset >= this.chunk.byteLength) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
        const start = this.offset
        for (; this.offset < this.chunk.byteLength; this.offset += 1) {
          const value = this.chunk[this.offset]!
          if (inString) {
            if (escaped) escaped = false
            else if (value === 0x5c) escaped = true
            else if (value === 0x22) inString = false
            continue
          }
          if (value === 0x22) inString = true
          else if (value === 0x7b) stack.push(0x7d)
          else if (value === 0x5b) stack.push(0x5d)
          else if (value === 0x7d || value === 0x5d) {
            if (stack.pop() !== value) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
            if (stack.length === 0) { this.offset += 1; append(this.chunk, start, this.offset); return Buffer.concat(fragments, totalBytes) }
          }
        }
        append(this.chunk, start, this.offset)
      }
    } else if (first === 0x22) {
      let inString = true
      let escaped = false
      const quoteStart = this.offset
      this.offset += 1
      append(this.chunk, quoteStart, this.offset)
      while (inString) {
        await this.ensureChunk()
        if (this.offset >= this.chunk.byteLength) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
        const start = this.offset
        for (; this.offset < this.chunk.byteLength; this.offset += 1) {
          const value = this.chunk[this.offset]!
          if (escaped) escaped = false
          else if (value === 0x5c) escaped = true
          else if (value === 0x22) { inString = false; this.offset += 1; break }
        }
        append(this.chunk, start, this.offset)
      }
    } else {
      while (true) {
        await this.ensureChunk()
        if (this.offset >= this.chunk.byteLength) break
        const value = this.chunk[this.offset]!
        if (value === 0x2c || value === 0x5d || value === 0x7d || value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d) break
        const start = this.offset
        while (this.offset < this.chunk.byteLength) {
          const current = this.chunk[this.offset]!
          if (current === 0x2c || current === 0x5d || current === 0x7d || current === 0x20 || current === 0x09 || current === 0x0a || current === 0x0d) break
          this.offset += 1
        }
        append(this.chunk, start, this.offset)
      }
    }
    if (totalBytes === 0) throw new Error('PROJECTION_CHAT_BODY_CACHE_ENVELOPE_INVALID')
    return Buffer.concat(fragments, totalBytes)
  }

  private async ensureChunk(): Promise<void> {
    while (!this.ended && this.offset >= this.chunk.byteLength) {
      const next = await this.iterator.next()
      if (next.done) { this.ended = true; this.chunk = Buffer.alloc(0); this.offset = 0; return }
      this.chunk = Buffer.from(next.value)
      this.offset = 0
      if (this.chunk.byteLength > 0) return
    }
  }
}
