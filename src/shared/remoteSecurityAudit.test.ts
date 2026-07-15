import { describe, expect, it } from 'vitest'
import {
  noteSecurityReject,
  sanitizeRemoteSecurityAuditFields,
  REMOTE_SECURITY_AUDIT_RETENTION_MS
} from './remoteSecurityAudit'

describe('remoteSecurityAudit', () => {
  it('drops unknown fields and redacts secrets/paths/pairing', () => {
    const out = sanitizeRemoteSecurityAuditFields({
      type: 'security_reject',
      channel: 'feishu',
      sessionId: 's1',
      token: 'sk-abcdefghijklmnop',
      password: 'x',
      cookie: 'sid=1',
      pairingCode: 'ABCD1234',
      command: 'rm -rf /Users/space/secret',
      commandPreview: '绑定 ABCD1234 and /Users/space/foo',
      reason: 'reject'
    })
    expect(out.token).toBeUndefined()
    expect(out.password).toBeUndefined()
    expect(out.cookie).toBeUndefined()
    expect(out.pairingCode).toBeUndefined()
    expect(out.command).toBeUndefined()
    expect(String(out.commandPreview)).not.toContain('ABCD1234')
    expect(String(out.commandPreview)).not.toContain('/Users/space')
    expect(out.reason).toBe('reject')
    expect(out.type).toBe('security_reject')
  })

  it('alerts exactly on 3rd reject within 5 minutes', () => {
    let state = { timestamps: [] as number[] }
    const t0 = 1_000_000
    let r = noteSecurityReject(state, t0)
    expect(r.shouldAlert).toBe(false)
    state = r.state
    r = noteSecurityReject(state, t0 + 60_000)
    expect(r.shouldAlert).toBe(false)
    state = r.state
    r = noteSecurityReject(state, t0 + 120_000)
    expect(r.shouldAlert).toBe(true)
  })

  it('default retention is 30 days', () => {
    expect(REMOTE_SECURITY_AUDIT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
