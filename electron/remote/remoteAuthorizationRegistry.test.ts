import { describe, expect, it, beforeEach } from 'vitest'
import {
  RemoteAuthorizationRegistry,
  type PendingCancelByChannel,
  type WriteGrantRevoker
} from './remoteAuthorizationRegistry'
import { PendingRequestRegistry } from './pendingRequestRegistry'

describe('RemoteAuthorizationRegistry', () => {
  let registry: RemoteAuthorizationRegistry

  beforeEach(() => {
    registry = new RemoteAuthorizationRegistry()
  })

  it('bumps generation monotonically per channel', () => {
    expect(registry.getGeneration('feishu')).toBe(0)
    expect(registry.invalidate('feishu', 'remote_disabled')).toBe(1)
    expect(registry.getGeneration('feishu')).toBe(1)
    expect(registry.getGeneration('wechat')).toBe(0)
    expect(registry.invalidate('feishu', 'allowlist_changed')).toBe(2)
  })

  it('cancels pending and revokes grants synchronously on invalidate', async () => {
    const pending = new PendingRequestRegistry<{
      id: string
      sessionId: string
      expiresAt: number
      channel: 'feishu' | 'wechat'
    }>()
    const wait = pending.register(
      { id: 'p1', sessionId: 's1', expiresAt: Date.now() + 60_000, channel: 'feishu' },
      60_000
    )
    const cancelHandler: PendingCancelByChannel = {
      cancelByChannel: (ch) => pending.cancelByChannel(ch)
    }
    const grantRevoker: WriteGrantRevoker = {
      revokeByChannel: () => 3
    }
    const audits: Array<Record<string, unknown>> = []
    registry.registerPendingCancel(cancelHandler)
    registry.setWriteGrantRevoker(grantRevoker)
    registry.registerAuditAppender((e) => {
      audits.push(e)
    })

    const gen = registry.invalidate('feishu', 'owner_cleared')
    expect(gen).toBe(1)
    await expect(wait).resolves.toBe('n')
    expect(pending.countPending()).toBe(0)
    expect(audits[0]).toMatchObject({
      type: 'authorization_revoked',
      channel: 'feishu',
      reason: 'owner_cleared',
      authorizationGeneration: 1,
      cancelledPending: 1,
      revokedGrants: 3
    })
  })

  it('approve after invalidate cannot use old generation semantics', () => {
    const pending = new PendingRequestRegistry<{
      id: string
      sessionId: string
      expiresAt: number
      channel: 'feishu' | 'wechat'
      authorizationGeneration: number
    }>()
    registry.registerPendingCancel({
      cancelByChannel: (ch) => pending.cancelByChannel(ch)
    })
    const wait = pending.register(
      {
        id: 'old',
        sessionId: 's',
        expiresAt: Date.now() + 60_000,
        channel: 'wechat',
        authorizationGeneration: registry.getGeneration('wechat')
      },
      60_000
    )
    registry.invalidate('wechat', 'remote_disabled')
    // After invalidate the waiter is already resolved as n; resolve(y) is a no-op
    expect(pending.resolve('old', 'y')).toBe(false)
    return expect(wait).resolves.toBe('n')
  })
})
