import { describe, expect, it } from 'vitest'
import {
  FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
  REMOTE_CONFIRM_TIMEOUT_MESSAGES,
  resolveRemoteContextConfirmPolicy,
  WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE
} from './remoteConfirmPolicy'

describe('remoteConfirmPolicy', () => {
  it('wechat inherit resolves to im_confirm', () => {
    expect(
      resolveRemoteContextConfirmPolicy({
        source: 'wechat',
        confirmPolicy: 'inherit',
        messageId: 'm1',
        userId: 'u1',
        contextToken: 'c'
      })
    ).toBe('im_confirm')
  })

  it('feishu inherit resolves to im_confirm', () => {
    expect(
      resolveRemoteContextConfirmPolicy({ source: 'feishu', confirmPolicy: 'inherit', messageId: 'm1' })
    ).toBe('im_confirm')
  })

  it('remote_read_only resolves to im_confirm (policy no longer blocks confirm)', () => {
    expect(
      resolveRemoteContextConfirmPolicy({
        source: 'wechat',
        confirmPolicy: 'remote_read_only',
        messageId: 'm1',
        userId: 'u1',
        contextToken: 'c'
      })
    ).toBe('im_confirm')
  })

  it('wechat remoteWechatConfirm legacy still normalizes via wechatConfig', () => {
    expect(
      resolveRemoteContextConfirmPolicy(
        { source: 'wechat', confirmPolicy: 'inherit', messageId: 'm1', userId: 'u1', contextToken: 'c' },
        { remoteWechatConfirm: true } as never
      )
    ).toBe('im_confirm')
  })

  it('exports stable timeout messages by source', () => {
    expect(REMOTE_CONFIRM_TIMEOUT_MESSAGES.feishu).toBe(FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE)
    expect(REMOTE_CONFIRM_TIMEOUT_MESSAGES.wechat).toBe(WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE)
    expect(FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE).toContain('10分钟')
    expect(WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE).toContain('5分钟')
  })
})

describe('feishuProgressAdapter', () => {
  it('creates adapter with feishu channel', async () => {
    const { createFeishuProgressAdapter } = await import('./feishuProgressAdapter')
    const adapter = createFeishuProgressAdapter({
      runner: { run: () => Promise.resolve({ exitCode: 0 }) } as never,
      messageId: 'm1',
      sessionId: 's1',
      config: { enabled: true } as never,
      db: {} as never
    })
    expect(adapter.channel).toBe('feishu')
    expect(adapter.sendTyping).toBeUndefined()
  })
})
