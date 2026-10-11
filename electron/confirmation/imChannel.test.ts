import { describe, expect, it, vi } from 'vitest'
import { ImChannel } from './imChannel'
import { createImChannelForTest } from './imChannelTestUtils'
import type { AuditSink } from './channels'
import type { ConfirmRequest, MemoryTier, SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { ConfirmIdSpace } from '../../packages/agent-sdk/src/runtime/components'
import { createWeChatQuoteMarker } from '../wechat/weChatQuoteBinding'

function req(tiers: MemoryTier[] = []): ConfirmRequest {
  return {
    facts: {
      toolName: 'run_shell',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [],
      summary: { text: '命令序列：ping baidu.com' }
    },
    riskLevel: 'high',
    memoryTiers: tiers,
    timeoutMs: null
  }
}

function audit(): AuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { events, record: (e) => events.push(e) }
}

describe('ImChannel（飞书/微信合并通道）', () => {
  it('把同步确认的 pending/settled 子工作事实关联到 Track', async () => {
    const child = vi.fn()
    const channel = createImChannelForTest({
      lane: 'wechat', timeoutMs: 5000, onTrackConfirmationChild: child,
      sendPrompt: (entry) => ({ messageId: 'track-confirm-prompt' })
    })
    const result = channel.request(req(), {
      sessionId: 'track-confirm-session', toolName: 'run_shell', messageId: 'track-confirm-origin', matchKey: 'owner',
      trackId: 'track-confirm-a', trackAttributionEventId: 'track-root-event', requestId: 'track-confirm-request',
      turnId: 'track-confirm-turn', toolUseId: 'track-confirm-tool-use'
    })
    await Promise.resolve()
    expect(child).toHaveBeenCalledTimes(1)
    expect(child).toHaveBeenNthCalledWith(1, expect.objectContaining({ trackId: 'track-confirm-a', trackAttributionEventId: 'track-root-event' }), 'pending')
    channel.tryResolveFromInbound({ kind: 'reject', confirmId: channel.listPending()[0]!.confirmId }, {
      matchKey: 'owner', messageId: 'track-confirm-answer', quotedMessageId: 'track-confirm-prompt'
    })
    await result
    expect(child).toHaveBeenCalledTimes(2)
    expect(child).toHaveBeenNthCalledWith(2, expect.objectContaining({ trackId: 'track-confirm-a' }), 'settled')
  })

  it('fails closed when a Track-linked confirmation lacks its exact turn or tool-use identity', async () => {
    const child = vi.fn()
    const channel = createImChannelForTest({ lane: 'wechat', timeoutMs: 5000, onTrackConfirmationChild: child,
      sendPrompt: () => ({ messageId: 'must-not-send' }) })
    const result = channel.request(req(), { sessionId: 'track-confirm-incomplete', toolName: 'fetch', messageId: 'origin', matchKey: 'owner',
      trackId: 'track-confirm-a', trackAttributionEventId: 'track-root-event', requestId: 'request-only' })
    await expect(result).resolves.toEqual({ kind: 'rejected', cause: 'unavailable' })
    expect(child).not.toHaveBeenCalled()
    expect(channel.countPending()).toBe(0)
  })

  it('微信按服务端提示 message_id 绑定引用，并在两位码复用后拒绝旧引用', async () => {
    const confirmIds = new ConfirmIdSpace()
    const held = Array.from({ length: 99 }, () => confirmIds.allocate())
    let sendIndex = 0
    const ch = new ImChannel({
      lane: 'wechat', timeoutMs: 5000, confirmIds,
      sendPrompt: () => ({ kind: 'sent', sendCall: 'fulfilled', delivery: 'bound', binding: { kind: 'message-id', value: `server-message-${sendIndex++}` } })
    })
    const firstPending = ch.request(req(), { sessionId: 'quote-msg-id-first', toolName: 'run_shell', messageId: 'origin-first', matchKey: 'owner' })
    await Promise.resolve()
    const first = ch.listPending()[0]!
    const reusedCode = first.confirmId!
    ch.tryResolveFromInbound({ kind: 'reject', confirmId: reusedCode }, {
      matchKey: 'owner', messageId: 'answer-first', quotedMessageId: 'server-message-0'
    })
    await expect(firstPending).resolves.toMatchObject({ kind: 'rejected', cause: 'user-denied' })

    const secondPending = ch.request(req(), { sessionId: 'quote-msg-id-second', toolName: 'run_shell', messageId: 'origin-second', matchKey: 'owner' })
    await Promise.resolve()
    const second = ch.listPending()[0]!
    expect(second.confirmId).toBe(reusedCode)
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: reusedCode }, {
      matchKey: 'owner', messageId: 'stale-answer', quotedMessageId: 'server-message-0'
    })
    expect(ch.countPending()).toBe(1)
    expect(ch.tryResolveFromInbound({ kind: 'approve', confirmId: reusedCode }, {
      matchKey: 'owner', messageId: 'answer-second', quotedMessageId: 'server-message-1'
    })).toBe(true)
    await expect(secondPending).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    held.forEach((lease) => confirmIds.release(lease))
  })

  it('微信引用内容标记隔离已复用两位码的旧确认提示', async () => {
    const confirmIds = new ConfirmIdSpace()
    const held = Array.from({ length: 99 }, () => confirmIds.allocate())
    let promptIndex = 0
    const commits = vi.fn(() => ({ committed: true }))
    const markers = [createWeChatQuoteMarker('00000000000000000000000000000001'), createWeChatQuoteMarker('00000000000000000000000000000002')]
    const ch = new ImChannel({
      lane: 'wechat', timeoutMs: 5000, confirmIds, onCommit: commits,
      sendPrompt: () => ({ kind: 'sent', sendCall: 'fulfilled', delivery: 'bound', binding: { kind: 'quoted-content-token', marker: markers[promptIndex++]! } })
    })
    const firstPromise = ch.request(req(), { sessionId: 'quoted-a', toolName: 'run_shell', messageId: 'origin-a', matchKey: 'owner' })
    await Promise.resolve()
    const first = ch.listPending()[0]!
    const code = first.confirmId!
    expect(first.promptQuoteMarker).toBe(markers[0])
    ch.tryResolveFromInbound({ kind: 'reject', confirmId: code }, { matchKey: 'owner', messageId: 'answer-a', quotedMessageText: `old prompt${markers[0]}` })
    await expect(firstPromise).resolves.toMatchObject({ kind: 'rejected', cause: 'user-denied' })

    const secondPromise = ch.request(req(), { sessionId: 'quoted-b', toolName: 'run_shell', messageId: 'origin-b', matchKey: 'owner' })
    await Promise.resolve()
    const second = ch.listPending()[0]!
    expect(second.confirmId).toBe(code)
    expect(second.promptQuoteMarker).toBe(markers[1])
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: code }, { matchKey: 'owner', messageId: 'stale-answer', quotedMessageText: `old prompt${markers[0]}` })
    expect(ch.countPending()).toBe(1)
    expect(commits).toHaveBeenCalledTimes(1)
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: code }, { matchKey: 'owner', messageId: 'current-answer', quotedMessageText: `current prompt${markers[1]}` })
    await expect(secondPromise).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(commits).toHaveBeenCalledTimes(2)
    held.forEach((lease) => confirmIds.release(lease))
  })

  it.each(['wechat', 'feishu'] as const)('%s 同码立即复用后，旧提示引用不能批准、拒绝、trust 或记忆新请求', async (lane) => {
    const confirmIds = new ConfirmIdSpace()
    const held = Array.from({ length: 99 }, () => confirmIds.allocate())
    const sent: string[] = []
    const commits = vi.fn(() => ({ committed: true }))
    const memories = vi.fn(() => true)
    const tier: MemoryTier = { key: { kind: 'shell-command', verb: 'npm test', level: 'exact' }, label: '记住 npm test' }
    const ch = new ImChannel({
      lane, timeoutMs: 5000, confirmIds, onCommit: commits, onMemory: memories,
      sendPrompt: (entry) => {
        const messageId = `prompt-${entry.id}`
        sent.push(messageId)
        return { messageId }
      }
    })
    const start = (sessionId: string) => ch.request(req(), { sessionId, toolName: 'run_shell', messageId: `origin-${sessionId}`, matchKey: 'owner' })

    const firstPromise = start('first')
    await Promise.resolve()
    const first = ch.listPending()[0]!
    const code = first.confirmId!
    const firstPrompt = first.promptMessageId!
    expect(code).toMatch(/^\d{2}$/)
    ch.tryResolveFromInbound({ kind: 'reject', confirmId: code }, { matchKey: 'owner', messageId: 'answer-first', quotedMessageId: firstPrompt })
    await expect(firstPromise).resolves.toMatchObject({ kind: 'rejected', cause: 'user-denied' })
    commits.mockClear()
    memories.mockClear()

    const secondPromise = ch.request(req([tier]), {
      sessionId: 'second', toolName: 'run_shell', messageId: 'origin-second', matchKey: 'owner', trustEligible: true
    })
    await Promise.resolve()
    const second = ch.listPending()[0]!
    expect(second.confirmId).toBe(code)
    expect(second.promptMessageId).not.toBe(firstPrompt)
    for (const parsed of [
      { kind: 'approve', confirmId: code },
      { kind: 'reject', confirmId: code },
      { kind: 'approve_and_trust', confirmId: code },
      { kind: 'remember', confirmId: code, tier: 1 }
    ]) {
      expect(ch.tryResolveFromInbound(parsed, { matchKey: 'owner', messageId: 'old-reply', quotedMessageId: firstPrompt })).toBe(true)
    }
    expect(ch.tryResolveFromInbound({ kind: 'approve', confirmId: code }, { matchKey: 'owner', messageId: 'unquoted-reply' })).toBe(true)
    expect(ch.countPending()).toBe(1)
    expect(commits).not.toHaveBeenCalled()
    expect(memories).not.toHaveBeenCalled()
    expect(() => confirmIds.allocate()).toThrow('CONFIRM_ID_SPACE_EXHAUSTED')

    ch.tryResolveFromInbound({ kind: 'approve', confirmId: code }, { matchKey: 'owner', messageId: 'answer-second', quotedMessageId: second.promptMessageId })
    await expect(secondPromise).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    held.forEach((lease) => confirmIds.release(lease))
    expect(sent).toHaveLength(2)
  })

  it('确认提示发送未返回可信消息 ID 时 fail closed', async () => {
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 5000, sendPrompt: () => ({ messageId: '  ' }) })
    const result = ch.request(req(), { sessionId: 'missing-id', toolName: 'run_shell', messageId: 'origin', matchKey: 'owner' })
    const entry = ch.listPending()[0]!
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: entry.confirmId }, { matchKey: 'owner', messageId: 'answer', quotedMessageId: 'unknown-prompt' })
    await expect(result).resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable', promptSendFailure: { delivery: 'unknown' } })
    expect(ch.countPending()).toBe(0)
  })

  it('编号池耗尽时不注册 pending，也不发送提示', async () => {
    const confirmIds = new ConfirmIdSpace()
    const held = Array.from({ length: 100 }, () => confirmIds.allocate())
    const sendPrompt = vi.fn(() => ({ messageId: 'must-not-send' }))
    const ch = new ImChannel({ lane: 'wechat', timeoutMs: 5000, confirmIds, sendPrompt })
    await expect(ch.request(req(), { sessionId: 'full', toolName: 'run_shell', messageId: 'origin', matchKey: 'owner' }))
      .resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable' })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(ch.countPending()).toBe(0)
    held.forEach((lease) => confirmIds.release(lease))
  })

  it('100 条确认占满活动池时 fail closed；池中原有请求仍可逐条结算', async () => {
    const confirmIds = new ConfirmIdSpace()
    const sendPrompt = vi.fn((entry: { id: string }) => ({ messageId: `prompt-${entry.id}` }))
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 60_000, confirmIds, sendPrompt })
    const requests = Array.from({ length: 100 }, (_, index) => ch.request(req(), {
      sessionId: `capacity-${index}`, toolName: 'run_shell', messageId: `origin-${index}`, matchKey: 'owner'
    }))
    await Promise.resolve()
    expect(ch.countPending()).toBe(100)
    expect(new Set(ch.listPending().map((entry) => entry.confirmId)).size).toBe(100)

    await expect(ch.request(req(), { sessionId: 'capacity-overflow', toolName: 'run_shell', messageId: 'origin-overflow', matchKey: 'owner' }))
      .resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable' })
    expect(sendPrompt).toHaveBeenCalledTimes(100)

    for (const entry of ch.listPending()) {
      ch.tryResolveFromInbound({ kind: 'approve', confirmId: entry.confirmId }, {
        matchKey: 'owner', messageId: `answer-${entry.id}`, quotedMessageId: entry.promptMessageId
      })
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(100)
    expect(ch.countPending()).toBe(0)
    const releasedCodes = Array.from({ length: 100 }, () => confirmIds.allocate())
    expect(new Set(releasedCodes.map((lease) => lease.code)).size).toBe(100)
    releasedCodes.forEach((lease) => confirmIds.release(lease))
  })

  it('结算 A 后 A 的迟到发送失败回调不能释放 B 复用的租约', async () => {
    const confirmIds = new ConfirmIdSpace()
    const held = Array.from({ length: 99 }, () => confirmIds.allocate())
    let rejectFirst!: (error: unknown) => void
    let sends = 0
    const ch = new ImChannel({
      lane: 'wechat', timeoutMs: 5000, confirmIds,
      sendPrompt: () => {
        sends += 1
        if (sends === 1) return new Promise<{ messageId: string }>((_resolve, reject) => { rejectFirst = reject })
        return { messageId: 'prompt-second' }
      }
    })
    const firstPromise = ch.request(req(), { sessionId: 'first', toolName: 'run_shell', messageId: 'origin-first', matchKey: 'owner' })
    const first = ch.listPending()[0]!
    const reusedCode = first.confirmId!
    ch.cancel(first.id)
    await expect(firstPromise).resolves.toMatchObject({ kind: 'rejected', cause: 'cancelled' })

    const secondPromise = ch.request(req(), { sessionId: 'second', toolName: 'run_shell', messageId: 'origin-second', matchKey: 'owner' })
    await Promise.resolve()
    const second = ch.listPending()[0]!
    expect(second.confirmId).toBe(reusedCode)
    rejectFirst(new Error('late send failure'))
    await Promise.resolve()
    expect(ch.listPending()).toEqual([second])
    expect(confirmIds.isInUse(reusedCode)).toBe(true)
    expect(() => confirmIds.allocate()).toThrow('CONFIRM_ID_SPACE_EXHAUSTED')

    ch.tryResolveFromInbound({ kind: 'approve', confirmId: reusedCode }, { matchKey: 'owner', messageId: 'answer-second', quotedMessageId: second.promptMessageId })
    await expect(secondPromise).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    held.forEach((lease) => confirmIds.release(lease))
  })

  it('timeout 结算后立即释放码，发送请求的迟到回调不影响后续占用', async () => {
    const confirmIds = new ConfirmIdSpace()
    const held = Array.from({ length: 99 }, () => confirmIds.allocate())
    let rejectLateSend!: (error: unknown) => void
    let sendCalls = 0
    const ch = new ImChannel({
      lane: 'wechat', timeoutMs: 100, confirmIds,
      sendPrompt: () => {
        sendCalls += 1
        return sendCalls === 1
          ? new Promise<{ messageId: string }>((_resolve, reject) => { rejectLateSend = reject })
          : { messageId: 'prompt-b' }
      }
    })
    const firstPromise = ch.request(req(), { sessionId: 'timeout-a', toolName: 'run_shell', messageId: 'origin-a', matchKey: 'owner' })
    const first = ch.listPending()[0]!
    const code = first.confirmId!
    await expect(firstPromise).resolves.toMatchObject({ kind: 'timeout', cause: 'timeout' })
    expect(confirmIds.isInUse(code)).toBe(false)

    const secondPromise = ch.request(req(), { sessionId: 'timeout-b', toolName: 'run_shell', messageId: 'origin-b', matchKey: 'owner' })
    await Promise.resolve()
    const second = ch.listPending()[0]!
    expect(second.confirmId).toBe(code)
    rejectLateSend(new Error('late timeout send rejection'))
    await Promise.resolve()
    expect(ch.listPending()).toEqual([second])
    expect(confirmIds.isInUse(code)).toBe(true)
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: code }, { matchKey: 'owner', messageId: 'answer-b', quotedMessageId: second.promptMessageId })
    await expect(secondPromise).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    held.forEach((lease) => confirmIds.release(lease))
  })

  it('request 注册待确认并发送提示；入站 Y → approved + confirm.* 审计', async () => {
    const a = audit()
    const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = []
    let sent = 0
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 1000,
      audit: a,
      log: (event, fields) => diagnostics.push({ event, fields }),
      sendPrompt: () => {
        sent++
      }
    })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      toolInput: { command: 'ping baidu.com' },
      messageId: 'm1',
      matchKey: 'u1'
    })
    expect(sent).toBe(1)
    expect(ch.countPending()).toBe(1)
    const code = ch.listPending()[0]!.confirmId!
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: ch.listPending()[0]!.confirmId }, { matchKey: 'u1', messageId: 'm2' })
    await expect(p).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
    expect(a.events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(a.events[1]!.outcome).toBe('approved')
    expect(diagnostics.every(({ fields }) => !('shortConfirmId' in fields))).toBe(true)
    expect(diagnostics.find(({ event }) => event === 'confirm.request')?.fields.confirmId).not.toBe(code)
  })

  it('记N 档位：入站 remember → approved + memory', async () => {
    const tiers: MemoryTier[] = [
      { key: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' }, label: '记住 ping baidu.com' }
    ]
    const ch = createImChannelForTest({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
    const p = ch.request(req(tiers), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'c1',
      memoryTiers: tiers
    })
    ch.tryResolveFromInbound({ kind: 'remember', confirmId: ch.listPending()[0]!.confirmId, tier: 1 }, { matchKey: 'c1', messageId: 'm2' })
    const outcome = await p
    expect(outcome).toEqual({ kind: 'approved', memory: tiers[0]!.key, cause: 'user-approved' })
  })

  it('记N 选中后触发 onMemory 回调（链路侧写 decision_cache）', async () => {
    const tiers: MemoryTier[] = [
      { key: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' }, label: '记住 ping baidu.com' }
    ]
    const seen: Array<{ sessionId: string; tier: MemoryTier }> = []
    const ch = createImChannelForTest({
      lane: 'feishu',
      timeoutMs: 1000,
      sendPrompt: () => undefined,
      onMemory: (entry, tier) => {
        seen.push({ sessionId: entry.sessionId, tier })
      }
    })
    const p = ch.request(req(tiers), {
      sessionId: 's9',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'c1',
      memoryTiers: tiers
    })
    ch.tryResolveFromInbound({ kind: 'remember', confirmId: ch.listPending()[0]!.confirmId, tier: 1 }, { matchKey: 'c1', messageId: 'm2' })
    await p
    expect(seen).toHaveLength(1)
    expect(seen[0]!.sessionId).toBe('s9')
    expect(seen[0]!.tier).toEqual(tiers[0])
  })

  it('记忆写入失败时不得先结算 approved', async () => {
    const tiers: MemoryTier[] = [{ key: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' }, label: '记住' }]
    const ch = createImChannelForTest({
      lane: 'feishu',
      timeoutMs: 30,
      sendPrompt: () => undefined,
      onMemory: () => false
    })
    const p = ch.request(req(tiers), { sessionId: 's-fail', toolName: 'run_shell', messageId: 'm1', matchKey: 'c1', memoryTiers: tiers })
    ch.tryResolveFromInbound({ kind: 'remember', confirmId: ch.listPending()[0]!.confirmId, tier: 1 }, { matchKey: 'c1', messageId: 'm2' })
    await expect(p).resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable' })
  })

  it('可重试提交失败时保留同一 pending，第二次同一确认码可以批准', async () => {
    let attempts = 0
    const ch = createImChannelForTest({
      lane: 'feishu',
      timeoutMs: 1000,
      sendPrompt: () => undefined,
      onCommit: () => {
        attempts += 1
        return { committed: attempts > 1, canResubmit: attempts === 1 }
      }
    })
    const p = ch.request(req(), { sessionId: 's-retry', toolName: 'run_shell', messageId: 'm1', matchKey: 'c1' })
    const confirmId = ch.listPending()[0]!.confirmId
    expect(ch.tryResolveFromInbound({ kind: 'approve', confirmId }, { matchKey: 'c1', messageId: 'm2' })).toBe(true)
    expect(ch.countPending()).toBe(1)
    expect(ch.tryResolveFromInbound({ kind: 'approve', confirmId }, { matchKey: 'c1', messageId: 'm3' })).toBe(true)
    await expect(p).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(attempts).toBe(2)
  })

  it('请求结束后 pendingMemory 即清理（长跑进程不累积）', async () => {
    const tiers: MemoryTier[] = [
      { key: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' }, label: '记住 ping' }
    ]
    const ch = createImChannelForTest({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
    const p = ch.request(req(tiers), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'c1',
      memoryTiers: tiers
    })
    const id = ch.listPending()[0]!.id
    ch.tryResolveFromInbound({ kind: 'remember', confirmId: ch.listPending()[0]!.confirmId, tier: 1 }, { matchKey: 'c1', messageId: 'm2' })
    await p
    expect(ch.lastMemory(id)).toBeUndefined()
  })

  it('sendPrompt 在注册之后调用：同步触发的入站解析不丢失', async () => {
    let chRef: ImChannel | undefined
    let earlyConsumed = false
    const hints: string[] = []
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 1000,
      onHint: (_entry, kind) => hints.push(kind),
      sendPrompt: (entry) => {
        // 模拟平台 ID 未返回前的早到回复：不能被缓存或批准。
        earlyConsumed = chRef!.tryResolveFromInbound(
          { kind: 'approve', confirmId: entry.confirmId },
          { matchKey: 'u1', messageId: 'm2', quotedMessageId: 'prompt-sync' }
        )
        return { messageId: 'prompt-sync' }
      }
    })
    chRef = ch
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'u1'
    })
    await Promise.resolve()
    expect(earlyConsumed).toBe(true)
    expect(hints).toEqual(['prompt_sending'])
    expect(ch.countPending()).toBe(1)
    ch.tryResolveFromInbound(
      { kind: 'approve', confirmId: ch.listPending()[0]!.confirmId },
      { matchKey: 'u1', messageId: 'm3', quotedMessageId: 'prompt-sync' }
    )
    await expect(p).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
  })

  it('sendPrompt 同步抛异常：立即结束为 unavailable 并释放待确认项', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 50,
      log: (event, fields) => logs.push({ event, fields }),
      sendPrompt: () => {
        throw new Error('send failed secret-token=abc prompt-body=private')
      }
    })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'u1'
    })
    expect(ch.countPending()).toBe(0)
    await expect(p).resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable', promptSendFailure: { delivery: 'unknown' } })
    const failure = logs.find(({ event }) => event === 'confirm.prompt-send-failed')
    expect(failure?.fields).toMatchObject({ sendCall: 'rejected', delivery: 'unknown', errorCategory: 'unknown' })
    expect(JSON.stringify(failure)).not.toContain('secret-token')
    expect(JSON.stringify(failure)).not.toContain('private')
  })

  it('sendPrompt 异步 reject：记录安全诊断且立即结算 unavailable', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    const ch = createImChannelForTest({
      lane: 'wechat', timeoutMs: 5000,
      log: (event, fields) => logs.push({ event, fields }),
      sendPrompt: () => Promise.reject(Object.assign(new Error('private payload'), { code: 'ECONNRESET' }))
    })
    const p = ch.request(req(), { sessionId: 's1', requestId: 'r1', toolName: 'run_shell', toolInput: { command: 'private command' }, messageId: 'm1', matchKey: 'u1' })
    await expect(p).resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable' })
    const failure = logs.find(({ event }) => event === 'confirm.prompt-send-failed')
    expect(failure?.fields).toMatchObject({ lane: 'wechat', sessionId: 's1', requestId: 'r1', sendCall: 'rejected', delivery: 'unknown', errorCategory: 'transport-failed' })
    expect(JSON.stringify(failure)).not.toContain('private')
  })

  it.each([
    ['API_ERROR rate limit', { name: 'ApiError', code: 'API_ERROR', httpStatus: 429, errcode: 45009, message: 'token=secret payload=private' }, 'api-rejected', { sdkErrorCode: 'API_ERROR', httpStatus: 429, apiErrcode: 45009 }],
    ['API_ERROR expired credential', { name: 'ApiError', code: 'API_ERROR', httpStatus: 401, errcode: 42001 }, 'credentials-unavailable', { sdkErrorCode: 'API_ERROR', httpStatus: 401, apiErrcode: 42001 }],
    ['TRANSPORT_ERROR wrapping timeout', { name: 'TransportError', code: 'TRANSPORT_ERROR', cause: Object.assign(new Error('private network detail'), { code: 'ETIMEDOUT' }), message: 'private payload' }, 'transport-failed', { sdkErrorCode: 'TRANSPORT_ERROR' }],
    ['AUTH_ERROR', { name: 'ApiError', code: 'AUTH_ERROR', httpStatus: 403 }, 'credentials-unavailable', { sdkErrorCode: 'AUTH_ERROR', httpStatus: 403 }],
    ['NO_CONTEXT', { name: 'ApiError', code: 'NO_CONTEXT' }, 'inbound-context-missing', { sdkErrorCode: 'NO_CONTEXT' }]
  ] as const)('识别 SDK 错误合同 %s 且只输出白名单诊断字段', async (_label, error, errorCategory, safeFields) => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    const ch = createImChannelForTest({ lane: 'wechat', timeoutMs: 5000, log: (event, fields) => logs.push({ event, fields }), sendPrompt: () => Promise.reject(error) })
    await expect(ch.request(req(), { sessionId: 's-sdk-error', toolName: 'run_shell', toolInput: { command: 'secret command' }, messageId: 'm1', matchKey: 'u1' }))
      .resolves.toMatchObject({ promptSendFailure: { errorCategory } })
    const failure = logs.find(({ event }) => event === 'confirm.prompt-send-failed')!
    expect(failure.fields).toMatchObject({ ...safeFields, sendCall: 'rejected', delivery: 'unknown' })
    expect(JSON.stringify(failure)).not.toContain('private')
    expect(JSON.stringify(failure)).not.toContain('secret')
    expect(JSON.stringify(failure)).not.toContain('cause')
  })

  it('本地前置检查失败记录 not-attempted，回执事实不声称投递未知', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    const ch = createImChannelForTest({
      lane: 'wechat', timeoutMs: 5000,
      log: (event, fields) => logs.push({ event, fields }),
      sendPrompt: () => ({ kind: 'not-attempted', errorCategory: 'bot-unavailable' })
    })
    const pending = ch.request(req(), { sessionId: 's-preflight', requestId: 'r-preflight', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' })
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable', promptSendFailure: {
      kind: 'confirmation-prompt-send-failed', sendCall: 'not-attempted', delivery: 'not-attempted', errorCategory: 'bot-unavailable'
    } })
    expect(logs.find(({ event }) => event === 'confirm.prompt-send-failed')?.fields).toMatchObject({ sendCall: 'not-attempted', delivery: 'not-attempted', errorCategory: 'bot-unavailable' })
  })

  it('诊断 logger 抛错不改变发送失败的 unavailable 结算', async () => {
    const ch = createImChannelForTest({
      lane: 'wechat', timeoutMs: 5000,
      log: () => { throw new Error('diagnostic backend unavailable') },
      sendPrompt: () => Promise.reject(new Error('send failed'))
    })
    await expect(ch.request(req(), { sessionId: 's-log-fail', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' }))
      .resolves.toMatchObject({ kind: 'rejected', cause: 'unavailable', promptSendFailure: { delivery: 'unknown' } })
  })

  it('提示已绑定后记录 send 与 delivery 成功事实，并继续等待回答', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    const ch = createImChannelForTest({ lane: 'wechat', timeoutMs: 1000, log: (event, fields) => logs.push({ event, fields }), sendPrompt: () => undefined })
    const pending = ch.request(req(), { sessionId: 's-fulfilled', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' })
    await Promise.resolve()
    expect(ch.countPending()).toBe(1)
    expect(logs.find(({ event }) => event === 'confirm.prompt-send-finished')?.fields).toMatchObject({ sendCall: 'fulfilled', delivery: 'bound' })
    ch.cancel(ch.listPending()[0]!.id)
    await expect(pending).resolves.toEqual({ kind: 'rejected', cause: 'cancelled' })
  })

  it('发送失败后迟到的 Y 不恢复请求或触发工具批准；释放确认注册', async () => {
    let rejectSend!: (error: unknown) => void
    const ch = createImChannelForTest({
      lane: 'wechat', timeoutMs: 5000,
      sendPrompt: () => new Promise<void>((_resolve, reject) => { rejectSend = reject })
    })
    const pending = ch.request(req(), { sessionId: 's-late', toolName: 'run_shell', messageId: 'm1', matchKey: 'owner' })
    const entry = ch.listPending()[0]!
    rejectSend(new Error('send failed'))
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', promptSendFailure: { delivery: 'unknown' } })
    expect(ch.countPending()).toBe(0)
    expect(ch.tryResolveFromInbound({ kind: 'approve', confirmId: entry.confirmId }, { matchKey: 'owner', messageId: 'm2' })).toBe(true)
    expect(ch.countPending()).toBe(0)
  })

  it('用户取消不附带提示发送失败事实', async () => {
    const ch = createImChannelForTest({ lane: 'wechat', timeoutMs: 1000, sendPrompt: () => new Promise(() => undefined) })
    const pending = ch.request(req(), { sessionId: 's-cancel-send', toolName: 'run_shell', messageId: 'm1', matchKey: 'owner' })
    ch.cancel(ch.listPending()[0]!.id)
    await expect(pending).resolves.toEqual({ kind: 'rejected', cause: 'cancelled' })
  })

  it('确认 registry 超时会向平台发送/回显等待传播 AbortSignal', async () => {
    let signal: AbortSignal | undefined
    const ch = new ImChannel({
      lane: 'wechat', timeoutMs: 10,
      sendPrompt: (_entry, sendSignal) => {
        signal = sendSignal
        return new Promise(() => undefined)
      }
    })
    const pending = ch.request(req(), { sessionId: 's-timeout-abort', toolName: 'run_shell', messageId: 'm1', matchKey: 'owner' })
    await expect(pending).resolves.toEqual({ kind: 'timeout', cause: 'timeout' })
    expect(signal?.aborted).toBe(true)
    expect(ch.countPending()).toBe(0)
  })

  it('入站 rejects；resolveFromDesktop 可代答；cancelByChannel 只作用于本链路', async () => {
    const ch = createImChannelForTest({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'c1'
    })
    const id = ch.listPending()[0]!.id
    expect(ch.resolveFromDesktop(id, false)).toBe(true)
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'user-denied' })
    expect(ch.cancelByChannel('wechat')).toBe(0)
    // 会话级 pending 已清空
    expect(ch.hasPendingForSession('s1')).toBe(false)
  })

  it('sendPrompt 收到含 sessionId/toolName/confirmId 的条目（供构建 IM 提示）', async () => {
    let sentEntry: unknown
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 1000,
      sendPrompt: (entry) => {
        sentEntry = entry
      }
    })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      toolInput: { command: 'ping baidu.com' },
      messageId: 'm1',
      matchKey: 'u1',
      trustEligible: true
    })
    const e = sentEntry as { sessionId: string; toolName: string; confirmId?: string }
    expect(e.sessionId).toBe('s1')
    expect(e.toolName).toBe('run_shell')
    expect(e.confirmId).toBeTruthy()
    ch.cancel(ch.listPending()[0]!.id)
    await p.catch(() => undefined)
  })

  it('isAuthorizedInbound 拒绝未授权发送者（不消费、不解析）', async () => {
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 1000,
      sendPrompt: () => undefined,
      isAuthorizedInbound: (inbound, entry) => inbound.matchKey === entry.matchKey && entry.messageId !== inbound.messageId
    })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'u1'
    })
    const id = ch.listPending()[0]!.confirmId!
    // 未授权发送者（不同 matchKey）→ 不命中，pending 仍存在
    expect(ch.tryResolveFromInbound({ kind: 'approve', confirmId: id }, { matchKey: 'other', messageId: 'm2' })).toBe(true)
    expect(ch.countPending()).toBe(1)
    ch.cancel(ch.listPending()[0]!.id)
    await p.catch(() => undefined)
  })

  it('context 扩展上下文回传至 sendPrompt（供 IM reply 使用）', async () => {
    let sent: unknown
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 1000,
      sendPrompt: (entry) => {
        sent = entry.context
      }
    })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'u1',
      context: { raw: 'orig' }
    })
    expect((sent as { raw: string }).raw).toBe('orig')
    ch.cancel(ch.listPending()[0]!.id)
    await p.catch(() => undefined)
  })
})

describe('P0 审计如实归因（R1 补充：IM 侧 confirm.* 落点）', () => {
  it('confirm.outcome 的 actor=user 且 cause 非空（批准路径；request 无裁决不落 cause）', async () => {
    const a = audit()
    const ch = createImChannelForTest({
      lane: 'wechat',
      timeoutMs: 1000,
      audit: a,
      sendPrompt: (entry) => {
        chRef!.tryResolveFromInbound(
          { kind: 'approve', confirmId: entry.confirmId },
          { matchKey: 'u1', messageId: 'm2', quotedMessageId: 'audit-prompt' }
        )
        return { messageId: 'audit-prompt' }
      }
    })
    const chRef = ch
    const p = ch.request(req(), { sessionId: 's1', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' })
    await Promise.resolve()
    ch.tryResolveFromInbound(
      { kind: 'approve', confirmId: ch.listPending()[0]!.confirmId },
      { matchKey: 'u1', messageId: 'm3', quotedMessageId: 'audit-prompt' }
    )
    await p
    expect(a.events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(a.events[0]!.actor).toBe('user')
    expect(a.events[0]!.cause).toBeUndefined()
    expect(a.events[1]!.actor).toBe('user')
    expect(a.events[1]!.cause).toBe('user-approved')
  })

  it('超时路径 cause=timeout 且 actor 如实为 system（无回答动作）', async () => {
    const a = audit()
    const ch = createImChannelForTest({ lane: 'feishu', timeoutMs: 30, audit: a, sendPrompt: () => undefined })
    await ch.request(req(), { sessionId: 's2', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' })
    expect(a.events.at(-1)!.cause).toBe('timeout')
    expect(a.events.at(-1)!.actor).toBe('system')
  })
})
