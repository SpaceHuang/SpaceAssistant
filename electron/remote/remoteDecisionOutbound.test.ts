import { describe, expect, it, vi } from 'vitest'
import {
  createArtifactDecisionAuditAppender,
  createFeishuSendDecisionText,
  createWeChatSendDecisionText
} from './remoteDecisionOutbound'

describe('remoteDecisionOutbound adapters', () => {
  it('feishu sendDecisionText is text-only and sends via bound messageId', async () => {
    const calls: Array<{ messageId: string; body: string }> = []
    const spy = vi
      .spyOn(await import('../feishu/feishuRemoteOutbound'), 'sendFeishuRemoteOutbound')
      .mockImplementation(async (args) => {
        calls.push({ messageId: args.messageId, body: args.body })
      })
    const send = createFeishuSendDecisionText({
      runner: {} as never,
      messageId: 'msg-bound',
      chatId: 'chat-bound',
      sessionId: 'sess-1'
    })
    expect(send.length).toBe(1)
    await send('hello-feishu')
    expect(calls).toEqual([{ messageId: 'msg-bound', body: 'hello-feishu' }])
    spy.mockRestore()
  })

  it('wechat sendDecisionText is text-only and sends via bound inbound/userId', async () => {
    const calls: Array<{ userId: string; body: string }> = []
    const inbound = { user_id: 'wx-user' } as never
    const spy = vi
      .spyOn(await import('../wechat/weChatRemoteOutbound'), 'sendWeChatRemoteOutbound')
      .mockImplementation(async (args) => {
        calls.push({
          userId: String((args.inbound as { user_id?: string }).user_id ?? ''),
          body: args.body
        })
      })
    const send = createWeChatSendDecisionText({
      bot: { reply: vi.fn() } as never,
      inbound,
      userId: 'wx-user',
      sessionId: 'sess-wx'
    })
    expect(send.length).toBe(1)
    await send('hello-wechat')
    expect(calls).toEqual([{ userId: 'wx-user', body: 'hello-wechat' }])
    spy.mockRestore()
  })

  it('decision outbound does not invoke Agent tool paths', async () => {
    const toolCalls: string[] = []
    const feishuSpy = vi
      .spyOn(await import('../feishu/feishuRemoteOutbound'), 'sendFeishuRemoteOutbound')
      .mockResolvedValue(undefined)
    const wechatSpy = vi
      .spyOn(await import('../wechat/weChatRemoteOutbound'), 'sendWeChatRemoteOutbound')
      .mockResolvedValue(undefined)
    await createFeishuSendDecisionText({
      runner: {
        run: async (cmd: string) => {
          toolCalls.push(cmd)
        }
      } as never,
      messageId: 'm1',
      chatId: 'c1'
    })('t1')
    await createWeChatSendDecisionText({
      bot: {
        reply: async () => {
          toolCalls.push('wechat_reply')
        }
      } as never,
      inbound: {} as never,
      userId: 'u1'
    })('t2')
    expect(toolCalls).toEqual([])
    expect(feishuSpy).toHaveBeenCalledTimes(1)
    expect(wechatSpy).toHaveBeenCalledTimes(1)
    feishuSpy.mockRestore()
    wechatSpy.mockRestore()
  })

  it('maps audit events to channel-prefixed types', async () => {
    const entries: Record<string, unknown>[] = []
    const append = createArtifactDecisionAuditAppender({
      source: 'wechat',
      append: (entry) => {
        entries.push(entry)
      }
    })
    await append('prompt_failed', { errorClass: 'Error', summary: 'boom' })
    expect(entries).toEqual([
      { type: 'wechat.artifact_decision.prompt_failed', errorClass: 'Error', summary: 'boom' }
    ])
  })

  it('does not throw when prompt audit fails after a successful send', async () => {
    const { sendRemoteArtifactDecisionPrompt } = await import('./remoteDecisionOutbound')
    const send = vi.fn().mockResolvedValue(undefined)
    const appendAudit = vi.fn().mockRejectedValue(new Error('audit down'))
    await expect(
      sendRemoteArtifactDecisionPrompt({
        sendDecisionText: send,
        appendAudit,
        text: 'prompt',
        decisionId: 'd1',
        kind: 'overwrite',
        originSessionId: 's1',
        requestId: 'r1'
      })
    ).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledOnce()
  })

  it('throws and records prompt_failed when send fails', async () => {
    const { sendRemoteArtifactDecisionPrompt } = await import('./remoteDecisionOutbound')
    const send = vi.fn().mockRejectedValue(new Error('network'))
    const appendAudit = vi.fn().mockResolvedValue(undefined)
    await expect(
      sendRemoteArtifactDecisionPrompt({
        sendDecisionText: send,
        appendAudit,
        text: 'prompt',
        decisionId: 'd1',
        kind: 'overwrite',
        originSessionId: 's1',
        requestId: 'r1'
      })
    ).rejects.toThrow('network')
    expect(appendAudit).toHaveBeenCalledWith(
      'prompt_failed',
      expect.objectContaining({ decisionId: 'd1', summary: 'network' })
    )
  })
})
