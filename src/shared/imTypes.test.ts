import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_IM_COMMON_CONFIG,
  mergeRemoteImCommonConfig,
  normalizeImConfirmPolicy
} from './imTypes'

describe('imTypes', () => {
  it('mergeRemoteImCommonConfig returns defaults for null', () => {
    const merged = mergeRemoteImCommonConfig(null)
    expect(merged.remoteEnabled).toBe(DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteEnabled)
    expect(merged.remoteConfirmPolicy).toBe('always')
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
})
