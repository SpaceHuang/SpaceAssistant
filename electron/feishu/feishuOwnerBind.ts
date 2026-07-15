/**
 * Feishu owner bind lifecycle using a one-time pairing code (v1.6):
 *   desktop starts window → shows plaintext code once → user sends `绑定 <code>` / `bind <code>`
 *   from their own Feishu account → atomic consume writes owner.
 *
 * Only a digest of the code is retained ({ codeDigest, consumed, failedAttempts, expiresAt }).
 * The plaintext code is returned exactly once from startBindingWindow; snapshots never expose it.
 * Timeout / cancel / attempt-exhaust / clear-owner all force remoteEnabled=false.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'crypto'

export type FeishuOwnerBindStatus = 'idle' | 'binding' | 'bound'

export interface FeishuOwnerBindSnapshot {
  status: FeishuOwnerBindStatus
  bindingExpiresAt?: number
  failedAttempts?: number
  remainingAttempts?: number
  maskedOwnerOpenId?: string
  boundAt?: number
}

export type FeishuBindConsumeResult =
  | 'bound'
  | 'wrong_code'
  | 'expired'
  | 'exhausted'
  | 'already_bound'
  | 'no_window'

export type FeishuOwnerBindDeps = {
  getOwnerOpenId: () => string | undefined
  setOwnerOpenId: (ownerOpenId: string | undefined) => void
  setRemoteEnabled: (enabled: boolean) => void
  now?: () => number
  /** Injectable RNG for deterministic tests; must return `n` random bytes. */
  randomBytes?: (n: number) => Uint8Array
  onAudit?: (event: string, fields?: Record<string, unknown>) => void
}

const DEFAULT_WINDOW_MS = 5 * 60_000
const MAX_FAILED_ATTEMPTS = 5
const CODE_LENGTH = 8
/** Crockford Base32 (no I, L, O, U): 8 chars × 5 bits = 40 bit entropy. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

type BindingState = {
  codeDigest: string
  consumed: boolean
  failedAttempts: number
  expiresAt: number
  startedAt: number
}

function digestCode(code: string): string {
  return createHash('sha256').update(normalizePairingCode(code)).digest('hex')
}

/** Normalize a user-entered code: uppercase, strip separators, map Crockford confusables. */
export function normalizePairingCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** Generate a Crockford Base32 8-char pairing code from injectable random bytes. */
export function generatePairingCode(randomBytes: (n: number) => Uint8Array = nodeRandomBytes): string {
  const bytes = randomBytes(5) // 40 bits
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) {
    value = (value << 8) | bytes[i]!
    bits += 8
    while (bits >= 5 && out.length < CODE_LENGTH) {
      bits -= 5
      out += CROCKFORD[(value >>> bits) & 0x1f]
    }
  }
  while (out.length < CODE_LENGTH) out += CROCKFORD[0]
  return out
}

export function maskOpenId(openId: string | undefined): string | undefined {
  const id = openId?.trim()
  if (!id) return undefined
  if (id.length <= 6) return `${id.slice(0, 2)}***`
  return `${id.slice(0, 4)}***${id.slice(-4)}`
}

/**
 * Pure protocol parser. Accepts only exact `绑定 <code>` / `bind <code>` after trim.
 * Returns the raw (un-normalized) code token, or null when the message is not a bind command.
 */
export function parseFeishuBindProtocol(text: string): { code: string } | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  const m = /^(?:绑定|bind)[ \t]+(\S+)$/i.exec(trimmed)
  if (!m) return null
  return { code: m[1]! }
}

export class FeishuOwnerBindController {
  private binding: BindingState | null = null
  private boundAt?: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly randomBytes: (n: number) => Uint8Array

  constructor(private deps: FeishuOwnerBindDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.randomBytes = deps.randomBytes ?? nodeRandomBytes
  }

  getSnapshot(): FeishuOwnerBindSnapshot {
    const owner = this.deps.getOwnerOpenId()
    if (owner) {
      return { status: 'bound', maskedOwnerOpenId: maskOpenId(owner), boundAt: this.boundAt }
    }
    if (this.isBindingActive()) {
      const b = this.binding!
      return {
        status: 'binding',
        bindingExpiresAt: b.expiresAt,
        failedAttempts: b.failedAttempts,
        remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - b.failedAttempts)
      }
    }
    return { status: 'idle' }
  }

  isBindingActive(): boolean {
    if (!this.binding) return false
    if (this.binding.consumed) return false
    if (this.now() > this.binding.expiresAt) {
      this.finishExpiredBinding()
      return false
    }
    return true
  }

  hasOwner(): boolean {
    return Boolean(this.deps.getOwnerOpenId())
  }

  /**
   * Enter (or restart) a bind window and return the ONE-TIME plaintext pairing code.
   * The controller only retains a digest; callers must surface the code to the desktop
   * immediately since it is never available again.
   */
  startBindingWindow(windowMs = DEFAULT_WINDOW_MS): string {
    this.clearTimerOnly()
    const code = generatePairingCode(this.randomBytes)
    const started = this.now()
    this.binding = {
      codeDigest: digestCode(code),
      consumed: false,
      failedAttempts: 0,
      expiresAt: started + windowMs,
      startedAt: started
    }
    this.timer = setTimeout(() => this.handleTimeout(), windowMs)
    this.deps.onAudit?.('feishu.bind.window_start', {
      expiresAt: this.binding.expiresAt,
      windowMs,
      codeDigest: this.binding.codeDigest
    })
    return code
  }

  /** Rebind: clear old owner immediately, open new window, return new code. */
  startRebind(windowMs = DEFAULT_WINDOW_MS): string {
    this.clearTimerOnly()
    this.deps.setOwnerOpenId(undefined)
    this.boundAt = undefined
    const code = this.startBindingWindow(windowMs)
    this.deps.onAudit?.('feishu.bind.rebind_start', { windowMs })
    return code
  }

  /** Clear owner and force remoteEnabled=false. */
  clearOwner(): void {
    this.clearTimerOnly()
    this.binding = null
    this.boundAt = undefined
    this.deps.setRemoteEnabled(false)
    this.deps.setOwnerOpenId(undefined)
    this.deps.onAudit?.('feishu.bind.clear', {})
  }

  /** User cancel: same as timeout — remoteEnabled=false. */
  cancelBinding(): void {
    this.clearTimerOnly()
    this.binding = null
    this.deps.setRemoteEnabled(false)
    this.deps.onAudit?.('feishu.bind.cancel', {})
  }

  /**
   * Atomically consume the pairing code (synchronous critical section — exactly one caller can
   * win). On success writes the owner; on failure increments attempts and closes remote on exhaust.
   */
  tryConsumeBindCode(senderOpenId: string, code: string): FeishuBindConsumeResult {
    if (!senderOpenId) return 'no_window'
    if (this.deps.getOwnerOpenId()) return 'already_bound'
    if (!this.binding) return 'no_window'
    if (this.binding.consumed) return 'already_bound'
    if (this.now() > this.binding.expiresAt) {
      this.finishExpiredBinding()
      return 'expired'
    }

    if (this.codeMatches(code)) {
      this.binding.consumed = true
      this.clearTimerOnly()
      this.deps.setOwnerOpenId(senderOpenId)
      this.boundAt = this.now()
      this.deps.onAudit?.('feishu.bind.success', { ownerOpenId: maskOpenId(senderOpenId) })
      return 'bound'
    }

    this.binding.failedAttempts += 1
    if (this.binding.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.clearTimerOnly()
      this.binding = null
      this.deps.setRemoteEnabled(false)
      this.deps.onAudit?.('feishu.bind.exhausted', { failedAttempts: MAX_FAILED_ATTEMPTS })
      return 'exhausted'
    }
    this.deps.onAudit?.('feishu.bind.wrong_code', {
      failedAttempts: this.binding.failedAttempts,
      remainingAttempts: MAX_FAILED_ATTEMPTS - this.binding.failedAttempts
    })
    return 'wrong_code'
  }

  private codeMatches(code: string): boolean {
    if (!this.binding) return false
    const candidate = digestCode(code)
    const a = Buffer.from(candidate, 'hex')
    const b = Buffer.from(this.binding.codeDigest, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  private handleTimeout(): void {
    this.timer = null
    this.finishExpiredBinding()
  }

  /** Shared fail-closed path for timer timeout and proactive expiry (consume / snapshot). */
  private finishExpiredBinding(): void {
    this.clearTimerOnly()
    this.binding = null
    this.deps.setRemoteEnabled(false)
    this.deps.onAudit?.('feishu.bind.timeout', {})
  }

  private clearTimerOnly(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.clearTimerOnly()
    this.binding = null
  }
}

export function readOwnerOpenIdFromAllowlist(allowlist: string[] | undefined): string | undefined {
  const first = allowlist?.[0]?.trim()
  return first || undefined
}

export function ownerAllowlistFromOpenId(ownerOpenId: string | undefined): string[] | undefined {
  const id = ownerOpenId?.trim()
  return id ? [id] : undefined
}
