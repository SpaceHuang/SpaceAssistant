import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { WeChatImChannel, buildWeChatConfirmPrompt, commitWeChatAction } from './weChatImChannel'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'
import { openSqliteDatabase, type AppDatabase } from '../database'
import * as decisionCacheWriter from '../confirmation/decisionCacheWriter'
import type { ImPendingConfirm } from '../confirmation/imChannel'
import { parseImConfirmReply } from '../remote/imConfirmReply'
import { WeChatConfirmationPromptAdapter, wrapFetchForLosslessWeChatMessageId } from './weChatConfirmationPromptAdapter'
import { createMockWeChatBot } from './__mocks__/wechatBotMock'
import { parseSdkInboundMessage } from './weChatInboundParser'

function req(toolName = 'write_file'): ConfirmRequest {
  return {
    facts: {
      toolName,
      actionClass: 'write',
      baseRiskLevel: 'medium',
      signals: [],
      summary: { text: toolName }
    },
    riskLevel: 'medium',
    memoryTiers: [],
    timeoutMs: null
  }
}

describe('WeChatImChannel（原 WeChatConfirmManager 回归）', () => {
  const dbs: AppDatabase[] = []
  const reply = vi.fn(async () => undefined)
  const sendToUser = vi.fn(async () => ({ messageId: 'wechat-confirm-prompt' }))
  const getReplyBot = () => ({ reply, sendToUser, sendTyping: vi.fn(), stopTyping: vi.fn() })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => dbs.splice(0).forEach((db) => db.close()))

  it('sends IM prompt with Y/N footer on request', async () => {
    const im = new WeChatImChannel({ getReplyBot })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig' } })
    const promise = im.request(req(), {
      sessionId: 'sess-1',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    await vi.waitFor(() => expect(im.listPending()[0]?.promptMessageId).toBe('wechat-confirm-prompt'))
    const cid = im.listPending()[0]!.confirmId!
    const ynMsg = {
      messageId: 'yn-1',
      quotedMessageId: 'wechat-confirm-prompt',
      userId: 'wx-user@test',
      text: `Y ${cid}`,
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(im.tryResolveFromInboundMessage(ynMsg, {
      allowedUserIds: ['wx-user@test']
    })).toBe(true)
    await expect(promise).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
    expect(sendToUser).toHaveBeenCalledWith('wx-user@test', expect.stringContaining('回复 Y'), expect.any(AbortSignal))
    expect(sendToUser).toHaveBeenCalledWith('wx-user@test', expect.stringMatching(/引用.*本条确认提示/), expect.any(AbortSignal))
  })

  it('用 sendmessage 响应中的服务端 message_id 匹配引用 msg_id 完成确认往返', async () => {
    const bot = createMockWeChatBot()
    const exactId = '9007199254740993'
    const sendMessage = vi.fn(async () => ({ message_id: exactId, ret: 0 }))
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never)
    const im = new WeChatImChannel({ getReplyBot: () => ({
      reply,
      sendToUser: (userId, content, signal) => adapter.send(userId, content, signal),
      sendTyping: vi.fn()
    }) })
    const pending = im.request(req(), { sessionId: 'quoted-roundtrip', toolName: 'write_file', messageId: 'origin', matchKey: 'wx-user@test' })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(im.listPending()[0]?.promptMessageId).toBe(exactId))
    const confirmId = im.listPending()[0]!.confirmId!
    const fetchWithLosslessIds = wrapFetchForLosslessWeChatMessageId((async () => new Response(
      `{"msgs":[{"item_list":[{"ref_msg":{"message_item":{"type":0,"msg_id":${exactId},"create_time_ms":${Date.now()},"is_completed":true}}}] }]}`
    )) as typeof fetch)
    const response = await fetchWithLosslessIds('https://ilink.test/ilink/bot/getupdates')
    const update = await response.json() as { msgs: Array<{ item_list: unknown[] }> }
    const quotedReply = makeIncomingMessage({
      text: `N ${confirmId}`,
      raw: {
        ...makeIncomingMessage().raw,
        client_id: 'quoted-answer',
        item_list: update.msgs[0].item_list
      } as never
    })
    const parsedReply = parseSdkInboundMessage(quotedReply)
    expect(parsedReply.quotedMessageId).toBe(exactId)
    expect(parsedReply.quotedMessageText).toBeUndefined()
    expect(im.tryResolveFromInboundMessage(parsedReply, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', cause: 'user-denied' })
    expect(bot.sendRaw).not.toHaveBeenCalled()
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it('keeps two concurrent confirmation codes and send response IDs independently bound', async () => {
    const bot = createMockWeChatBot()
    let nextId = 1
    const sendMessage = vi.fn(async () => ({ message_id: `server-message-${nextId++}`, ret: 0 }))
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never)
    const im = new WeChatImChannel({ getReplyBot: () => ({
      reply,
      sendToUser: (userId, content, signal) => adapter.send(userId, content, signal),
      sendTyping: vi.fn()
    }) })
    const firstPending = im.request(req('first_tool'), { sessionId: 'parallel', toolName: 'first_tool', messageId: 'origin-1', matchKey: 'wx-user@test' })
    const secondPending = im.request(req('second_tool'), { sessionId: 'parallel', toolName: 'second_tool', messageId: 'origin-2', matchKey: 'wx-user@test' })
    await vi.waitFor(() => expect(im.listPending().every((entry) => entry.promptMessageId)).toBe(true))

    const [first, second] = im.listPending()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.confirmId).not.toBe(second!.confirmId)
    expect(first!.promptMessageId).not.toBe(second!.promptMessageId)

    const firstReply = makeIncomingMessage({ text: `Y ${first!.confirmId}`, raw: {
      ...makeIncomingMessage().raw,
      client_id: 'parallel-answer-1',
      item_list: [{ type: 1, ref_msg: { message_item: { type: 0, msg_id: first!.promptMessageId, is_completed: true } } }]
    } as never })
    const secondReply = makeIncomingMessage({ text: `N ${second!.confirmId}`, raw: {
      ...makeIncomingMessage().raw,
      client_id: 'parallel-answer-2',
      item_list: [{ type: 1, ref_msg: { message_item: { type: 0, msg_id: second!.promptMessageId, is_completed: true } } }]
    } as never })
    expect(im.tryResolveFromInboundMessage(parseSdkInboundMessage(firstReply), { allowedUserIds: ['wx-user@test'] })).toBe(true)
    expect(im.tryResolveFromInboundMessage(parseSdkInboundMessage(secondReply), { allowedUserIds: ['wx-user@test'] })).toBe(true)
    await expect(firstPending).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    await expect(secondPending).resolves.toMatchObject({ kind: 'rejected', cause: 'user-denied' })
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it.each([undefined, 'unrelated-message'])('tells the owner to quote the confirmation prompt when a valid code has quote %s', async (quotedMessageId) => {
    const im = new WeChatImChannel({ getReplyBot })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig-no-quote' } })
    const pending = im.request(req(), {
      sessionId: 'sess-no-quote', toolName: 'write_file', messageId: 'orig-no-quote',
      matchKey: 'wx-user@test', context: inbound
    })
    await vi.waitFor(() => expect(im.listPending()[0]?.promptMessageId).toBe('wechat-confirm-prompt'))
    const confirmId = im.listPending()[0]!.confirmId!
    expect(im.tryResolveFromInboundMessage({
      messageId: 'answer-no-quote', ...(quotedMessageId ? { quotedMessageId } : {}), userId: 'wx-user@test', text: `Y ${confirmId}`,
      type: 'text', timestamp: new Date().toISOString(), contextToken: 'ctx'
    }, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    expect(reply).toHaveBeenCalledWith(inbound, expect.stringMatching(/引用.*确认提示/))
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', cause: 'cancelled' })
  })

  it('heartbeat-style prompt excludes duplicate Y/N when using default builder', () => {
    const prompt = buildWeChatConfirmPrompt({
      id: '1',
      sessionId: 's1',
      toolName: 'write_file',
      messageId: 'm1',
      channel: 'wechat',
      memoryTiers: [],
      createdAt: 1,
      expiresAt: 2,
      confirmId: '07'
    })
    expect(prompt).toContain('【进度】')
    expect(prompt).toContain('07')
    expect(prompt).toContain('Y 07')
    expect(prompt).not.toContain('回复 Y 确认，N 取消')
    expect(prompt).toContain('5 分钟内有效')
    expect(parseImConfirmReply('Y 07')).toMatchObject({ kind: 'approve', confirmId: '07' })
    expect(parseImConfirmReply('N 07')).toMatchObject({ kind: 'reject', confirmId: '07' })
    expect(parseImConfirmReply('Y')).toMatchObject({ kind: 'usage_hint' })
    expect(prompt).not.toMatch(/(?:回复|或)\s+Y\/N\b/)
  })

  it('把 run_shell 命令、调用理由和截断状态纳入微信确认文本', () => {
    const prompt = buildWeChatConfirmPrompt({
      id: 'shell-reason', sessionId: 's', toolName: 'run_shell',
      toolInput: { command: 'pwd', justification: '查看目录\n确定项目根路径', _justificationTruncated: true },
      messageId: 'm1', channel: 'wechat', memoryTiers: [], createdAt: 1, expiresAt: 2
    })
    expect(prompt).toContain('命令：pwd')
    expect(prompt).toContain('调用理由（内容已截断）：\n查看目录\n确定项目根路径')
  })

  it('并行 run_shell 确认通过微信发送入口保留各自命令和调用理由', async () => {
    const im = new WeChatImChannel({ getReplyBot })
    const start = (suffix: string) => im.request(req('run_shell'), {
      sessionId: `s-parallel-${suffix}`, toolName: 'run_shell',
      toolInput: { command: `echo ${suffix}`, justification: `用户要求检查 ${suffix}` },
      messageId: `origin-${suffix}`, matchKey: 'wx-user@test'
    })
    const first = start('alpha')
    const second = start('beta')
    await vi.waitFor(() => expect(im.listPending()).toHaveLength(2))
    await vi.waitFor(() => expect(sendToUser).toHaveBeenCalledTimes(2))

    const sent = sendToUser.mock.calls.map((call) => call[1])
    expect(sent).toEqual(expect.arrayContaining([
      expect.stringContaining('命令：echo alpha\n调用理由：\n用户要求检查 alpha'),
      expect.stringContaining('命令：echo beta\n调用理由：\n用户要求检查 beta')
    ]))
    const pendingByCommand = new Map(im.listPending().map((entry) => [String(entry.toolInput?.command), entry]))
    for (const command of ['echo alpha', 'echo beta']) {
      const entry = pendingByCommand.get(command)!
      expect(im.tryResolveFromInboundMessage({
        messageId: `answer-${command}`, quotedMessageId: entry.promptMessageId,
        userId: 'wx-user@test', text: `Y ${entry.confirmId}`, type: 'text',
        timestamp: new Date().toISOString(), contextToken: 'ctx'
      }, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    }
    await expect(first).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    await expect(second).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
  })

  it.each([
    ['bot 缺失', {}, 'bot-unavailable'],
    ['发送器缺少消息 ID 能力', { getReplyBot: () => ({ reply, sendTyping: vi.fn() }) }, 'bot-unavailable']
  ] as const)('%s 是 not-attempted 且 fail closed', async (_label, deps, errorCategory) => {
    const im = new WeChatImChannel(deps)
    const outcome = await im.request(req(), {
      sessionId: 'sess-preflight', toolName: 'write_file', messageId: 'orig-preflight',
      matchKey: 'wx-user@test', ...(deps.getReplyBot ? { context: undefined } : {})
    })
    expect(outcome).toMatchObject({ kind: 'rejected', cause: 'unavailable', promptSendFailure: {
      sendCall: 'not-attempted', delivery: 'not-attempted', errorCategory
    } })
    expect(im.countPending()).toBe(0)
  })

  it('微信发送成功但 SDK 响应缺少消息 ID 时不开放确认', async () => {
    const im = new WeChatImChannel({ getReplyBot: () => ({ reply, sendToUser: async () => ({ ok: true } as never), sendTyping: vi.fn() }) })
    const outcome = await im.request(req(), { sessionId: 'missing-wechat-id', toolName: 'write_file', messageId: 'origin', matchKey: 'wx-user@test' })
    expect(outcome).toMatchObject({ kind: 'rejected', cause: 'unavailable', promptSendFailure: { sendCall: 'rejected', delivery: 'unknown' } })
    expect(im.countPending()).toBe(0)
  })

  it('发送 fulfilled 但提示 ID 绑定失败时准确记录发送成功与 delivery unavailable', async () => {
    const im = new WeChatImChannel({ getReplyBot: () => ({
      reply,
      sendToUser: async () => ({ kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound', errorCategory: 'message-binding-unavailable' }),
      sendTyping: vi.fn()
    }) })
    const outcome = await im.request(req(), { sessionId: 'binding-unavailable', toolName: 'write_file', messageId: 'origin', matchKey: 'wx-user@test' })
    expect(outcome).toMatchObject({
      kind: 'rejected', cause: 'unavailable',
      promptSendFailure: { sendCall: 'fulfilled', delivery: 'unavailable', errorCategory: 'message-binding-unavailable' }
    })
    expect(im.countPending()).toBe(0)
  })

  it('确认请求取消会 abort 尚未完成的微信发送并释放适配器资源', async () => {
    const bot = createMockWeChatBot()
    let resolveSend!: () => void
    bot.sendRaw.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    let signal: AbortSignal | undefined
    const sendToUser = (userId: string, content: string, requestSignal?: AbortSignal) => {
      signal = requestSignal
      return adapter.send(userId, content, requestSignal)
    }
    const im = new WeChatImChannel({ getReplyBot: () => ({ reply, sendToUser, sendTyping: vi.fn() }) })
    const pending = im.request(req(), { sessionId: 'cancel-echo', toolName: 'write_file', messageId: 'origin', matchKey: 'wx-user@test' })
    expect(adapter.pendingCount).toBe(1)
    im.cancel(im.listPending()[0]!.id)
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', cause: 'cancelled' })
    expect(signal?.aborted).toBe(true)
    expect(adapter.pendingCount).toBe(0)
    resolveSend()
    await Promise.resolve()
    expect(im.countPending()).toBe(0)
    adapter.close()
  })

  it('未确认的引用标记不能批准；sendRaw 失败后伪造 BOT 回显也不能恢复审批', async () => {
    const bot = createMockWeChatBot()
    let rejectSend!: (error: Error) => void
    bot.sendRaw.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const sendToUser = (userId: string, content: string, signal?: AbortSignal) => adapter.send(userId, content, signal)
    const im = new WeChatImChannel({ getReplyBot: () => ({ reply, sendToUser, sendTyping: vi.fn() }) })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig-early-echo' } })
    const pending = im.request(req(), {
      sessionId: 'sess-early-echo', toolName: 'write_file', messageId: 'orig-early-echo',
      matchKey: 'wx-user@test', context: inbound
    })
    const payload = bot.sendRaw.mock.calls[0]![0] as Record<string, unknown>
    bot.poller.emit('messages', [{ ...payload, message_type: 2, message_id: 123456 }])
    await Promise.resolve()
    expect(im.listPending()[0]?.promptMessageId).toBeUndefined()

    const confirmId = im.listPending()[0]!.confirmId!
    expect(im.tryResolveFromInboundMessage({
      messageId: 'early-approval', quotedMessageId: '123456', userId: 'wx-user@test',
      text: `Y ${confirmId}`, type: 'text', timestamp: new Date().toISOString(), contextToken: 'ctx'
    }, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    expect(im.countPending()).toBe(1)

    rejectSend(new Error('sendRaw failed'))
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable' })
    expect(im.countPending()).toBe(0)
    bot.poller.emit('messages', [{ ...payload, message_type: 2, message_id: 654321 }])
    expect(im.tryResolveFromInboundMessage({
      messageId: 'late-approval', quotedMessageId: '123456', userId: 'wx-user@test',
      text: `Y ${confirmId}`, type: 'text', timestamp: new Date().toISOString(), contextToken: 'ctx'
    }, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    expect(im.countPending()).toBe(0)
    adapter.close()
  })

  it('does not resolve confirm from non-allowlisted sender', async () => {
    const im = new WeChatImChannel()
    const inbound = makeIncomingMessage()
    const promise = im.request(req(), {
      sessionId: 'sess-deny',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    const ynMsg = {
      messageId: 'yn-attacker',
      userId: 'attacker@test',
      text: 'Y',
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(
      im.tryResolveFromInboundMessage(ynMsg, {
        allowedUserIds: ['wx-user@test']
      })
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(promise).resolves.toMatchObject({ kind: 'rejected', cause: 'cancelled' })
  })

  it('真实微信链路：第一次记忆写入回滚后保留 pending，第二次同码递增 revision 成功', async () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const tier = { key: { kind: 'shell-command' as const, verb: 'npm test', level: 'exact' as const }, label: '记住 npm test' }
    const write = vi.spyOn(decisionCacheWriter, 'recordUserAnswerFromMemoryTiers').mockImplementationOnce(() => { throw new Error('db-busy') })
    const im = new WeChatImChannel({ db, getReplyBot, getGeneration: () => 0 })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig-retry' } })
    const p = im.request({ ...req('run_shell'), memoryTiers: [tier] }, {
      sessionId: 's-wechat-retry',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'orig-retry',
      matchKey: 'wx-user@test',
      context: inbound,
      memoryTiers: [tier],
      authorizationGeneration: 0
    })
    await vi.waitFor(() => expect(im.listPending()[0]?.promptMessageId).toBe('wechat-confirm-prompt'))
    const confirmId = im.listPending()[0]!.confirmId!
    const first = { messageId: 'yn-retry-1', quotedMessageId: 'wechat-confirm-prompt', userId: 'wx-user@test', text: `记1 ${confirmId}`, type: 'text' as const, timestamp: new Date().toISOString(), contextToken: 'ctx' }
    const second = { ...first, messageId: 'yn-retry-2' }
    expect(im.tryResolveFromInboundMessage(first, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    expect(im.countPending()).toBe(1)
    expect(im.tryResolveFromInboundMessage(second, { allowedUserIds: ['wx-user@test'] })).toBe(true)
    await expect(p).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('撤销后的缺失授权代际 pending 必须 fail closed，不能写入记忆', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const currentGeneration = { value: 1 }
    const entry = {
      id: 'legacy-wechat-pending',
      sessionId: 's-legacy-wechat',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      channel: 'wechat' as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      memoryTiers: [{ key: { kind: 'shell-command' as const, verb: 'npm test', level: 'exact' as const }, label: '记住 npm test' }]
    } satisfies ImPendingConfirm
    const write = vi.spyOn(decisionCacheWriter, 'recordUserAnswerFromMemoryTiers')

    expect(commitWeChatAction(db, entry, { kind: 'memory', tier: entry.memoryTiers[0], approved: true }, () => currentGeneration.value)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('过期的微信确认点击不应消耗 commitRevision', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    const entry = {
      id: 'expired-wechat-pending',
      sessionId: 's-expired-wechat',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      channel: 'wechat' as const,
      authorizationGeneration: 1,
      commitRevision: 4,
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1,
      memoryTiers: []
    } satisfies ImPendingConfirm

    expect(commitWeChatAction(db, entry, { kind: 'decision', approved: true }, () => 1)).toBe(false)
    expect(entry.commitRevision).toBe(4)
  })
})
