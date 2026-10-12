import { randomBytes } from 'node:crypto'

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const HANDLE_LENGTH = 13
const HANDLE_PATTERN = '[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{5}'

export type ClarificationReplyParseResult =
  | { kind: 'selection'; handle: string; option: number }
  | { kind: 'control-like-invalid' }
  | { kind: 'ordinary' }

/** 65 independent random bits, encoded as 13 Crockford Base32 symbols. */
export function generateClarificationHandle(): string {
  const bytes = randomBytes(9)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  value &= (1n << 65n) - 1n
  const symbols = Array.from({ length: HANDLE_LENGTH }, () => '0')
  for (let index = HANDLE_LENGTH - 1; index >= 0; index -= 1) {
    symbols[index] = CROCKFORD_BASE32[Number(value & 31n)]
    value >>= 5n
  }
  return symbols.join('')
}

export function formatClarificationHandle(handle: string): string {
  if (!new RegExp(`^[${CROCKFORD_BASE32}]{${HANDLE_LENGTH}}$`).test(handle)) {
    throw new Error('invalid clarification handle')
  }
  return `${handle.slice(0, 4)}-${handle.slice(4, 8)}-${handle.slice(8)}`
}

/** Malformed messages beginning with the protocol keyword are reserved and must not enter Agent routing. */
export function parseClarificationReply(text: string, options: { reserveLegacyOption?: boolean } = {}): ClarificationReplyParseResult {
  const normalized = text.trim()
  if (options.reserveLegacyOption && /^[1-5]$/.test(normalized)) return { kind: 'control-like-invalid' }
  if (!/^选择(?:\s|$)/.test(normalized)) return { kind: 'ordinary' }
  const match = new RegExp(`^选择\\s+(${HANDLE_PATTERN})\\s+([1-5])$`, 'i').exec(normalized)
  if (!match) return { kind: 'control-like-invalid' }
  return { kind: 'selection', handle: match[1].replaceAll('-', '').toUpperCase(), option: Number(match[2]) }
}
