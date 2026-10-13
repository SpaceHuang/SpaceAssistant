import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import type { AppConfig } from '../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../../shared/feishuTypes'
import { DEFAULT_WECHAT_CONFIG } from '../../shared/wechatTypes'
import configReducer, {
  applyRemoteImCommonPatch,
  openSettings,
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

describe('legacy settings deep links', () => {
  it('routes old remote security links to the single shared policy settings tab', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(openSettings({ tab: 'remote-security' }))
    expect(store.getState().config).toMatchObject({
      settingsOpen: true,
      settingsActiveTab: 'tools',
      settingsToolsSubTab: 'security'
    })
  })
})

describe('updateRemoteImCommon', () => {
  it('drops legacy channel policy fields from stale config imports and settings cache actions', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    const legacyConfig = makeMinimalConfig({
      feishu: { ...DEFAULT_FEISHU_CONFIG, remoteDenyOutbound: true, remoteConfirmPolicy: 'remote_read_only' } as never,
      wechat: { ...DEFAULT_WECHAT_CONFIG, remoteAllowLocalWrite: false, remoteWechatConfirm: true } as never
    })
    store.dispatch(setConfig(legacyConfig))
    store.dispatch(updateRemoteImCommon({ remoteAllowLocalWrite: false, remoteDenyOutbound: true } as never))

    const cfg = store.getState().config.config!
    expect(cfg.feishu).not.toHaveProperty('remoteDenyOutbound')
    expect(cfg.feishu).not.toHaveProperty('remoteConfirmPolicy')
    expect(cfg.wechat).not.toHaveProperty('remoteAllowLocalWrite')
    expect(cfg.wechat).not.toHaveProperty('remoteWechatConfirm')
  })

  it('dual-writes non-policy shared fields and ignores stale security keys', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(setConfig(makeMinimalConfig()))
    store.dispatch(
      updateRemoteImCommon({
        remoteAllowLocalWrite: false,
        remoteProgressMode: 'off'
      } as never)
    )
    const cfg = store.getState().config.config!
    expect(cfg.feishu).not.toHaveProperty('remoteAllowLocalWrite')
    expect(cfg.wechat).not.toHaveProperty('remoteAllowLocalWrite')
    expect(cfg.feishu.remoteProgressMode).toBe('off')
    expect(cfg.wechat.remoteProgressMode).toBe('off')
  })

  it('no-ops when config is null', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    expect(() => store.dispatch(updateRemoteImCommon({ remoteRateLimitPerMinute: 1 }))).not.toThrow()
    expect(store.getState().config.config).toBeNull()
  })
})
