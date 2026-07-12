import { describe, expect, it } from 'vitest'
import { resolveRemoteContextConfirmPolicy } from './remoteConfirmBridge'

describe('remoteConfirmBridge policy', () => {
  it('wechat inherit resolves to im_confirm', () => {
    expect(
      resolveRemoteContextConfirmPolicy({ source: 'wechat', confirmPolicy: 'inherit', messageId: 'm1', userId: 'u1', contextToken: 'c' })
    ).toBe('im_confirm')
  })

  it('feishu inherit resolves to im_confirm', () => {
    expect(
      resolveRemoteContextConfirmPolicy({ source: 'feishu', confirmPolicy: 'inherit', messageId: 'm1' })
    ).toBe('im_confirm')
  })

  it('remote_read_only blocks im confirm', () => {
    expect(
      resolveRemoteContextConfirmPolicy({ source: 'wechat', confirmPolicy: 'remote_read_only', messageId: 'm1', userId: 'u1', contextToken: 'c' })
    ).toBe('remote_read_only')
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
