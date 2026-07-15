import { describe, expect, it, beforeEach } from 'vitest'
import {
  onRemoteSecurityReject,
  resetRemoteSecurityAlertStateForTests,
  setRemoteSecurityAlertSink,
  type RemoteSecurityAlertPayload
} from './remoteSecurityAlert'

describe('remoteSecurityAlert', () => {
  beforeEach(() => {
    resetRemoteSecurityAlertStateForTests()
    setRemoteSecurityAlertSink(null)
  })

  it('fires exactly once on the 3rd reject in window', () => {
    const seen: RemoteSecurityAlertPayload[] = []
    setRemoteSecurityAlertSink((p) => seen.push(p))
    const t0 = 1_000_000
    expect(onRemoteSecurityReject(t0)).toBe(false)
    expect(onRemoteSecurityReject(t0 + 60_000)).toBe(false)
    expect(onRemoteSecurityReject(t0 + 120_000)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe('security_reject_burst')
  })
})
