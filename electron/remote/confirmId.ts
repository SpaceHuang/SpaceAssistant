import { randomBytes } from 'crypto'

/** Crockford Base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const globalConfirmIds = new Set<string>()

export function allocateConfirmId(maxAttempts = 32): string {
  for (let i = 0; i < maxAttempts; i++) {
    const buf = randomBytes(3)
    let id = ''
    // 4 chars from 20 bits
    let n = ((buf[0]! << 16) | (buf[1]! << 8) | buf[2]!) >>> 0
    for (let c = 0; c < 4; c++) {
      id = CROCKFORD[n & 31]! + id
      n >>>= 5
    }
    const upper = id.toUpperCase()
    if (!globalConfirmIds.has(upper)) {
      globalConfirmIds.add(upper)
      return upper
    }
  }
  throw new Error('confirmId collision exhausted')
}

export function releaseConfirmId(id: string): void {
  globalConfirmIds.delete(id.toUpperCase())
}

/** Test helper */
export function clearConfirmIdSpace(): void {
  globalConfirmIds.clear()
}

export function isConfirmIdInUse(id: string): boolean {
  return globalConfirmIds.has(id.toUpperCase())
}
