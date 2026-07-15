import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_IM_COMMON_CONFIG,
  applyRemoteRestrictWritesAndOutbound,
  isRemoteRestrictWritesAndOutbound,
  mergeRemoteImCommonConfig,
  migrateRemoteReadOnlyPolicy,
  normalizeImConfirmPolicy
} from './imTypes'

describe('imTypes', () => {
  it('mergeRemoteImCommonConfig returns defaults for null', () => {
    const merged = mergeRemoteImCommonConfig(null)
    expect(merged.remoteEnabled).toBe(DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteEnabled)
    expect(merged.remoteConfirmPolicy).toBe('always')
    expect(merged.remoteDenyOutbound).toBe(false)
    expect(merged.remoteAllowLocalWrite).toBe(true)
    expect(merged.remoteBrowserRequiresConfirm).toBe(false)
    expect(merged.remoteRateLimitPerMinute).toBe(60)
    expect(merged.remoteProgressMode).toBe(DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteProgressMode)
  })

  it('deep-copies allowlist', () => {
    const allowlist = ['a', 'b']
    const merged = mergeRemoteImCommonConfig({ remoteSenderAllowlist: allowlist })
    expect(merged.remoteSenderAllowlist).toEqual(['a', 'b'])
    allowlist.push('c')
    expect(merged.remoteSenderAllowlist).toEqual(['a', 'b'])
  })

  it('merges progress fields via mergeRemoteProgressConfig', () => {
    const merged = mergeRemoteImCommonConfig({
      remoteProgressMode: 'off',
      remoteProgressMaxChars: 100
    })
    expect(merged.remoteProgressMode).toBe('off')
    expect(merged.remoteProgressMaxChars).toBe(100)
    expect(merged.remoteProgressHeartbeatSec).toBe(
      DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteProgressHeartbeatSec
    )
  })

  it('normalizes legacy confirm policies to im_confirm', () => {
    expect(normalizeImConfirmPolicy('feishu_confirm')).toBe('im_confirm')
    expect(normalizeImConfirmPolicy('wechat_confirm')).toBe('im_confirm')
    expect(mergeRemoteImCommonConfig({ remoteConfirmPolicy: 'feishu_confirm' }).remoteConfirmPolicy).toBe(
      'im_confirm'
    )
  })

  it('migrates remote_read_only to deny write + deny outbound', () => {
    const merged = mergeRemoteImCommonConfig({ remoteConfirmPolicy: 'remote_read_only' })
    expect(merged.remoteConfirmPolicy).toBe('remote_read_only')
    expect(merged.remoteAllowLocalWrite).toBe(false)
    expect(merged.remoteDenyOutbound).toBe(true)
  })

  it('forces deny write + deny outbound for full legacy remote_read_only stock configs', () => {
    // Typical stored shape: policy remote_read_only + historical allowLocalWrite:true default.
    const merged = mergeRemoteImCommonConfig({
      remoteConfirmPolicy: 'remote_read_only',
      remoteAllowLocalWrite: true,
      remoteDenyOutbound: false
    })
    expect(merged.remoteAllowLocalWrite).toBe(false)
    expect(merged.remoteDenyOutbound).toBe(true)
  })

  it('migrateRemoteReadOnlyPolicy and one-click restrict helpers', () => {
    expect(
      migrateRemoteReadOnlyPolicy({
        policy: 'always',
        defaults: { remoteAllowLocalWrite: true, remoteDenyOutbound: false }
      })
    ).toEqual({ remoteAllowLocalWrite: true, remoteDenyOutbound: false })

    const restricted = applyRemoteRestrictWritesAndOutbound(true)
    expect(restricted).toEqual({ remoteAllowLocalWrite: false, remoteDenyOutbound: true })
    expect(isRemoteRestrictWritesAndOutbound({ ...DEFAULT_REMOTE_IM_COMMON_CONFIG, ...restricted })).toBe(
      true
    )
    expect(isRemoteRestrictWritesAndOutbound(DEFAULT_REMOTE_IM_COMMON_CONFIG)).toBe(false)
  })
})
