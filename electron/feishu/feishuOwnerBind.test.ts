import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  FeishuOwnerBindController,
  generatePairingCode,
  maskOpenId,
  normalizePairingCode,
  ownerAllowlistFromOpenId,
  parseFeishuBindProtocol,
  readOwnerOpenIdFromAllowlist
} from './feishuOwnerBind'

/** Deterministic bytes → known code. */
function fixedBytes(byte = 0): (n: number) => Uint8Array {
  return (n: number) => new Uint8Array(n).fill(byte)
}

describe('pairing code helpers', () => {
  it('generates 8-char Crockford Base32 codes (no I/L/O/U)', () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode()
      expect(code).toHaveLength(8)
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    }
  })

  it('normalizePairingCode maps confusables and strips separators', () => {
    expect(normalizePairingCode(' ab-cd ef ')).toBe('ABCDEF')
    expect(normalizePairingCode('OIL')).toBe('011')
  })

  it('parseFeishuBindProtocol accepts only exact 绑定/bind <code>', () => {
    expect(parseFeishuBindProtocol('绑定 ABCD1234')).toEqual({ code: 'ABCD1234' })
    expect(parseFeishuBindProtocol('bind abcd1234')).toEqual({ code: 'abcd1234' })
    expect(parseFeishuBindProtocol('  BIND   XY9Z  ')).toEqual({ code: 'XY9Z' })
    expect(parseFeishuBindProtocol('绑定')).toBeNull()
    expect(parseFeishuBindProtocol('绑定 ABCD 1234')).toBeNull()
    expect(parseFeishuBindProtocol('please 绑定 ABCD')).toBeNull()
    expect(parseFeishuBindProtocol('hello world')).toBeNull()
  })

  it('maskOpenId hides the middle', () => {
    expect(maskOpenId('ou_1234567890')).toBe('ou_1***7890')
    expect(maskOpenId('short')).toBe('sh***')
    expect(maskOpenId(undefined)).toBeUndefined()
  })
})

describe('FeishuOwnerBindController pairing lifecycle', () => {
  let owner: string | undefined
  let remoteEnabled: boolean
  let audit: ReturnType<typeof vi.fn>
  let now: number
  let ctrl: FeishuOwnerBindController

  function makeCtrl(bytes = fixedBytes(0)) {
    return new FeishuOwnerBindController({
      getOwnerOpenId: () => owner,
      setOwnerOpenId: (id) => {
        owner = id
      },
      setRemoteEnabled: (v) => {
        remoteEnabled = v
      },
      now: () => now,
      randomBytes: bytes,
      onAudit: (event, fields) => audit(event, fields)
    })
  }

  beforeEach(() => {
    owner = undefined
    remoteEnabled = true
    audit = vi.fn()
    now = 1_000_000
    ctrl = makeCtrl()
  })

  afterEach(() => {
    ctrl.dispose()
  })

  it('read/write allowlist helpers', () => {
    expect(readOwnerOpenIdFromAllowlist([' ou_1 ', 'ou_2'])).toBe('ou_1')
    expect(ownerAllowlistFromOpenId('ou_x')).toEqual(['ou_x'])
  })

  it('startBindingWindow returns plaintext code once; snapshot never exposes it', () => {
    const code = ctrl.startBindingWindow(60_000)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    const snap = ctrl.getSnapshot()
    expect(snap.status).toBe('binding')
    expect(snap.remainingAttempts).toBe(5)
    expect(JSON.stringify(snap)).not.toContain(code)
    // Audit records digest only, not plaintext.
    const startCall = audit.mock.calls.find((c) => c[0] === 'feishu.bind.window_start')
    expect(startCall?.[1]?.codeDigest).toBeTypeOf('string')
    expect(JSON.stringify(startCall?.[1])).not.toContain(code)
  })

  it('consumes correct code atomically and writes owner', () => {
    const code = ctrl.startBindingWindow(60_000)
    expect(ctrl.tryConsumeBindCode('ou_owner', code)).toBe('bound')
    expect(owner).toBe('ou_owner')
    const snap = ctrl.getSnapshot()
    expect(snap.status).toBe('bound')
    expect(snap.maskedOwnerOpenId).toBe(maskOpenId('ou_owner'))
    // A second attempt after bound is rejected.
    expect(ctrl.tryConsumeBindCode('ou_other', code)).toBe('already_bound')
  })

  it('wrong codes count attempts; exhaust closes remote', () => {
    ctrl.startBindingWindow(60_000)
    for (let i = 0; i < 4; i++) {
      expect(ctrl.tryConsumeBindCode('ou_a', 'WRONGXXX')).toBe('wrong_code')
    }
    expect(ctrl.getSnapshot().remainingAttempts).toBe(1)
    expect(ctrl.tryConsumeBindCode('ou_a', 'WRONGXXX')).toBe('exhausted')
    expect(remoteEnabled).toBe(false)
    expect(owner).toBeUndefined()
  })

  it('expired code cannot bind', () => {
    const code = ctrl.startBindingWindow(60_000)
    now += 60_001
    expect(ctrl.tryConsumeBindCode('ou_a', code)).toBe('expired')
    expect(owner).toBeUndefined()
  })

  it('concurrent-style: exactly one success for same code', () => {
    const code = ctrl.startBindingWindow(60_000)
    const r1 = ctrl.tryConsumeBindCode('ou_first', code)
    const r2 = ctrl.tryConsumeBindCode('ou_second', code)
    expect([r1, r2].filter((r) => r === 'bound')).toHaveLength(1)
    expect(owner).toBe('ou_first')
  })

  it('timeout forces remoteEnabled=false', () => {
    vi.useFakeTimers()
    const timed = makeCtrl()
    timed.startBindingWindow(5_000)
    expect(remoteEnabled).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(remoteEnabled).toBe(false)
    expect(timed.getSnapshot().status).toBe('idle')
    expect(audit).toHaveBeenCalledWith('feishu.bind.timeout', {})
    timed.dispose()
    vi.useRealTimers()
  })

  it('cancelBinding forces remoteEnabled=false', () => {
    ctrl.startBindingWindow(60_000)
    ctrl.cancelBinding()
    expect(remoteEnabled).toBe(false)
    expect(ctrl.isBindingActive()).toBe(false)
    expect(audit).toHaveBeenCalledWith('feishu.bind.cancel', {})
  })

  it('rebind clears old owner immediately and issues a new code', () => {
    owner = 'ou_old'
    const code = ctrl.startRebind(60_000)
    expect(owner).toBeUndefined()
    expect(ctrl.getSnapshot().status).toBe('binding')
    expect(ctrl.tryConsumeBindCode('ou_new', code)).toBe('bound')
    expect(owner).toBe('ou_new')
  })

  it('clearOwner disables remote', () => {
    owner = 'ou_x'
    ctrl.clearOwner()
    expect(owner).toBeUndefined()
    expect(remoteEnabled).toBe(false)
  })
})
