import { describe, expect, it, vi } from 'vitest'
import {
  createFeishuRequestToolConfirm,
  createWeChatRequestToolConfirm,
  FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
  REMOTE_CONFIRM_TIMEOUT_MESSAGES,
  requestRemoteConfirm,
  resolveRemoteContextConfirmPolicy,
  WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE
} from './remoteConfirmBridge'
import type { RemoteConfirmPayload, RemoteContext } from '../tools/types'

describe('remoteConfirmBridge policy', () => {
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
})

describe('requestRemoteConfirm unified path', () => {
  const basePayload: RemoteConfirmPayload = {
    sessionId: 's1',
    toolCallId: 't1',
    toolName: 'write_file',
    toolInput: { path: 'a.txt' },
    messageId: 'm1'
  }

  it('delegates to requestToolConfirm even when legacy remote_read_only is set', async () => {
    const requestToolConfirm = vi.fn(async () => 'y' as const)
    const remoteContext: RemoteContext = {
      source: 'feishu',
      messageId: 'm1',
      confirmPolicy: 'remote_read_only',
      requestToolConfirm
    }
    await expect(requestRemoteConfirm({ remoteContext, payload: basePayload })).resolves.toBe('y')
    expect(requestToolConfirm).toHaveBeenCalledWith(basePayload)
  })

  it('returns n when requestToolConfirm is missing', async () => {
    const remoteContext: RemoteContext = {
      source: 'feishu',
      messageId: 'm1',
      confirmPolicy: 'always'
    }
    await expect(requestRemoteConfirm({ remoteContext, payload: basePayload })).resolves.toBe('n')
  })

  it('delegates to requestToolConfirm after policy check', async () => {
    const requestToolConfirm = vi.fn(async () => 'y' as const)
    const remoteContext: RemoteContext = {
      source: 'wechat',
      messageId: 'm1',
      confirmPolicy: 'im_confirm',
      userId: 'u1',
      requestToolConfirm
    }
    await expect(requestRemoteConfirm({ remoteContext, payload: basePayload })).resolves.toBe('y')
    expect(requestToolConfirm).toHaveBeenCalledWith(basePayload)
  })

  it('createFeishuRequestToolConfirm adapts confirmManager.requestConfirm', async () => {
    const requestConfirm = vi.fn(async () => 'timeout' as const)
    const adapter = createFeishuRequestToolConfirm({ requestConfirm } as never)
    const decision = await adapter({ ...basePayload, chatId: 'oc_1' })
    expect(decision).toBe('timeout')
    expect(requestConfirm).toHaveBeenCalledWith({
      kind: 'tool_write',
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'write_file',
      toolInput: { path: 'a.txt' },
      messageId: 'm1',
      chatId: 'oc_1'
    })
  })

  it('createWeChatRequestToolConfirm adapts confirmManager with imPrompt', async () => {
    const requestConfirm = vi.fn(async () => 'y' as const)
    const inboundRaw = { message_id: 'raw1' } as never
    const adapter = createWeChatRequestToolConfirm({
      confirmManager: { requestConfirm } as never,
      wechatConfig: { remoteEnabled: true } as never,
      userId: 'u1',
      inboundRaw
    })
    const decision = await adapter({ ...basePayload, userId: 'u2' })
    expect(decision).toBe('y')
    expect(requestConfirm).toHaveBeenCalledTimes(1)
    const [pending, config, timeoutMs, options] = requestConfirm.mock.calls[0]
    expect(pending).toMatchObject({
      kind: 'tool_write',
      userId: 'u2',
      inboundMsg: inboundRaw
    })
    expect(config).toEqual({ remoteEnabled: true })
    expect(timeoutMs).toBeUndefined()
    expect(options).toMatchObject({ imPrompt: expect.stringContaining('write_file') })
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
