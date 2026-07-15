import { describe, expect, it } from 'vitest'
import {
  isRemoteReadOnlyPolicy,
  normalizeWeChatConfirmPolicy,
  resolveRemoteConfirmPolicy,
  shouldRequestImConfirm
} from './remoteConfirmPolicy'

describe('remoteConfirmPolicy', () => {
  it('inherit resolves to im_confirm for remote sessions', () => {
    expect(resolveRemoteConfirmPolicy({ source: 'wechat', confirmPolicy: 'inherit' })).toBe('im_confirm')
    expect(resolveRemoteConfirmPolicy({ source: 'feishu', confirmPolicy: 'inherit' })).toBe('im_confirm')
  })

  it('wechat_confirm and feishu_confirm resolve to im_confirm', () => {
    expect(resolveRemoteConfirmPolicy({ source: 'wechat', confirmPolicy: 'wechat_confirm' })).toBe('im_confirm')
    expect(resolveRemoteConfirmPolicy({ source: 'feishu', confirmPolicy: 'feishu_confirm' })).toBe('im_confirm')
    expect(resolveRemoteConfirmPolicy({ source: 'wechat', confirmPolicy: 'always' })).toBe('im_confirm')
    expect(resolveRemoteConfirmPolicy({ source: 'feishu', confirmPolicy: 'im_confirm' })).toBe('im_confirm')
  })

  it('remote_read_only no longer blocks IM confirm path (migrated to access switches)', () => {
    expect(resolveRemoteConfirmPolicy({ source: 'wechat', confirmPolicy: 'remote_read_only' })).toBe(
      'im_confirm'
    )
    expect(shouldRequestImConfirm('im_confirm')).toBe(true)
  })

  it('shouldRequestImConfirm is true for im_confirm', () => {
    expect(shouldRequestImConfirm('im_confirm')).toBe(true)
  })

  it('normalizeWeChatConfirmPolicy maps legacy remoteWechatConfirm flag', () => {
    expect(normalizeWeChatConfirmPolicy('inherit', true)).toBe('im_confirm')
    expect(normalizeWeChatConfirmPolicy('remote_read_only', true)).toBe('remote_read_only')
    expect(normalizeWeChatConfirmPolicy('wechat_confirm')).toBe('im_confirm')
  })

  it('isRemoteReadOnlyPolicy detects read-only', () => {
    expect(isRemoteReadOnlyPolicy('remote_read_only')).toBe(true)
    expect(isRemoteReadOnlyPolicy('wechat_confirm')).toBe(false)
    expect(isRemoteReadOnlyPolicy('im_confirm')).toBe(false)
  })
})
