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
    expect(mergeWeChatConfig(null).remoteDenyOutbound).toBe(false)
  })

  it('migrates remote_read_only to access switches and retains policy field', () => {
    const stored = { remoteConfirmPolicy: 'remote_read_only' as const }
    const merged = mergeWeChatConfig(stored)
    expect(merged.remoteConfirmPolicy).toBe('remote_read_only')
    expect(merged.remoteAllowLocalWrite).toBe(false)
    expect(merged.remoteDenyOutbound).toBe(true)
    expect(weChatConfigNeedsPolicyMigration(stored, merged)).toBe(true)
  })

  it('forces deny write for full legacy remote_read_only stock config', () => {
    const merged = mergeWeChatConfig({
      remoteConfirmPolicy: 'remote_read_only',
      remoteAllowLocalWrite: true,
      remoteDenyOutbound: false
    })
    expect(merged.remoteAllowLocalWrite).toBe(false)
    expect(merged.remoteDenyOutbound).toBe(true)
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
    ).toBe('remote_read_only')
  })

  it('matches DEFAULT_WECHAT_CONFIG policy', () => {
    expect(DEFAULT_WECHAT_CONFIG.remoteConfirmPolicy).toBe('always')
    expect(DEFAULT_WECHAT_CONFIG.remoteDenyOutbound).toBe(false)
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
