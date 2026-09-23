import { describe, expect, it } from 'vitest'
import { ImChannel } from './imChannel'
import type { AuditSink } from './channels'
import type { ConfirmRequest, MemoryTier, SecurityAuditEvent } from '../../src/shared/confirmation/types'

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
  it('request 注册待确认并发送提示；入站 Y → approved + confirm.* 审计', async () => {
    const a = audit()
    let sent = 0
    const ch = new ImChannel({
      lane: 'wechat',
      timeoutMs: 1000,
      audit: a,
      log: () => undefined,
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
    ch.tryResolveFromInbound({ kind: 'approve', confirmId: ch.listPending()[0]!.confirmId }, { matchKey: 'u1', messageId: 'm2' })
    await expect(p).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
    expect(a.events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(a.events[1]!.outcome).toBe('approved')
  })

  it('记N 档位：入站 remember → approved + memory', async () => {
    const tiers: MemoryTier[] = [
      { key: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' }, label: '记住 ping baidu.com' }
    ]
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
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
    const ch = new ImChannel({
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
    const ch = new ImChannel({
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
    const ch = new ImChannel({
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
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
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
    const ch = new ImChannel({
      lane: 'wechat',
      timeoutMs: 1000,
      sendPrompt: (entry) => {
        // 模拟同步回环：发送提示的同一调用栈内就收到入站 Y
        chRef!.tryResolveFromInbound(
          { kind: 'approve', confirmId: entry.confirmId },
          { matchKey: 'u1', messageId: 'm2' }
        )
      }
    })
    chRef = ch
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'u1'
    })
    await expect(p).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
  })

  it('sendPrompt 同步抛异常：立即结束为 unavailable 并释放待确认项', async () => {
    const ch = new ImChannel({
      lane: 'wechat',
      timeoutMs: 50,
      sendPrompt: () => {
        throw new Error('send failed')
      }
    })
    const p = ch.request(req(), {
      sessionId: 's1',
      toolName: 'run_shell',
      messageId: 'm1',
      matchKey: 'u1'
    })
    expect(ch.countPending()).toBe(0)
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'unavailable' })
  })

  it('入站 rejects；resolveFromDesktop 可代答；cancelByChannel 只作用于本链路', async () => {
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
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
    const ch = new ImChannel({
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
    const ch = new ImChannel({
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
    const ch = new ImChannel({
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
    const ch = new ImChannel({
      lane: 'wechat',
      timeoutMs: 1000,
      audit: a,
      sendPrompt: (entry) => {
        chRef!.tryResolveFromInbound(
          { kind: 'approve', confirmId: entry.confirmId },
          { matchKey: 'u1', messageId: 'm2' }
        )
      }
    })
    const chRef = ch
    const p = ch.request(req(), { sessionId: 's1', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' })
    await p
    expect(a.events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(a.events[0]!.actor).toBe('user')
    expect(a.events[0]!.cause).toBeUndefined()
    expect(a.events[1]!.actor).toBe('user')
    expect(a.events[1]!.cause).toBe('user-approved')
  })

  it('超时路径 cause=timeout 且 actor 如实为 system（无回答动作）', async () => {
    const a = audit()
    const ch = new ImChannel({ lane: 'feishu', timeoutMs: 30, audit: a, sendPrompt: () => undefined })
    await ch.request(req(), { sessionId: 's2', toolName: 'run_shell', messageId: 'm1', matchKey: 'u1' })
    expect(a.events.at(-1)!.cause).toBe('timeout')
    expect(a.events.at(-1)!.actor).toBe('system')
  })
})
