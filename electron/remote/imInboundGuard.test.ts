import { describe, expect, it } from 'vitest'
import {
  evaluateImInboundGuard,
  revalidateImInboundGuard
} from './imInboundGuard'
import { remoteAuthorizationRegistry } from './remoteAuthorizationRegistry'
import type { AuditSink } from '../confirmation/audit'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

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

describe('imInboundGuard ingress deny 审计（§5.2a/§5.6 policy.deny-ingress 必落）', () => {
  function fakeAudit(): { sink: AuditSink; events: SecurityAuditEvent[] } {
    const events: SecurityAuditEvent[] = []
    return { sink: { record: (e) => events.push(e) }, events }
  }

  it('ingress deny 时落 policy.deny-ingress（lane/origin/ruleId/reason，actor=system）', () => {
    const { sink, events } = fakeAudit()
    const r = evaluateImInboundGuard({
      channel: 'feishu',
      senderId: 'outsider',
      getConfig: () => ({ remoteEnabled: true, remoteSenderAllowlist: ['owner'] }),
      audit: sink
    })
    expect(r.ok).toBe(false)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.event).toBe('policy.deny-ingress')
    expect(e.lane).toBe('feishu')
    expect(e.origin).toEqual({ kind: 'direct-other', senderId: 'outsider' })
    expect(e.ruleId).toBe('ingress-direct-other-deny')
    expect(typeof e.reason).toBe('string')
    expect(e.actor).toBe('system')
  })

  it('ingress allow 时不落审计事件', () => {
    const { sink, events } = fakeAudit()
    const r = evaluateImInboundGuard({
      channel: 'wechat',
      senderId: 'owner',
      getConfig: () => ({ remoteEnabled: true, remoteSenderAllowlist: ['owner'] }),
      audit: sink
    })
    expect(r.ok).toBe(true)
    expect(events).toHaveLength(0)
  })

  it('ingress 之前的前置拒绝（未登录/远程未启用）不落 policy.deny-ingress', () => {
    const { sink, events } = fakeAudit()
    evaluateImInboundGuard({
      channel: 'wechat',
      senderId: 'owner',
      getConfig: () => ({ remoteEnabled: false, remoteSenderAllowlist: ['owner'] }),
      audit: sink
    })
    expect(events).toHaveLength(0)
  })
})
