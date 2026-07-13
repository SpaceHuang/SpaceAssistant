import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import type { AppConfig } from '../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../../shared/feishuTypes'
import { DEFAULT_WECHAT_CONFIG } from '../../shared/wechatTypes'
import configReducer, {
  applyRemoteImCommonPatch,
  setConfig,
  updateRemoteImCommon
} from './configSlice'

function makeMinimalConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    feishu: { ...DEFAULT_FEISHU_CONFIG },
    wechat: { ...DEFAULT_WECHAT_CONFIG },
    ...overrides
  } as AppConfig
}

describe('applyRemoteImCommonPatch', () => {
  it('writes the same fields into both feishu and wechat', () => {
    const cfg = makeMinimalConfig()
    const next = applyRemoteImCommonPatch(cfg, {
      remoteRateLimitPerMinute: 7,
      remoteNotifyOnReceive: false,
      remoteSenderAllowlist: ['u1']
    })
    expect(next.feishu.remoteRateLimitPerMinute).toBe(7)
    expect(next.wechat.remoteRateLimitPerMinute).toBe(7)
    expect(next.feishu.remoteNotifyOnReceive).toBe(false)
    expect(next.wechat.remoteNotifyOnReceive).toBe(false)
    expect(next.feishu.remoteSenderAllowlist).toEqual(['u1'])
    expect(next.wechat.remoteSenderAllowlist).toEqual(['u1'])
  })

  it('does not mutate the original config objects', () => {
    const cfg = makeMinimalConfig()
    const feishuBefore = cfg.feishu
    const wechatBefore = cfg.wechat
    applyRemoteImCommonPatch(cfg, { remoteSessionIdleMinutes: 3 })
    expect(feishuBefore.remoteSessionIdleMinutes).toBe(DEFAULT_FEISHU_CONFIG.remoteSessionIdleMinutes)
    expect(wechatBefore.remoteSessionIdleMinutes).toBe(DEFAULT_WECHAT_CONFIG.remoteSessionIdleMinutes)
  })
})

describe('updateRemoteImCommon', () => {
  it('dual-writes into Redux config.feishu and config.wechat', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(setConfig(makeMinimalConfig()))
    store.dispatch(
      updateRemoteImCommon({
        remoteConfirmPolicy: 'im_confirm',
        remoteAllowLocalWrite: false,
        remoteProgressMode: 'off'
      })
    )
    const cfg = store.getState().config.config!
    expect(cfg.feishu.remoteConfirmPolicy).toBe('im_confirm')
    expect(cfg.wechat.remoteConfirmPolicy).toBe('im_confirm')
    expect(cfg.feishu.remoteAllowLocalWrite).toBe(false)
    expect(cfg.wechat.remoteAllowLocalWrite).toBe(false)
    expect(cfg.feishu.remoteProgressMode).toBe('off')
    expect(cfg.wechat.remoteProgressMode).toBe('off')
  })

  it('no-ops when config is null', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    expect(() => store.dispatch(updateRemoteImCommon({ remoteRateLimitPerMinute: 1 }))).not.toThrow()
    expect(store.getState().config.config).toBeNull()
  })
})
