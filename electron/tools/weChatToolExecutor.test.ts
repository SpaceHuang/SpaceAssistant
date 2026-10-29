import fs from 'fs/promises'
import { createHash } from 'node:crypto'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMockWeChatBot } from '../wechat/__mocks__/wechatBotMock'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { canCreateSymlinks } from '../../src/test/symlinkCapability'

const { getBundle, readWeChatConfig } = vi.hoisted(() => ({ getBundle: vi.fn(), readWeChatConfig: vi.fn() }))
vi.mock('../wechat/weChatIpc', () => ({
  getWeChatBundle: getBundle,
  readWeChatConfigFromDb: readWeChatConfig
}))

import { executeWeChatReply, executeWeChatSend, inspectWeChatTaskReplyAttachment } from './weChatToolExecutor'
import { wechatReplyExecutor, wechatSendExecutor } from './wechatExecutors'
import { createWeChatOutboundRegisteredTools } from './wechatOutboundRegisteredTools'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { verifyDeferredWeChatAttachment } from './weChatAttachmentBinding'

const confirmedSendFacts = (body: string, recipient = 'u1', sessionId = 'session-current') => ({
  channel: 'wechat' as const, purpose: 'active-send' as const, originSessionId: sessionId, activeSessionId: sessionId,
  identityKey: 'wx-owner', ownerId: 'wx-owner', recipient, modelRecipient: recipient, chatType: 'p2p' as const,
  content: body, contentAssessment: { source: 'host' as const, content: body, classification: 'ordinary' as const, classifierVersion: 'test-v1' },
  contentCompleteness: 'complete' as const, hasAttachment: false, attachmentAuthorized: false,
  userConfirmationReceipt: 'test-user-confirmation-receipt'
})
const confirmedReplyFacts = (body: string, recipient = 'wx-user', sessionId = 'session-current') => ({
  channel: 'wechat' as const, purpose: 'task-reply' as const, originSessionId: sessionId, activeSessionId: sessionId,
  identityKey: recipient, ownerId: recipient, trustedRecipient: recipient, recipient, chatType: 'p2p' as const,
  content: body, contentAssessment: { source: 'host' as const, content: body, classification: 'ordinary' as const, classifierVersion: 'test-v1' },
  contentCompleteness: 'complete' as const, hasAttachment: false, attachmentAuthorized: false
})

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
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }),
        outboundDeliveryFacts: confirmedSendFacts('hello'), sessionId: 'session-current'
      }
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/工作目录|不存在/)
  })

  // 依赖真实 symlink 的用例以能力探测保护：win32 非特权进程 fs.symlink 直接 EPERM；安全语义由下方 mock 通路覆盖。
  it.skipIf(!canCreateSymlinks())('拒绝工作目录内指向外部的附件 symlink，并返回机制诊断', async () => {
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

  it('mock 通路：realpath 解析到工作目录外时拒绝附件并返回机制诊断（win32 无特权平台的安全语义锚）', async () => {
    const linkAbs = path.resolve(workDir, 'shared.txt')
    const outsideReal = path.resolve(workDir, '..', 'mock-wechat-outside.txt')
    const originalRealpath = fs.realpath.bind(fs)
    const realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...args) => {
      if (String(target) === linkAbs) return outsideReal
      return originalRealpath(target, ...args)
    })
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
      realpathSpy.mockRestore()
    }
  })

  it('sends text when configured', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hello' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }),
        outboundDeliveryFacts: confirmedSendFacts('hello'), sessionId: 'session-current'
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
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }),
        outboundDeliveryFacts: confirmedSendFacts('hello'), sessionId: 'session-current'
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
        signal: controller.signal, outboundDeliveryFacts: confirmedSendFacts('hello'), sessionId: 'session-current'
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
        sessionQueries: { readSession: vi.fn() } as never,
        sessionId: 'session-current',
        expectedMessageId: 'message-approved',
        outboundDeliveryFacts: confirmedReplyFacts('reply text')
      }
    )

    expect(result).toMatchObject({ success: false, error: '微信入站消息已变化，请重新授权回复' })
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('入站上下文缺失时通过 SessionQueries 校验微信会话身份', async () => {
    getBundle.mockReturnValue({ router: { getInboundForSession: () => undefined } })
    const readSession = vi.fn(() => ({ id: 'session-current', metadata: { source: 'wechat' } }))
    const sessionQueries = { readSession } as never

    const result = await executeWeChatReply(
      { text: 'reply text' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        sessionQueries,
        sessionId: 'session-current'
      }
    )

    expect(readSession).toHaveBeenCalledWith('session-current')
    expect(result).toMatchObject({ success: false, error: '微信入站上下文已过期，请重新发送指令' })
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
        sessionQueries: { readSession: vi.fn() } as never,
        sessionId: 'session-current',
        expectedMessageId: 'message-approved', outboundDeliveryFacts: confirmedReplyFacts('reply text')
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
      outboundDeliveryFacts: { channel: 'wechat', purpose: 'active-send', modelRecipient: 'wx-user',
        contentCompleteness: 'unknown', hasAttachment: false, attachmentAuthorized: false },
      toolUserConfirmed: true,
      sendProgress: vi.fn(),
      signal: new AbortController().signal,
      fileStateCache: {} as never,
      toolsConfig: {} as never,
      appDatabase: {} as never,
      sessionQueries: { readSession: vi.fn() } as never,
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

  it('sends a deferred user-approved reply directly to its bound owner after the platform reply object expires', async () => {
    getBundle.mockReturnValue({ router: { getInboundForSession: () => undefined } })
    mockBot.send.mockReset().mockResolvedValue(undefined)
    const facts = { ...confirmedReplyFacts('approved deferred reply'), contentCompleteness: 'unknown' as const,
      contentAssessment: { source: 'host' as const, content: 'approved deferred reply', classification: 'unknown' as const, classifierVersion: 'host-v1' },
      userConfirmationReceipt: 'confirmation:deferred', currentUserMessageId: 'original-user-message' }
    const result = await executeWeChatReply({ text: 'approved deferred reply' }, {
      workDir, botService: { getRawBot: () => mockBot } as never,
      sessionQueries: { readSession: () => ({ metadata: { source: 'wechat' } }) } as never,
      sessionId: 'session-current', expectedMessageId: 'original-platform-message', outboundDeliveryFacts: facts as never
    })
    expect(result).toMatchObject({ success: true })
    expect(mockBot.send).toHaveBeenCalledOnce()
    expect(mockBot.send).toHaveBeenCalledWith('wx-user', 'approved deferred reply')
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('wechat_reply refuses the side effect when the main process did not bind outbound delivery facts', async () => {
    const inbound = { userId: 'wx-user', timestamp: new Date(1_000), raw: { client_id: 'message-approved' } }
    getBundle.mockReturnValue({
      botService: { getRawBot: () => mockBot },
      auditLogger: { append: vi.fn().mockResolvedValue(undefined) },
      router: { getInboundForSession: () => inbound }
    })
    mockBot.reply.mockClear()

    const result = await wechatReplyExecutor.execute({ text: 'reply text', userId: 'attacker-recipient' }, {
      workDir, userDataDir: workDir, requestId: 'wechat-request', toolUseId: 'wechat-reply-no-delivery-facts',
      sessionId: 'session-current', sendProgress: vi.fn(), signal: new AbortController().signal,
      fileStateCache: {} as never, toolsConfig: {} as never, appDatabase: {} as never,
      sessionQueries: { readSession: vi.fn() } as never,
      remoteContext: { source: 'wechat', messageId: 'message-approved', userId: 'wx-user', authOwner: 'wx-user',
        originSessionId: 'session-current' }
    })
    expect(mockBot.reply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, error: '微信外发缺少主进程最终检查事实' })
  })

  it('wechat_send refuses a credential file even when main-process ordinary-content assessment says allow', async () => {
    await fs.writeFile(path.join(workDir, 'client.pem'), '-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----')
    getBundle.mockReturnValue({ botService: { getRawBot: () => mockBot }, auditLogger: { append: vi.fn().mockResolvedValue(undefined) } })
    readWeChatConfig.mockReturnValue({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
    mockBot.send.mockClear()
    const result = await wechatSendExecutor.execute({ userId: 'owner-user', text: 'see attachment', filePath: 'client.pem' }, {
      workDir, userDataDir: workDir, requestId: 'wechat-send-secret-media', toolUseId: 'wechat-send-secret-media-call', sessionId: 'session-current',
      outboundDeliveryFacts: { channel: 'wechat', purpose: 'task-reply', originSessionId: 'session-current', activeSessionId: 'session-current',
        identityKey: 'owner-user', ownerId: 'owner-user', trustedRecipient: 'owner-user', chatType: 'p2p', content: 'see attachment',
        contentAssessment: { source: 'host', content: 'see attachment', classification: 'ordinary', classifierVersion: 'host-test-v1' },
        contentCompleteness: 'complete', hasAttachment: true, attachmentAuthorized: true,
        attachmentContentVersion: 'prepared-file-hash', checkedAttachmentContentVersion: 'prepared-file-hash' },
      toolUserConfirmed: true, sendProgress: vi.fn(), signal: new AbortController().signal, fileStateCache: {} as never,
      toolsConfig: {} as never, appDatabase: {} as never
    })
    expect(mockBot.send).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, error: '微信外发缺少主进程最终检查事实' })
  })

  it('wechat_send media refuses to send without the same main-process final check', async () => {
    await fs.writeFile(path.join(workDir, 'report.txt'), 'approved report')
    getBundle.mockReturnValue({ botService: { getRawBot: () => mockBot }, auditLogger: { append: vi.fn().mockResolvedValue(undefined) } })
    readWeChatConfig.mockReturnValue({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
    mockBot.send.mockClear()

    const result = await wechatSendExecutor.execute({ userId: 'owner-user', text: 'report', filePath: 'report.txt' }, {
      workDir, userDataDir: workDir, requestId: 'wechat-send-media', toolUseId: 'wechat-send-media-call', sessionId: 'session-current',
      sendProgress: vi.fn(), signal: new AbortController().signal, fileStateCache: {} as never, toolsConfig: {} as never,
      appDatabase: {} as never
    })
    expect(mockBot.send).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, error: '微信外发缺少主进程最终检查事实' })
  })

  it.each([
    ['credential attachment', 'client.pem', '-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----'],
    ['local export attachment', 'private-export.txt', 'customer records and private messages']
  ])('wechat_send refuses %s even when an ordinary approval marker is present', async (_label, filename, contents) => {
    await fs.writeFile(path.join(workDir, filename), contents)
    getBundle.mockReturnValue({ botService: { getRawBot: () => mockBot }, auditLogger: { append: vi.fn().mockResolvedValue(undefined) } })
    readWeChatConfig.mockReturnValue({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
    mockBot.send.mockClear()
    const result = await wechatSendExecutor.execute({ userId: 'owner-user', text: 'see attachment', filePath: filename }, {
      workDir, userDataDir: workDir, requestId: 'wechat-send-sensitive-media', toolUseId: 'wechat-send-sensitive-media-call',
      sessionId: 'session-current', outboundDeliveryFacts: { channel: 'wechat', purpose: 'task-reply', originSessionId: 'session-current',
        activeSessionId: 'session-current', identityKey: 'owner-user', ownerId: 'owner-user', trustedRecipient: 'owner-user',
        chatType: 'p2p', content: 'see attachment', contentAssessment: { source: 'host', content: 'see attachment',
          classification: 'ordinary', classifierVersion: 'test-v1' }, contentCompleteness: 'complete', hasAttachment: true,
        attachmentAuthorized: true, attachmentContentVersion: 'stale-version', checkedAttachmentContentVersion: 'checked-other-version' },
      toolUserConfirmed: true, sendProgress: vi.fn(), signal: new AbortController().signal, fileStateCache: {} as never,
      toolsConfig: {} as never, appDatabase: {} as never
    })
    expect(mockBot.send).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, error: '微信外发缺少主进程最终检查事实' })
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
      outboundDeliveryFacts: { channel: 'wechat', purpose: 'active-send', modelRecipient: 'wx-user',
        contentCompleteness: 'unknown', hasAttachment: false, attachmentAuthorized: false },
      toolUserConfirmed: true,
      sendProgress: vi.fn(),
      signal: controller.signal,
      fileStateCache: {} as never,
      toolsConfig: {} as never,
      appDatabase: {} as never,
      sessionQueries: { readSession: vi.fn() } as never,
      remoteContext: { source: 'wechat', messageId: 'message-approved', userId: 'wx-user', confirmPolicy: 'always' }
    })

    expect(result).toMatchObject({ success: false, error: '微信回复已取消' })
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('allows a safe task-deliverable attachment through registered reply planning and the real executor', async () => {
    mockBot.reply.mockResolvedValue(undefined)
    const fileName = 'task-report.txt'
    await fs.writeFile(path.join(workDir, fileName), 'Your requested project status report is ready.')
    expect(await inspectWeChatTaskReplyAttachment(workDir, undefined, fileName)).toMatchObject({ attachmentAuthorized: true })
    expect(await inspectWeChatTaskReplyAttachment(workDir, undefined, path.join(workDir, fileName))).toMatchObject({ attachmentAuthorized: true })
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'inbound-task-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const runtime = {
      workDir,
      sessionId: 'session-current',
      lane: 'wechat',
      remoteContext: { source: 'wechat' as const, messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner',
        chatType: 'p2p' as const, originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
        taskBinding: { workflowId: 'task-workflow', taskId: 'current-task', stepId: 'deliver-report', planRevision: 1, revision: 1 } }
    }
    const replyTool = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: {
        name: 'wechat_reply',
        execute: async (input, context) => {
          expect(context.outboundDeliveryFacts).toMatchObject({ hasAttachment: true, attachmentAuthorized: true,
            attachmentPath: expect.stringContaining(fileName), contentCompleteness: 'complete' })
          expect(context.outboundDeliveryFacts).toMatchObject({ channel: 'wechat', recipient: 'wx-owner', originSessionId: 'session-current', activeSessionId: 'session-current' })
          return executeWeChatReply({ text: String(input.text), filePath: String(input.filePath) }, {
          workDir: context.workDir,
          botService: { getRawBot: () => mockBot } as never,
          sessionQueries: { readSession: vi.fn() } as never,
          sessionId: context.sessionId,
          expectedMessageId: context.remoteContext?.messageId,
          outboundDeliveryFacts: context.outboundDeliveryFacts
          })
        }
      } as never
    }).find(({ name }) => name === 'wechat_reply')!

    const result = await executeRegisteredTool(replyTool, { text: 'Here is the requested report.', filePath: fileName }, {
      requestId: 'task-attachment-request', toolUseId: 'task-attachment-call', signal: new AbortController().signal,
      executionContext: runtime as never
    }, { confirm: async () => true })

    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ success: true })
    expect(mockBot.reply).toHaveBeenCalledOnce()
    expect(mockBot.reply).toHaveBeenCalledWith(inbound, expect.objectContaining({
      file: expect.any(Buffer), fileName, caption: expect.stringContaining('Here is the requested report.')
    }))
  })

  it('does not read an oversized external text attachment before rejecting it', async () => {
    const file = path.join(workDir, 'oversized.txt')
    await fs.writeFile(file, '')
    await fs.truncate(file, 25 * 1024 * 1024 + 1)
    const readFile = vi.spyOn(fs, 'readFile')
    try {
      const result = await inspectWeChatTaskReplyAttachment(workDir, undefined, file)
      expect(result.attachmentAuthorized).toBe(false)
      expect(readFile).not.toHaveBeenCalledWith(file)
    } finally {
      readFile.mockRestore()
    }
  })

  it('T11：Agent 批准目录外普通附件后，实际上传字节与审批摘要一致', async () => {
    mockBot.reply.mockResolvedValue(undefined)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-approved-outside-'))
    const fileName = path.join(outside, 'approved.txt')
    const bytes = Buffer.from('ordinary external report')
    await fs.writeFile(fileName, bytes)
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'inbound-task-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const runtime = { workDir, sessionId: 'session-current', lane: 'wechat', remoteContext: {
      source: 'wechat' as const, messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner', authorizationGeneration: 7,
      originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
      taskBinding: { workflowId: 'task-workflow', taskId: 'current-task', stepId: 'deliver-report', planRevision: 1, revision: 1 }
    } }
    const [, replyTool] = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: async (input, context) => executeWeChatReply({ text: String(input.text), filePath: String(input.filePath) }, {
        workDir: context.workDir, botService: { getRawBot: () => mockBot } as never,
        sessionQueries: { readSession: vi.fn() } as never, sessionId: context.sessionId,
        expectedMessageId: context.remoteContext?.messageId, outboundDeliveryFacts: context.outboundDeliveryFacts
      }) } as never })
    try {
      const result = await executeRegisteredTool(replyTool!, { text: 'Approved report', filePath: fileName }, {
        requestId: 'outside-attachment-approved', toolUseId: 'outside-attachment-call', signal: new AbortController().signal,
        userConfirmationReceipt: 'agent:approved', userConfirmationAnswerer: 'agent', executionContext: runtime as never
      } as never, { confirm: async () => true, dispatch: async (_handle, _context, execute) => execute(new AbortController().signal) })
      expect(result.success, JSON.stringify(result)).toBe(true)
      expect(mockBot.reply).toHaveBeenCalledOnce()
      expect((mockBot.reply.mock.calls[0]?.[1] as { file?: Buffer }).file).toEqual(bytes)
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })

  it('T11：审批后附件被替换时上传前拒绝', async () => {
    mockBot.reply.mockResolvedValue(undefined)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-replaced-outside-'))
    const fileName = path.join(outside, 'approved.txt')
    await fs.writeFile(fileName, 'ordinary external report')
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'inbound-task-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const runtime = { workDir, sessionId: 'session-current', lane: 'wechat', remoteContext: {
      source: 'wechat' as const, messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner', authorizationGeneration: 7,
      originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
      taskBinding: { workflowId: 'task-workflow', taskId: 'current-task', stepId: 'deliver-report', planRevision: 1, revision: 1 }
    } }
    const [, replyTool] = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: async (input, context) => executeWeChatReply({ text: String(input.text), filePath: String(input.filePath) }, {
        workDir: context.workDir, botService: { getRawBot: () => mockBot } as never,
        sessionQueries: { readSession: vi.fn() } as never, sessionId: context.sessionId,
        expectedMessageId: context.remoteContext?.messageId, outboundDeliveryFacts: context.outboundDeliveryFacts
      }) } as never })
    try {
      await expect(executeRegisteredTool(replyTool!, { text: 'Approved report', filePath: fileName }, {
        requestId: 'outside-attachment-replaced', toolUseId: 'outside-attachment-replaced-call', signal: new AbortController().signal,
        userConfirmationReceipt: 'agent:approved', userConfirmationAnswerer: 'agent', executionContext: runtime as never
      } as never, { confirm: async () => { await fs.writeFile(fileName, 'changed after review'); return true },
        dispatch: async (_handle, _context, execute) => execute(new AbortController().signal) })).rejects.toThrow()
      expect(mockBot.reply).not.toHaveBeenCalled()
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })

  it.each(['授权代次撤销', '接收者变化'] as const)('T11：%s使目录外附件许可失效且不上传', async (change) => {
    mockBot.reply.mockResolvedValue(undefined)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-revoked-outside-'))
    const fileName = path.join(outside, 'approved.txt')
    await fs.writeFile(fileName, 'ordinary external report')
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'inbound-task-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const runtime = { workDir, sessionId: 'session-current', lane: 'wechat', remoteContext: {
      source: 'wechat' as const, messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner', authorizationGeneration: 7,
      originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
      taskBinding: { workflowId: 'task-workflow', taskId: 'current-task', stepId: 'deliver-report', planRevision: 1, revision: 1 }
    } }
    const [, replyTool] = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: vi.fn() } as never })
    try {
      await expect(executeRegisteredTool(replyTool!, { text: 'Approved report', filePath: fileName }, {
        requestId: `outside-attachment-${change}`, toolUseId: `outside-attachment-${change}-call`, signal: new AbortController().signal,
        userConfirmationReceipt: 'agent:approved', userConfirmationAnswerer: 'agent', executionContext: runtime as never
      } as never, { confirm: async () => true,
        dispatch: async (_handle, _context, execute) => {
          if (change === '授权代次撤销') runtime.remoteContext.authorizationGeneration++
          else runtime.remoteContext.userId = 'other-owner'
          return execute(new AbortController().signal)
        } })).rejects.toThrow('WECHAT_OUTBOUND_PREPARED_BINDING_CHANGED')
      expect(mockBot.reply).not.toHaveBeenCalled()
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })

  it('T11：缺少外部附件执行许可时直接调用执行器仍拒绝上传', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-incomplete-permit-'))
    const fileName = path.join(outside, 'unapproved.txt')
    await fs.writeFile(fileName, 'ordinary external report')
    const inbound = { userId: 'wx-user', timestamp: new Date(1_000), raw: { client_id: 'message-current' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    try {
      const result = await executeWeChatReply({ text: 'reply', filePath: fileName }, {
        workDir, botService: { getRawBot: () => mockBot } as never,
        sessionQueries: { readSession: vi.fn() } as never, sessionId: 'session-current', expectedMessageId: 'message-current',
        outboundDeliveryFacts: confirmedReplyFacts('reply')
      })
      expect(result.success).toBe(false)
      expect(mockBot.reply).not.toHaveBeenCalled()
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })

  it('T11：最终读取的上传字节偏离获批 SHA-256 时返回稳定拒绝分类', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-final-material-check-'))
    const fileName = path.join(outside, 'approved.txt')
    const original = Buffer.from('ordinary external report')
    await fs.writeFile(fileName, original)
    const digest = createHash('sha256').update(original).digest('hex')
    const realPath = await fs.realpath(fileName)
    await fs.writeFile(fileName, 'changed after final approval')
    const inbound = { userId: 'wx-user', timestamp: new Date(1_000), raw: { client_id: 'message-current' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    try {
      const result = await executeWeChatReply({ text: 'reply', filePath: realPath }, {
        workDir, botService: { getRawBot: () => mockBot } as never,
        sessionQueries: { readSession: vi.fn() } as never, sessionId: 'session-current', expectedMessageId: 'message-current',
        outboundDeliveryFacts: { ...confirmedReplyFacts('reply'), userConfirmationReceipt: 'agent:approved', hasAttachment: true, attachmentAuthorized: true,
          attachmentPath: realPath, checkedAttachmentPath: realPath, attachmentContentVersion: digest, checkedAttachmentContentVersion: digest,
          externalAttachmentReview: { path: realPath, sha256: digest, answerer: 'agent' } }
      })
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'wechat-media-approved-material-changed', retryable: false } })
      expect(mockBot.reply).not.toHaveBeenCalled()
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })

  it('T11：task-reply 附件许可不能转用于微信主动发送', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-active-send-external-'))
    const fileName = path.join(outside, 'approved.txt')
    const bytes = Buffer.from('ordinary external report')
    await fs.writeFile(fileName, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const realPath = await fs.realpath(fileName)
    try {
      const result = await executeWeChatSend({ userId: 'wx-user', text: 'send', filePath: realPath }, {
        workDir, botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }), sessionId: 'session-current',
        outboundDeliveryFacts: { ...confirmedReplyFacts('send'), userConfirmationReceipt: 'agent:approved', hasAttachment: true, attachmentAuthorized: true,
          attachmentPath: realPath, checkedAttachmentPath: realPath, attachmentContentVersion: digest, checkedAttachmentContentVersion: digest,
          externalAttachmentReview: { path: realPath, sha256: digest, answerer: 'agent' } }
      })
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'wechat-media-target-outside-workdir' } })
      expect(mockBot.send).not.toHaveBeenCalled()
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })

  it.each([
    ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['pdf', Buffer.from('%PDF-1.7\napproved attachment')]
  ])('sends a %s only after the registered prepared invocation carries its human receipt', async (extension, bytes) => {
    mockBot.reply.mockResolvedValue(undefined)
    const fileName = `approved.${extension}`
    await fs.writeFile(path.join(workDir, fileName), bytes)
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'inbound-task-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const runtime = {
      workDir, sessionId: 'session-current', lane: 'wechat',
      remoteContext: { source: 'wechat' as const, messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner',
        chatType: 'p2p' as const, originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
        taskBinding: { workflowId: 'task-workflow', taskId: 'current-task', stepId: 'deliver-file', planRevision: 1, revision: 1 } }
    }
    const replyTool = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: async (input, context) => {
        expect(context.outboundDeliveryFacts).toMatchObject({ attachmentApprovalRequired: true, attachmentAuthorized: true,
          attachmentContentVersion: expect.any(String), checkedAttachmentContentVersion: expect.any(String) })
        return executeWeChatReply({ text: String(input.text), filePath: String(input.filePath) }, {
          workDir: context.workDir, botService: { getRawBot: () => mockBot } as never,
          sessionQueries: { readSession: vi.fn() } as never, sessionId: context.sessionId,
          expectedMessageId: context.remoteContext?.messageId, outboundDeliveryFacts: context.outboundDeliveryFacts
        })
      } } as never
    }).find(({ name }) => name === 'wechat_reply')!

    const result = await executeRegisteredTool(replyTool, { text: 'Here is the file you requested.', filePath: fileName }, {
      requestId: `task-${extension}-approval`, toolUseId: `call-${extension}-approval`, signal: new AbortController().signal,
      userConfirmationReceipt: `human-approved-${extension}`,
      userConfirmationAnswerer: 'user',
      executionContext: runtime as never
    } as never, { confirm: async () => true })

    expect(result).toMatchObject({ success: true })
    expect(mockBot.reply).toHaveBeenCalledOnce()
    const sent = mockBot.reply.mock.calls[0]?.[1] as { image?: Buffer; file?: Buffer }
    expect(sent.image ?? sent.file).toEqual(bytes)
  })

  it.each([
    ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['pdf', Buffer.from('%PDF-1.7\nrequires approval')]
  ])('never sends a %s when the prepared invocation has no human receipt', async (extension, bytes) => {
    const fileName = `unapproved.${extension}`
    await fs.writeFile(path.join(workDir, fileName), bytes)
    const send = vi.fn(async () => ({ success: true }))
    const replyTool = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: send } as never }).find(({ name }) => name === 'wechat_reply')!
    const runtime = { workDir, sessionId: 'session-current', remoteContext: { source: 'wechat' as const, messageId: 'm',
      userId: 'wx-owner', authOwner: 'wx-owner', originSessionId: 'session-current', currentUserMessageId: 'u',
      taskBinding: { workflowId: 'w', taskId: 't', stepId: 's', planRevision: 1, revision: 1 } } }
    await expect(executeRegisteredTool(replyTool, { text: 'send', filePath: fileName }, {
      requestId: `no-receipt-${extension}`, toolUseId: `no-receipt-call-${extension}`, signal: new AbortController().signal,
      executionContext: runtime as never
    }, { confirm: async () => true })).rejects.toThrow('WECHAT_ATTACHMENT_HUMAN_APPROVAL_BINDING_REQUIRED')
    expect(send).not.toHaveBeenCalled()
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('does not treat an Agent approval receipt as human approval for a binary attachment', async () => {
    const fileName = 'agent-approved.png'
    await fs.writeFile(path.join(workDir, fileName), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const send = vi.fn(async () => ({ success: true }))
    const replyTool = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: send } as never }).find(({ name }) => name === 'wechat_reply')!
    const runtime = { workDir, sessionId: 'session-current', remoteContext: { source: 'wechat' as const, messageId: 'm',
      userId: 'wx-owner', authOwner: 'wx-owner', originSessionId: 'session-current', currentUserMessageId: 'u',
      taskBinding: { workflowId: 'w', taskId: 't', stepId: 's', planRevision: 1, revision: 1 } } }
    await expect(executeRegisteredTool(replyTool, { text: 'send', filePath: fileName }, {
      requestId: 'agent-does-not-approve-binary', toolUseId: 'agent-does-not-approve-binary-call', signal: new AbortController().signal,
      userConfirmationReceipt: 'agent:approved', userConfirmationAnswerer: 'agent', executionContext: runtime as never
    } as never, { confirm: async () => true })).rejects.toThrow('WECHAT_ATTACHMENT_HUMAN_APPROVAL_BINDING_REQUIRED')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a deferred PDF when the signed path and original approval hash still match', async () => {
    mockBot.reply.mockResolvedValue(undefined)
    const fileName = 'deferred-approved.pdf'
    const bytes = Buffer.from('%PDF-original approved bytes')
    const filePath = path.join(workDir, fileName)
    await fs.writeFile(filePath, bytes)
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'deferred-origin-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const runtime = { workDir, sessionId: 'session-current', lane: 'wechat', userConfirmationReceipt: 'deferred:approved',
      remoteContext: { source: 'wechat' as const, messageId: 'deferred-origin-message', userId: 'wx-owner', authOwner: 'wx-owner',
        originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
        taskBinding: { workflowId: 'w', taskId: 't', stepId: 's', planRevision: 1, revision: 1 },
        deferredAttachmentApproval: { path: await fs.realpath(filePath), sha256: digest } } }
    const replyTool = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: async (input, context) => executeWeChatReply({
        text: String(input.text), filePath: String(input.filePath)
      }, { workDir: context.workDir, botService: { getRawBot: () => mockBot } as never,
        sessionQueries: { readSession: vi.fn() } as never, sessionId: context.sessionId,
        expectedMessageId: context.remoteContext?.messageId, outboundDeliveryFacts: context.outboundDeliveryFacts }) } } as never)
      .find(({ name }) => name === 'wechat_reply')!
    const result = await executeRegisteredTool(replyTool, { text: 'Here is the approved file.', filePath: fileName }, {
      requestId: 'deferred-pdf-approved', toolUseId: 'deferred-pdf-approved-call', signal: new AbortController().signal,
      userConfirmationReceipt: 'deferred:approved', userConfirmationAnswerer: 'user', executionContext: runtime as never
    } as never, { confirm: async () => true })
    expect(result).toMatchObject({ success: true })
    expect(mockBot.reply).toHaveBeenCalledOnce()
    expect((mockBot.reply.mock.calls[0]?.[1] as { file?: Buffer }).file).toEqual(bytes)
  })

  it('rejects a deferred approved attachment that differs from the binding before prepare or send', async () => {
    mockBot.reply.mockResolvedValue(undefined)
    const fileName = 'deferred-approved.pdf'
    const sameBytes = '%PDF-content same but path differs'
    await fs.writeFile(path.join(workDir, fileName), sameBytes)
    const otherFilePath = path.join(workDir, 'different-target.pdf')
    await fs.writeFile(otherFilePath, sameBytes)
    const { createHash } = await import('node:crypto')
    const sameHash = createHash('sha256').update(sameBytes).digest('hex')
    const inbound = { userId: 'wx-owner', timestamp: new Date(1_000), raw: { client_id: 'inbound-task-message' } }
    getBundle.mockReturnValue({ router: { getInboundForSession: () => inbound } })
    const toolExecutor = vi.fn(async () => ({ success: true }))
    const replyTool = createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: toolExecutor } as never }).find(({ name }) => name === 'wechat_reply')!
    const runtime = { workDir, sessionId: 'session-current', remoteContext: { source: 'wechat' as const,
      messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner', originSessionId: 'session-current',
      currentUserMessageId: 'current-user-message', taskBinding: { workflowId: 'w', taskId: 't', stepId: 's', planRevision: 1, revision: 1 },
      deferredAttachmentApproval: { path: await fs.realpath(otherFilePath), sha256: sameHash } } }
    await expect(executeRegisteredTool(replyTool, { text: 'send', filePath: fileName }, {
      requestId: 'deferred-attachment-changed', toolUseId: 'deferred-attachment-changed-call', signal: new AbortController().signal,
      executionContext: runtime as never
    }, { confirm: async () => true })).rejects.toThrow('WECHAT_DEFERRED_ATTACHMENT_APPROVAL_MISMATCH')
    expect(toolExecutor).not.toHaveBeenCalled()
    expect(mockBot.reply).not.toHaveBeenCalled()
  })

  it('uses only the approved content-addressed path when verifying a deferred attachment', async () => {
    const bytes = Buffer.from('%PDF-approved')
    await fs.writeFile(path.join(workDir, 'approved.pdf'), bytes)
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(bytes).digest('hex')
    await expect(verifyDeferredWeChatAttachment(workDir, 'approved.pdf', digest)).resolves.toMatchObject({
      path: await fs.realpath(path.join(workDir, 'approved.pdf')), sha256: digest
    })
    await expect(verifyDeferredWeChatAttachment(workDir, '../outside.pdf', digest)).resolves.toBeNull()
    await expect(verifyDeferredWeChatAttachment(workDir, 'approved.pdf', 'f'.repeat(64))).resolves.toBeNull()
  })

  it('rejects a task attachment changed after planning and before confirmation completes', async () => {
    const fileName = 'task-report.txt'
    const filePath = path.join(workDir, fileName)
    await fs.writeFile(filePath, 'Your requested project status report is ready.')
    const executor = vi.fn(async () => ({ success: true }))
    const replyTool = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: executor } as never
    }).find(({ name }) => name === 'wechat_reply')!
    const runtime = {
      workDir,
      sessionId: 'session-current',
      remoteContext: { source: 'wechat' as const, messageId: 'inbound-task-message', userId: 'wx-owner', authOwner: 'wx-owner',
        originSessionId: 'session-current', currentUserMessageId: 'current-user-message',
        taskBinding: { workflowId: 'task-workflow', taskId: 'current-task', stepId: 'deliver-report', planRevision: 1, revision: 1 } }
    }

    await expect(executeRegisteredTool(replyTool, { text: 'Here is the requested report.', filePath: fileName }, {
      requestId: 'task-attachment-drift-request', toolUseId: 'task-attachment-drift-call', signal: new AbortController().signal,
      executionContext: runtime as never
    }, { confirm: async () => {
      await fs.writeFile(filePath, 'sk-12345678901234567890')
      return true
    } })).rejects.toThrow('WECHAT_OUTBOUND_PREPARED_BINDING_CHANGED')

    expect(executor).not.toHaveBeenCalled()
  })
})
