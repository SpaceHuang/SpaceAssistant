import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  FeishuOwnerBindController,
  ownerAllowlistFromOpenId,
  readOwnerOpenIdFromAllowlist
} from './feishuOwnerBind'

describe('feishuOwnerBind', () => {
  let owner: string | undefined
  let remoteEnabled: boolean
  let audit: ReturnType<typeof vi.fn>
  let now: number
  let ctrl: FeishuOwnerBindController

  beforeEach(() => {
    owner = undefined
    remoteEnabled = true
    audit = vi.fn()
    now = 1_000_000
    ctrl = new FeishuOwnerBindController({
      getOwnerOpenId: () => owner,
      setOwnerOpenId: (id) => {
        owner = id
      },
      setRemoteEnabled: (v) => {
        remoteEnabled = v
      },
      now: () => now,
      onAudit: (event, fields) => audit(event, fields)
    })
  })

  afterEach(() => {
    ctrl.dispose()
  })

  it('read/write allowlist helpers', () => {
    expect(readOwnerOpenIdFromAllowlist([' ou_1 ', 'ou_2'])).toBe('ou_1')
    expect(readOwnerOpenIdFromAllowlist([])).toBeUndefined()
    expect(ownerAllowlistFromOpenId('ou_x')).toEqual(['ou_x'])
    expect(ownerAllowlistFromOpenId(undefined)).toBeUndefined()
  })

  it('binds first p2p sender in window and exits binding', () => {
    ctrl.startBindingWindow(60_000)
    expect(ctrl.getSnapshot().status).toBe('binding')
    expect(ctrl.tryBindFromInbound('ou_owner')).toBe(true)
    expect(owner).toBe('ou_owner')
    expect(ctrl.getSnapshot()).toEqual({ status: 'bound', ownerOpenId: 'ou_owner' })
    expect(audit).toHaveBeenCalledWith('feishu.bind.success', { ownerOpenId: 'ou_owner' })
    expect(ctrl.tryBindFromInbound('ou_other')).toBe(false)
  })

  it('timeout forces remoteEnabled=false', () => {
    vi.useFakeTimers()
    const timed = new FeishuOwnerBindController({
      getOwnerOpenId: () => owner,
      setOwnerOpenId: (id) => {
        owner = id
      },
      setRemoteEnabled: (v) => {
        remoteEnabled = v
      },
      onAudit: (event, fields) => audit(event, fields)
    })
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

  it('rebind clears old owner immediately', () => {
    owner = 'ou_old'
    ctrl.startRebind(60_000)
    expect(owner).toBeUndefined()
    expect(ctrl.getSnapshot().status).toBe('binding')
    expect(ctrl.tryBindFromInbound('ou_new')).toBe(true)
    expect(owner).toBe('ou_new')
  })

  it('clearOwner disables remote', () => {
    owner = 'ou_x'
    ctrl.clearOwner()
    expect(owner).toBeUndefined()
    expect(remoteEnabled).toBe(false)
  })
})
