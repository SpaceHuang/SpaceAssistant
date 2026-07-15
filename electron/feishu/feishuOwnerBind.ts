/**
 * Feishu owner bind lifecycle: listen → bind window → first p2p message binds owner.
 * Timeout / cancel forces remoteEnabled=false (aligned with clear-owner).
 */

export type FeishuOwnerBindStatus = 'idle' | 'binding' | 'bound'

export interface FeishuOwnerBindSnapshot {
  status: FeishuOwnerBindStatus
  ownerOpenId?: string
  bindingExpiresAt?: number
  bindingStartedAt?: number
}

export type FeishuOwnerBindDeps = {
  getOwnerOpenId: () => string | undefined
  setOwnerOpenId: (ownerOpenId: string | undefined) => void
  setRemoteEnabled: (enabled: boolean) => void
  now?: () => number
  onAudit?: (event: string, fields?: Record<string, unknown>) => void
}

const DEFAULT_WINDOW_MS = 5 * 60_000

export class FeishuOwnerBindController {
  private bindingStartedAt?: number
  private bindingExpiresAt?: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private deps: FeishuOwnerBindDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  getSnapshot(): FeishuOwnerBindSnapshot {
    const owner = this.deps.getOwnerOpenId()
    if (owner) {
      return { status: 'bound', ownerOpenId: owner }
    }
    if (this.isBindingActive()) {
      return {
        status: 'binding',
        bindingStartedAt: this.bindingStartedAt,
        bindingExpiresAt: this.bindingExpiresAt
      }
    }
    return { status: 'idle' }
  }

  isBindingActive(): boolean {
    if (this.bindingExpiresAt == null) return false
    if (this.now() > this.bindingExpiresAt) {
      this.clearTimerOnly()
      return false
    }
    return true
  }

  hasOwner(): boolean {
    return Boolean(this.deps.getOwnerOpenId())
  }

  /** Enter bind window when enabling remote without an owner. */
  startBindingWindow(windowMs = DEFAULT_WINDOW_MS): void {
    this.clearTimerOnly()
    const started = this.now()
    this.bindingStartedAt = started
    this.bindingExpiresAt = started + windowMs
    this.timer = setTimeout(() => this.handleTimeout(), windowMs)
    this.deps.onAudit?.('feishu.bind.window_start', {
      expiresAt: this.bindingExpiresAt,
      windowMs
    })
  }

  /** Rebind: clear old owner immediately, open new window. */
  startRebind(windowMs = DEFAULT_WINDOW_MS): void {
    this.clearTimerOnly()
    this.deps.setOwnerOpenId(undefined)
    this.startBindingWindow(windowMs)
    this.deps.onAudit?.('feishu.bind.rebind_start', { windowMs })
  }

  /** Clear owner and force remoteEnabled=false. */
  clearOwner(): void {
    this.clearTimerOnly()
    this.deps.setRemoteEnabled(false)
    this.deps.setOwnerOpenId(undefined)
    this.deps.onAudit?.('feishu.bind.clear', {})
  }

  /** User cancel: same as timeout — remoteEnabled=false. */
  cancelBinding(): void {
    if (!this.isBindingActive() && !this.bindingExpiresAt) {
      this.deps.setRemoteEnabled(false)
      this.deps.onAudit?.('feishu.bind.cancel', {})
      return
    }
    this.clearTimerOnly()
    this.deps.setRemoteEnabled(false)
    this.deps.onAudit?.('feishu.bind.cancel', {})
  }

  /**
   * First accepted p2p message in bind window becomes owner.
   * Returns true if bind succeeded (caller should not treat as business command).
   */
  tryBindFromInbound(senderOpenId: string): boolean {
    if (!senderOpenId || !this.isBindingActive()) return false
    if (this.deps.getOwnerOpenId()) return false
    this.clearTimerOnly()
    this.deps.setOwnerOpenId(senderOpenId)
    this.deps.onAudit?.('feishu.bind.success', { ownerOpenId: senderOpenId })
    return true
  }

  private handleTimeout(): void {
    this.timer = null
    this.bindingStartedAt = undefined
    this.bindingExpiresAt = undefined
    this.deps.setRemoteEnabled(false)
    this.deps.onAudit?.('feishu.bind.timeout', {})
  }

  private clearTimerOnly(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.bindingStartedAt = undefined
    this.bindingExpiresAt = undefined
  }

  dispose(): void {
    this.clearTimerOnly()
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
