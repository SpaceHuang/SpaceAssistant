import { randomUUID } from 'node:crypto'

const OPEN = '\u2063\u2063'
const CLOSE = '\u2063\u2063'
const ZERO = '\u200b'
const ONE = '\u200c'

/**
 * Encodes a per-prompt random nonce with invisible format characters. WeChat's
 * iLink quote payload carries the quoted message content but no message ID.
 */
export function createWeChatQuoteMarker(nonce = randomUUID()): string {
  const hex = nonce.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('WECHAT_QUOTE_NONCE_INVALID')
  const bits = [...hex].map((char) => Number.parseInt(char, 16).toString(2).padStart(4, '0')).join('')
  return OPEN + [...bits].map((bit) => bit === '0' ? ZERO : ONE).join('') + CLOSE
}
