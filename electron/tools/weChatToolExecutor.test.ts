import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMockWeChatBot } from '../wechat/__mocks__/wechatBotMock'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'

const { getBundle } = vi.hoisted(() => ({ getBundle: vi.fn() }))
vi.mock('../wechat/weChatIpc', () => ({
  getWeChatBundle: getBundle
}))

import { executeWeChatReply, executeWeChatSend } from './weChatToolExecutor'
import { wechatReplyExecutor } from './wechatExecutors'

describe('executeWeChatSend', () => {
  let workDir: string
  const mockBot = createMockWeChatBot()

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-tool-'))
    vi.clearAllMocks()
    getBundle.mockReturnValue(null)
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('rejects when wechat disabled', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hi' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: false })
      }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('未绑定')
  })

  it('rejects path outside workDir', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hi', filePath: '../../../etc/passwd' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
      }
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/工作目录|不存在/)
  })

  it('拒绝工作目录内指向外部的附件 symlink，并返回机制诊断', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-media-outside-'))
    const outsideFile = path.join(outsideDir, 'private.txt')
    const linkedFile = path.join(workDir, 'shared.txt')
    await fs.writeFile(outsideFile, 'private content')
    await fs.symlink(outsideFile, linkedFile)
    try {
      const result = await executeWeChatSend(
        { userId: 'u1', text: 'share', filePath: 'shared.txt' },
        {
          workDir,
          botService: { getRawBot: () => mockBot } as never,
          getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
        }
      )

      expect(result).toMatchObject({
        success: false,
        diagnostic: { caseId: 'wechat-media-target-outside-workdir', category: 'mechanism' }
      })
      expect(mockBot.send).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('sends text when configured', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hello' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
      }
    )
    expect(result.success).toBe(true)
    expect(mockBot.send).toHaveBeenCalled()
  })

  it('WeChat send API 已进入后连接断开时拒绝并保留结果未知语义', async () => {
    mockBot.send.mockRejectedValue(new Error('socket closed after request write'))

    await expect(executeWeChatSend(
      { userId: 'u1', text: 'hello' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
      }
    )).rejects.toMatchObject({ name: 'WeChatOutboundExecutionUncertainError' })

    expect(mockBot.send).toHaveBeenCalledOnce()
  })

  it('dispatch lease 在 WeChat send 副作用调用前取消时不调用 bot', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hello' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }),
        signal: controller.signal
      }
    )

    expect(result).toMatchObject({ success: false, error: '微信发送已取消' })
    expect(mockBot.send).not.toHaveBeenCalled()
  })

  it('WeChat send API 已进入后撤权仍等待真实结果，不把可能成功的副作用误报为取消', async () => {
    let finishSend!: () => void
    mockBot.send.mockImplementation(() => new Promise<void>((resolve) => { finishSend = resolve }))
    const controller = new AbortController()
    const resultPromise = executeWeChatSend(
      { userId: 'u1', text: 'hello' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }),
        signal: controller.signal
      }
    )

    await vi.waitFor(() => expect(mockBot.send).toHaveBeenCalledOnce())
    controller.abort()
    finishSend()
    await expect(resultPromise).resolves.toMatchObject({ success: true, chunksSent: 1 })
  })

  it('拒绝回复授权 messageId 之外的当前入站消息', async () => {
    const inbound = {
      userId: 'wx-user',
      timestamp: new Date(1_000),
      raw: { client_id: 'message-current' }
    }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })

    const result = await executeWeChatReply(
      { text: 'reply text' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        db: {} as never,
        sessionId: 'session-current',
        expectedMessageId: 'message-approved'
      }
    )

    expect(result).toMatchObject({ success: false, error: '微信入站消息已变化，请重新授权回复' })
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('WeChat reply API 已进入后连接断开时拒绝并保留结果未知语义', async () => {
    const inbound = {
      userId: 'wx-user',
      timestamp: new Date(1_000),
      raw: { client_id: 'message-approved' }
    }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    mockBot.reply.mockRejectedValue(new Error('socket closed after request write'))

    await expect(executeWeChatReply(
      { text: 'reply text' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        db: {} as never,
        sessionId: 'session-current',
        expectedMessageId: 'message-approved'
      }
    )).rejects.toMatchObject({ name: 'WeChatOutboundExecutionUncertainError', operation: 'reply' })

    expect(mockBot.reply).toHaveBeenCalledOnce()
  })

  it('wechat_reply adapter 将授权 messageId 传到真实回复副作用边界', async () => {
    const inbound = {
      userId: 'wx-user',
      timestamp: new Date(1_000),
      raw: { client_id: 'message-current' }
    }
    getBundle.mockReturnValue({
      botService: { getRawBot: () => mockBot },
      auditLogger: { append: vi.fn().mockResolvedValue(undefined) },
      router: { getInboundForSession: () => inbound }
    })

    const result = await wechatReplyExecutor.execute({ text: 'reply text' }, {
      workDir,
      userDataDir: workDir,
      requestId: 'wechat-request',
      toolUseId: 'wechat-reply-call',
      sessionId: 'session-current',
      sendProgress: vi.fn(),
      signal: new AbortController().signal,
      fileStateCache: {} as never,
      toolsConfig: {} as never,
      appDatabase: {} as never,
      remoteContext: {
        source: 'wechat',
        messageId: 'message-approved',
        userId: 'wx-user',
        confirmPolicy: 'always'
      }
    })

    expect(result).toMatchObject({ success: false, error: '微信入站消息已变化，请重新授权回复' })
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('Hosted wechat_reply 的撤权 signal 传到发送前边界并阻止 bot.reply', async () => {
    const inbound = {
      userId: 'wx-user',
      timestamp: new Date(1_000),
      raw: { client_id: 'message-approved' }
    }
    getBundle.mockReturnValue({
      botService: { getRawBot: () => mockBot },
      auditLogger: { append: vi.fn().mockResolvedValue(undefined) },
      router: { getInboundForSession: () => inbound }
    })
    const controller = new AbortController()
    controller.abort()
    const result = await wechatReplyExecutor.execute({ text: 'reply text' }, {
      workDir,
      userDataDir: workDir,
      requestId: 'wechat-request',
      toolUseId: 'wechat-reply-call',
      sessionId: 'session-current',
      sendProgress: vi.fn(),
      signal: controller.signal,
      fileStateCache: {} as never,
      toolsConfig: {} as never,
      appDatabase: {} as never,
      remoteContext: { source: 'wechat', messageId: 'message-approved', userId: 'wx-user', confirmPolicy: 'always' }
    })

    expect(result).toMatchObject({ success: false, error: '微信回复已取消' })
    expect(mockBot.reply).not.toHaveBeenCalled()
  })
})
