import type { PendingRequestRegistry } from './pendingRequestRegistry'
import { remoteWriteGrantRegistry } from './remoteWriteGrantRegistry'
import type { createRemoteAuthorizationEpochStore } from './remoteAuthorizationEpochStore'
import { confirmationAuthorizationRegistry } from '../confirmation/confirmationAuthorizationRegistry'

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
  | 'session_deleted'
  | 'workdir_changed'

export type PendingCancelByChannel = {
  cancelByChannel: (channel: RemoteAuthChannel) => number
}

export type WriteGrantRevoker = {
  revokeByChannel: (channel: RemoteAuthChannel, reason: string) => number
}

/** 撤销时同步清空该链路会话级 decision_cache 条目的钩子（B3：授权撤销须联动记忆缓存）。 */
export type CacheClearByChannel = {
  clearByChannel: (channel: RemoteAuthChannel) => number
}

export type DeferredTodoInvalidator = {
  invalidateByAuthorizationEpoch: (channel: RemoteAuthChannel, epoch: number) => void
  invalidateByOriginSession?: (sessionId: string, channel: RemoteAuthChannel, epoch: number) => void
  invalidateResumeRequests?: (channel: RemoteAuthChannel, epoch: number) => void
  revokeUnissuedDispatchPermits?: (channel: RemoteAuthChannel, epoch: number) => void
}

type AuditAppend = (event: { type: string; ts?: number } & Record<string, unknown>) => void | Promise<void>

/**
 * Per-channel monotonic authorization generation.
 * invalidate() is the linearization point for revocation:
 * bump generation → cancel pending confirms → revoke write grants → audit → then async teardown.
 */
export class RemoteAuthorizationRegistry {
  private generations = new Map<RemoteAuthChannel, number>()
  private pendingCancels = new Map<string, PendingCancelByChannel>()
  private writeGrantRevoker: WriteGrantRevoker | null = null
  private cacheClearers = new Map<string, CacheClearByChannel>()
  private todoInvalidators = new Map<string, DeferredTodoInvalidator>()
  private auditAppenders: AuditAppend[] = []
  private epochStore: ReturnType<typeof createRemoteAuthorizationEpochStore> | null = null
  private blockedChannels = new Map<RemoteAuthChannel, string>()

  bindPersistentEpochStore(store: ReturnType<typeof createRemoteAuthorizationEpochStore>): void {
    store.initialize()
    this.epochStore = store
  }

  getAuthorizationEpoch(channel: RemoteAuthChannel): number {
    if (!this.epochStore) throw new Error('REMOTE_AUTHORIZATION_EPOCH_STORE_NOT_BOUND')
    this.assertRecoveryComplete()
    return this.epochStore.current(channel)
  }

  assertRecoveryComplete(): void {
    if (this.blockedChannels.size) throw new Error('REMOTE_AUTHORIZATION_DISPATCH_FENCED')
    if (this.epochStore?.pendingRevocations().length) throw new Error('REMOTE_AUTHORIZATION_REVOCATION_RECOVERY_REQUIRED')
  }

  blockChannels(channels: readonly RemoteAuthChannel[], reason: string): void {
    for (const channel of channels) this.blockedChannels.set(channel, reason)
  }

  markChannelsReady(channels: readonly RemoteAuthChannel[]): void {
    for (const channel of channels) this.blockedChannels.delete(channel)
    this.assertRecoveryComplete()
  }

  recoverPendingRevocations(options: { preserveBlocked?: boolean } = {}): void {
    if (!this.epochStore) throw new Error('REMOTE_AUTHORIZATION_EPOCH_STORE_NOT_BOUND')
    for (const revocation of this.epochStore.pendingRevocations()) {
      const nextGeneration = (this.generations.get(revocation.channel) ?? 0) + 1
      this.generations.set(revocation.channel, nextGeneration)
      if (revocation.sessionId) {
        for (const invalidator of this.todoInvalidators.values()) {
          invalidator.invalidateByOriginSession?.(revocation.sessionId, revocation.channel, revocation.epoch)
        }
        for (const handler of this.pendingCancels.values()) handler.cancelByChannel(revocation.channel)
        if (this.writeGrantRevoker) this.writeGrantRevoker.revokeByChannel(revocation.channel, revocation.reason)
        else remoteWriteGrantRegistry.revokeByChannel(revocation.channel, revocation.reason)
        for (const clearer of this.cacheClearers.values()) clearer.clearByChannel(revocation.channel)
      } else this.applyLocalInvalidation(revocation.channel, revocation.reason, nextGeneration, revocation.epoch)
      if (!this.epochStore.completeRevocation(revocation.channel, revocation.epoch)) {
        throw new Error(`REMOTE_AUTHORIZATION_REVOCATION_COMMIT_FAILED:${revocation.channel}:${revocation.epoch}`)
      }
      if (!options.preserveBlocked) this.blockedChannels.delete(revocation.channel)
    }
    if (this.epochStore.pendingRevocations().length) throw new Error('REMOTE_AUTHORIZATION_REVOCATION_RECOVERY_REQUIRED')
  }

  getGeneration(channel: RemoteAuthChannel): number {
    if (this.blockedChannels.has(channel)) throw new Error(`REMOTE_AUTHORIZATION_DISPATCH_FENCED:${channel}`)
    if (this.epochStore?.pendingRevocations().some((entry) => entry.channel === channel)) {
      throw new Error(`REMOTE_AUTHORIZATION_REVOCATION_RECOVERY_REQUIRED:${channel}`)
    }
    return this.generations.get(channel) ?? 0
  }

  registerPendingCancel(handler: PendingCancelByChannel, registrationId = `pending:${this.pendingCancels.size}`): () => void {
    this.pendingCancels.set(registrationId, handler)
    return () => { if (this.pendingCancels.get(registrationId) === handler) this.pendingCancels.delete(registrationId) }
  }

  setWriteGrantRevoker(revoker: WriteGrantRevoker | null): void {
    this.writeGrantRevoker = revoker
  }

  registerCacheClearer(clearer: CacheClearByChannel, registrationId = `cache:${this.cacheClearers.size}`): () => void {
    this.cacheClearers.set(registrationId, clearer)
    return () => { if (this.cacheClearers.get(registrationId) === clearer) this.cacheClearers.delete(registrationId) }
  }

  registerDeferredTodoInvalidator(invalidator: DeferredTodoInvalidator, registrationId?: string): () => void {
    const key = registrationId ?? `anonymous:${Symbol().toString()}`
    if (this.todoInvalidators.get(key) === invalidator) return () => undefined
    this.todoInvalidators.set(key, invalidator)
    return () => { if (this.todoInvalidators.get(key) === invalidator) this.todoInvalidators.delete(key) }
  }

  invalidateSession(channel: RemoteAuthChannel, sessionId: string): number {
    if (!this.epochStore) return this.invalidate(channel, 'session_deleted')
    if (this.epochStore.pendingRevocations().some((row) => row.channel === channel)) {
      this.recoverPendingRevocations({ preserveBlocked: true })
    }
    this.blockChannels([channel], 'session_deleted')
    const epoch = this.epochStore.advance(channel, 'session_deleted', Date.now(), sessionId)
    this.generations.set(channel, (this.generations.get(channel) ?? 0) + 1)
    try {
      for (const invalidator of this.todoInvalidators.values()) {
        invalidator.invalidateByOriginSession?.(sessionId, channel, epoch)
      }
      for (const handler of this.pendingCancels.values()) handler.cancelByChannel(channel)
      if (this.writeGrantRevoker) this.writeGrantRevoker.revokeByChannel(channel, 'session_deleted')
      else remoteWriteGrantRegistry.revokeByChannel(channel, 'session_deleted')
      for (const clearer of this.cacheClearers.values()) clearer.clearByChannel(channel)
      if (this.writeGrantRevoker) this.writeGrantRevoker.revokeByChannel(channel, 'session_deleted')
      else remoteWriteGrantRegistry.revokeByChannel(channel, 'session_deleted')
      for (const invalidator of this.todoInvalidators.values()) invalidator.revokeUnissuedDispatchPermits?.(channel, epoch)
      confirmationAuthorizationRegistry.revokeByChannel(channel)
      if (!this.epochStore.completeRevocation(channel, epoch)) throw new Error(`REMOTE_AUTHORIZATION_REVOCATION_COMMIT_FAILED:${channel}:${epoch}`)
      this.markChannelsReady([channel])
      return this.generations.get(channel) ?? 0
    } catch (error) {
      this.blockChannels([channel], 'session_deleted_recovery_required')
      throw error
    }
  }

  registerAuditAppender(append: AuditAppend): void {
    this.auditAppenders.push(append)
  }

  /**
   * Synchronous revocation linearization point.
   * Returns the new generation after bump.
   */
  invalidate(channel: RemoteAuthChannel, reason: AuthorizationInvalidateReason | string): number {
    if (!this.epochStore) {
      const next = (this.generations.get(channel) ?? 0) + 1
      this.generations.set(channel, next)
      this.applyLocalInvalidation(channel, reason, next)
      return next
    }
    this.blockChannels([channel], String(reason))
    const epoch = this.advanceAuthorizationEpoch(channel, String(reason))
    this.cascadeAuthorizationRevocation(channel, epoch, String(reason))
    if (!this.completeAuthorizationRevocation(channel, epoch)) throw new Error(`REMOTE_AUTHORIZATION_REVOCATION_COMMIT_FAILED:${channel}:${epoch}`)
    this.markChannelsReady([channel])
    return this.generations.get(channel) ?? 0
  }

  advanceAuthorizationEpoch(channel: RemoteAuthChannel, reason: string): number {
    if (!this.epochStore) throw new Error('REMOTE_AUTHORIZATION_EPOCH_STORE_NOT_BOUND')
    if (this.epochStore.pendingRevocations().some((entry) => entry.channel === channel)) this.recoverPendingRevocations({ preserveBlocked: true })
    const epoch = this.epochStore.advance(channel, reason)
    this.generations.set(channel, (this.generations.get(channel) ?? 0) + 1)
    return epoch
  }

  cascadeAuthorizationRevocation(channel: RemoteAuthChannel, epoch: number, reason: string): void {
    if (!this.epochStore || this.epochStore.current(channel) !== epoch) throw new Error(`REMOTE_AUTHORIZATION_EPOCH_MISMATCH:${channel}`)
    this.applyLocalInvalidation(channel, reason, this.generations.get(channel) ?? 0, epoch)
  }

  completeAuthorizationRevocation(channel: RemoteAuthChannel, epoch: number): boolean {
    if (!this.epochStore) throw new Error('REMOTE_AUTHORIZATION_EPOCH_STORE_NOT_BOUND')
    return this.epochStore.completeRevocation(channel, epoch)
  }

  private applyLocalInvalidation(channel: RemoteAuthChannel, reason: AuthorizationInvalidateReason | string, generation: number, durableEpoch?: number): void {
    let cancelledPending = 0
    for (const h of this.pendingCancels.values()) {
      cancelledPending += h.cancelByChannel(channel)
    }

    let revokedGrants = 0
    if (this.writeGrantRevoker) {
      revokedGrants = this.writeGrantRevoker.revokeByChannel(channel, String(reason))
    } else {
      revokedGrants = remoteWriteGrantRegistry.revokeByChannel(channel, String(reason))
    }

    if (durableEpoch !== undefined) {
      for (const invalidator of this.todoInvalidators.values()) {
        invalidator.invalidateByAuthorizationEpoch(channel, durableEpoch)
        invalidator.invalidateResumeRequests?.(channel, durableEpoch)
        invalidator.revokeUnissuedDispatchPermits?.(channel, durableEpoch)
      }
      confirmationAuthorizationRegistry.revokeByChannel(channel)
    }

    // B3：授权撤销联动清空该链路会话级 decision_cache（remote-write 记N 等记忆不得跨越撤销存活）
    let clearedCacheEntries = 0
    for (const c of this.cacheClearers.values()) {
      clearedCacheEntries += c.clearByChannel(channel)
    }

    const event = {
      type: 'authorization_revoked',
      ts: Date.now(),
      channel,
      reason: String(reason),
      authorizationGeneration: generation,
      cancelledPending,
      revokedGrants,
      clearedCacheEntries
    }
    for (const append of this.auditAppenders) {
      try {
        void append(event)
      } catch {
        /* ignore audit failure */
        }
      }
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
