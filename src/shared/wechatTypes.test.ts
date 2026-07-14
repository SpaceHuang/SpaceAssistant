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

  it('migrates phase-1 remote_read_only default to im_confirm', () => {
    const merged = mergeWeChatConfig({ remoteConfirmPolicy: 'remote_read_only' })
    expect(merged.remoteConfirmPolicy).toBe('im_confirm')
    expect(
      weChatConfigNeedsPolicyMigration({ remoteConfirmPolicy: 'remote_read_only' }, merged)
    ).toBe(true)
  })

  it('keeps explicit non-read-only policies and maps wechat_confirm', () => {
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'always' }).remoteConfirmPolicy).toBe('always')
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'inherit' }).remoteConfirmPolicy).toBe('inherit')
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'wechat_confirm' }).remoteConfirmPolicy).toBe(
      'im_confirm'
    )
    expect(mergeWeChatConfig({ remoteConfirmPolicy: 'im_confirm' }).remoteConfirmPolicy).toBe('im_confirm')
  })

  it('maps legacy remoteWechatConfirm flag to im_confirm', () => {
    expect(resolveWeChatRemoteConfirmPolicy({ remoteConfirmPolicy: 'inherit', remoteWechatConfirm: true })).toBe(
      'im_confirm'
    )
    expect(
      resolveWeChatRemoteConfirmPolicy({ remoteConfirmPolicy: 'remote_read_only', remoteWechatConfirm: true })
    ).toBe('im_confirm')
  })

  it('matches DEFAULT_WECHAT_CONFIG policy', () => {
    expect(DEFAULT_WECHAT_CONFIG.remoteConfirmPolicy).toBe('always')
  })

  it('defaults wechatSendRequiresConfirm to false and tolerates legacy true', () => {
    expect(DEFAULT_WECHAT_CONFIG.wechatSendRequiresConfirm).toBe(false)
    expect(mergeWeChatConfig(null).wechatSendRequiresConfirm).toBe(false)
    const legacy = mergeWeChatConfig({ wechatSendRequiresConfirm: true })
    expect(legacy.wechatSendRequiresConfirm).toBe(true)
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
