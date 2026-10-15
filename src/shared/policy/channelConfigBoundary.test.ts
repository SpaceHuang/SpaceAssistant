import { describe, expect, expectTypeOf, it } from 'vitest'
import { mergeFeishuConfig, type FeishuConfig } from '../feishuTypes'
import { mergeWeChatConfig, type WeChatConfig } from '../wechatTypes'
import { DEFAULT_REMOTE_IM_COMMON_CONFIG, DEFAULT_REMOTE_TASK_BUDGET, mergeRemoteImCommonConfig, type RemoteImCommonConfig } from '../imTypes'

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
type AssertFalse<T extends false> = T

type LegacySecurityKeys =
  | 'remoteConfirmPolicy'
  | 'remoteWechatConfirm'
  | 'remoteAllowLocalWrite'
  | 'remoteDenyOutbound'
  | 'remoteBrowserRequiresConfirm'
  | 'remoteBrowserNavigateRequiresConfirm'
  | 'remoteBrowserActRequiresConfirm'
  | 'remoteScriptRequiresConfirm'
  | 'remoteSecurityConfigVersion'
  | 'remoteSecurityPresetSource'
  | 'larkCliWriteRequiresConfirm'
  | 'wechatSendRequiresConfirm'
type WeChatPolicyBoundaries = AssertFalse<HasKey<WeChatConfig, LegacySecurityKeys>>
type FeishuPolicyBoundaries = AssertFalse<HasKey<FeishuConfig, LegacySecurityKeys>>
type CommonPolicyBoundaries = AssertFalse<HasKey<RemoteImCommonConfig, LegacySecurityKeys>>
export type ChannelConfigBoundaryContracts =
  | WeChatPolicyBoundaries
  | FeishuPolicyBoundaries
  | CommonPolicyBoundaries

describe('channel config policy boundary', () => {
  it('keeps active IM security decisions out of WeChat and Feishu connection configs', () => {
    expectTypeOf<HasKey<WeChatConfig, LegacySecurityKeys>>().toEqualTypeOf<false>()
    expectTypeOf<HasKey<FeishuConfig, LegacySecurityKeys>>().toEqualTypeOf<false>()
    expectTypeOf<HasKey<RemoteImCommonConfig, LegacySecurityKeys>>().toEqualTypeOf<false>()
  })

  it('drops all legacy security keys when normalizing either channel config', () => {
    const legacy = Object.fromEntries([...LEGACY_KEYS, 'remoteTaskBudget'].map((key) => [key, 'legacy-value']))
    const wechat = mergeWeChatConfig(legacy as never)
    const feishu = mergeFeishuConfig(legacy as never)
    for (const key of LEGACY_KEYS) {
      expect(wechat).not.toHaveProperty(key)
      expect(feishu).not.toHaveProperty(key)
    }
    expect(wechat.remoteTaskBudget).toEqual(DEFAULT_REMOTE_TASK_BUDGET)
    expect(feishu.remoteTaskBudget).toEqual(DEFAULT_REMOTE_TASK_BUDGET)
  })

  it('does not project legacy security values into the normalized common config', () => {
    const merged = mergeRemoteImCommonConfig(
      Object.fromEntries(LEGACY_KEYS.map((key) => [key, 'legacy-value'])) as never
    )
    for (const key of LEGACY_KEYS) expect(merged).not.toHaveProperty(key)
    expect(merged.remoteTaskBudget).toBeUndefined()
    expect(merged).toMatchObject({
      remoteEnabled: DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteEnabled,
      remoteRateLimitPerMinute: DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteRateLimitPerMinute
    })
  })
})

const LEGACY_KEYS: LegacySecurityKeys[] = [
  'remoteConfirmPolicy', 'remoteWechatConfirm', 'remoteAllowLocalWrite', 'remoteDenyOutbound',
  'remoteBrowserRequiresConfirm', 'remoteBrowserNavigateRequiresConfirm', 'remoteBrowserActRequiresConfirm',
  'remoteScriptRequiresConfirm', 'remoteSecurityConfigVersion', 'remoteSecurityPresetSource',
  'larkCliWriteRequiresConfirm', 'wechatSendRequiresConfirm'
]
