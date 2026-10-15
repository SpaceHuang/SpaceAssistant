import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEISHU_CONFIG } from '../../src/shared/feishuTypes'
import { createFeishuProgressAdapter } from './feishuProgressAdapter'

describe('Feishu system progress outbound', () => {
  it('does not send progress without authenticated outbound identity', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{"code":0}', stderr: '', timedOut: false }))
    const adapter = createFeishuProgressAdapter({
      runner: { run } as never,
      messageId: 'inbound-message',
      getSessionId: () => 'origin-session',
      config: DEFAULT_FEISHU_CONFIG,
      sessionCommands: {} as never
    })

    adapter.reply('progress update')
    await Promise.resolve()
    await Promise.resolve()

    expect(run).not.toHaveBeenCalled()
  })

  it('binds progress to the authenticated recipient, origin session and inbound message before sending', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{"code":0}', stderr: '', timedOut: false }))
    const adapter = createFeishuProgressAdapter({
      runner: { run } as never,
      messageId: 'inbound-message',
      outboundIdentity: { identityKey: 'chat-owner', ownerId: 'chat-owner', chatType: 'p2p' },
      getSessionId: () => 'origin-session',
      config: DEFAULT_FEISHU_CONFIG,
      sessionCommands: {} as never
    })
    adapter.reply('progress update')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
    expect(JSON.stringify(run.mock.calls[0])).toContain('progress update')
  })
})
