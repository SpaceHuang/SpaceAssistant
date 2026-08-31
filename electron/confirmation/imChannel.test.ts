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
    await expect(p).resolves.toEqual({ kind: 'approved' })
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
    expect(outcome).toEqual({ kind: 'approved', memory: tiers[0]!.key })
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
    await expect(p).resolves.toEqual({ kind: 'rejected' })
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
})
