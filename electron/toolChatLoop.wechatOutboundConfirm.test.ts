import { describe, expect, it } from 'vitest'
import {
  evaluateRemoteToolBlockForTests,
  toolNeedsUserConfirmationForTests
} from './toolChatLoop'
import { DEFAULT_WECHAT_CONFIG, type WeChatConfig } from '../src/shared/wechatTypes'
import type { RemoteContext } from './tools/types'

function wechatCtx(
  confirmPolicy: WeChatConfig['remoteConfirmPolicy'] = 'always'
): RemoteContext {
  return {
    source: 'wechat',
    messageId: 'm1',
    userId: 'u1',
    contextToken: 'c',
    confirmPolicy
  }
}

describe('wechat outbound confirm removal', () => {
  it('wechat_reply does not need confirmation even when legacy flag is true', () => {
    expect(
      toolNeedsUserConfirmationForTests('wechat_reply', { text: 'hi' }, undefined, {
        ...DEFAULT_WECHAT_CONFIG,
        wechatSendRequiresConfirm: true
      })
    ).toBe(false)
  })

  it('wechat_send does not need confirmation even when legacy flag is true', () => {
    expect(
      toolNeedsUserConfirmationForTests(
        'wechat_send',
        { userId: 'u1', text: 'hi' },
        undefined,
        {
          ...DEFAULT_WECHAT_CONFIG,
          wechatSendRequiresConfirm: true
        }
      )
    ).toBe(false)
  })

  it('remoteDenyOutbound blocks wechat_reply and wechat_send', () => {
    const ctx = wechatCtx('always')
    const cfg = { ...DEFAULT_WECHAT_CONFIG, remoteDenyOutbound: true }
    expect(evaluateRemoteToolBlockForTests('wechat_reply', { text: 'hi' }, ctx, undefined, cfg)).toBe(
      '远程策略禁止此类写操作。'
    )
    expect(
      evaluateRemoteToolBlockForTests(
        'wechat_send',
        { userId: 'u1', text: 'hi' },
        ctx,
        undefined,
        cfg
      )
    ).toBe('远程策略禁止此类写操作。')
  })

  it('legacy remote_read_only policy alone no longer blocks outbound without deny flag', () => {
    const ctx = wechatCtx('remote_read_only')
    expect(
      evaluateRemoteToolBlockForTests('wechat_reply', { text: 'hi' }, ctx, undefined, DEFAULT_WECHAT_CONFIG)
    ).toBeNull()
  })

  it('always / im_confirm / inherit allow outbound without remote block', () => {
    for (const policy of ['always', 'im_confirm', 'inherit'] as const) {
      const ctx = wechatCtx(policy)
      expect(
        evaluateRemoteToolBlockForTests('wechat_reply', { text: 'hi' }, ctx, undefined, DEFAULT_WECHAT_CONFIG)
      ).toBeNull()
      expect(
        evaluateRemoteToolBlockForTests(
          'wechat_send',
          { userId: 'u1', text: 'hi' },
          ctx,
          undefined,
          DEFAULT_WECHAT_CONFIG
        )
      ).toBeNull()
    }
  })

  it('write_file still needs confirmation under builtin policy without remote context', () => {
    expect(toolNeedsUserConfirmationForTests('write_file', { path: 'a.txt', content: 'x' })).toBe(true)
  })
})
