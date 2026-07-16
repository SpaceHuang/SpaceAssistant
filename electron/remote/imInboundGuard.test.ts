import { describe, expect, it } from 'vitest'
import {
  evaluateImInboundGuard,
  revalidateImInboundGuard
} from './imInboundGuard'
import { remoteAuthorizationRegistry } from './remoteAuthorizationRegistry'

describe('imInboundGuard', () => {
  it('rejects non-owner and remote disabled', () => {
    expect(
      evaluateImInboundGuard({
        channel: 'wechat',
        senderId: 'u1',
        getConfig: () => ({ remoteEnabled: true, remoteSenderAllowlist: ['other'] })
      }).ok
    ).toBe(false)
    expect(
      evaluateImInboundGuard({
        channel: 'feishu',
        senderId: 'u1',
        getConfig: () => ({ remoteEnabled: false, remoteSenderAllowlist: ['u1'] })
      }).ok
    ).toBe(false)
  })

  it('revalidate fails after generation bump', () => {
    const ok = evaluateImInboundGuard({
      channel: 'wechat',
      senderId: 'u1',
      getConfig: () => ({ remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['u1'] })
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    remoteAuthorizationRegistry.invalidate('wechat', 'remote_disabled')
    const again = revalidateImInboundGuard(ok.snapshot, {
      getConfig: () => ({ remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['u1'] })
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe('revoked')
  })
})
