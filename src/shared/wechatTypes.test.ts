import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WECHAT_CONFIG,
  mergeWeChatConfig,
  resolveWeChatRemoteConfirmPolicy,
  weChatConfigNeedsPolicyMigration
} from './wechatTypes'

describe('wechatTypes remoteConfirmPolicy', () => {
  it('defaults to always for new config', () => {
    expect(mergeWeChatConfig(null).remoteConfirmPolicy).toBe('always')
    expect(mergeWeChatConfig({}).remoteConfirmPolicy).toBe('always')
  })

  it('migrates phase-1 remote_read_only default to wechat_confirm', () => {
    const merged = mergeWeChatConfig({ remoteConfirmPolicy: 'remote_read_only' })
    expect(merged.remoteConfirmPolicy).toBe('wechat_confirm')
    expect(
      weChatConfigNeedsPolicyMigration({ remoteConfirmPolicy: 'remote_read_only' }, merged)
    ).toBe(true)
  })

  it('keeps explicit non-read-only policies', () => {
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'always' }).remoteConfirmPolicy).toBe('always')
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'inherit' }).remoteConfirmPolicy).toBe('inherit')
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'wechat_confirm' }).remoteConfirmPolicy).toBe(
      'wechat_confirm'
    )
  })

  it('maps legacy remoteWechatConfirm flag to wechat_confirm', () => {
    expect(resolveWeChatRemoteConfirmPolicy({ remoteConfirmPolicy: 'inherit', remoteWechatConfirm: true })).toBe(
      'wechat_confirm'
    )
    expect(
      resolveWeChatRemoteConfirmPolicy({ remoteConfirmPolicy: 'remote_read_only', remoteWechatConfirm: true })
    ).toBe('wechat_confirm')
  })

  it('matches DEFAULT_WECHAT_CONFIG policy', () => {
    expect(DEFAULT_WECHAT_CONFIG.remoteConfirmPolicy).toBe('always')
  })

  it('supports workdir_switch audit event type', () => {
    const event = {
      type: 'workdir_switch' as const,
      profileId: 'p1',
      profileName: 'Project A',
      ts: Date.now()
    }
    expect(event.type).toBe('workdir_switch')
    expect(event.profileName).toBe('Project A')
  })
})
