import type { PendingRequestRegistry } from './pendingRequestRegistry'
import { remoteWriteGrantRegistry } from './remoteWriteGrantRegistry'

export type RemoteAuthChannel = 'feishu' | 'wechat'

export type AuthorizationInvalidateReason =
  | 'remote_disabled'
  | 'channel_disabled'
  | 'service_stopped'
  | 'logout'
  | 'owner_cleared'
  | 'allowlist_changed'
  | 'channel_closed'
  | 'manual'

export type PendingCancelByChannel = {
  cancelByChannel: (channel: RemoteAuthChannel) => number
}

export type WriteGrantRevoker = {
  revokeByChannel: (channel: RemoteAuthChannel, reason: string) => number
}

type AuditAppend = (event: { type: string; ts?: number } & Record<string, unknown>) => void | Promise<void>

/**
 * Per-channel monotonic authorization generation.
 * invalidate() is the linearization point for revocation:
 * bump generation → cancel pending confirms → revoke write grants → audit → then async teardown.
 */
export class RemoteAuthorizationRegistry {
  private generations = new Map<RemoteAuthChannel, number>()
  private pendingCancels: PendingCancelByChannel[] = []
  private writeGrantRevoker: WriteGrantRevoker | null = null
  private auditAppenders: AuditAppend[] = []

  getGeneration(channel: RemoteAuthChannel): number {
    return this.generations.get(channel) ?? 0
  }

  registerPendingCancel(handler: PendingCancelByChannel): void {
    this.pendingCancels.push(handler)
  }

  setWriteGrantRevoker(revoker: WriteGrantRevoker | null): void {
    this.writeGrantRevoker = revoker
  }

  registerAuditAppender(append: AuditAppend): void {
    this.auditAppenders.push(append)
  }

  /**
   * Synchronous revocation linearization point.
   * Returns the new generation after bump.
   */
  invalidate(channel: RemoteAuthChannel, reason: AuthorizationInvalidateReason | string): number {
    const next = this.getGeneration(channel) + 1
    this.generations.set(channel, next)

    let cancelledPending = 0
    for (const h of this.pendingCancels) {
      cancelledPending += h.cancelByChannel(channel)
    }

    let revokedGrants = 0
    if (this.writeGrantRevoker) {
      revokedGrants = this.writeGrantRevoker.revokeByChannel(channel, String(reason))
    } else {
      revokedGrants = remoteWriteGrantRegistry.revokeByChannel(channel, String(reason))
    }

    const event = {
      type: 'authorization_revoked',
      ts: Date.now(),
      channel,
      reason: String(reason),
      authorizationGeneration: next,
      cancelledPending,
      revokedGrants
    }
    for (const append of this.auditAppenders) {
      try {
        void append(event)
      } catch {
        /* ignore audit failure */
      }
    }

    return next
  }
}

/** Process-wide singleton used by IM routers and config persistence. */
export const remoteAuthorizationRegistry = new RemoteAuthorizationRegistry()

/**
 * Helper: bind a channel-scoped PendingRequestRegistry so invalidate can cancel its waiters.
 * Items must carry `channel`.
 */
export function bindPendingRegistryToAuthChannel<
  T extends { id: string; sessionId: string; expiresAt: number; channel?: RemoteAuthChannel }
>(
  registry: PendingRequestRegistry<T>,
  channel: RemoteAuthChannel
): void {
  remoteAuthorizationRegistry.registerPendingCancel({
    cancelByChannel: (ch) => {
      if (ch !== channel) return 0
      return registry.cancelByChannel(channel)
    }
  })
}
