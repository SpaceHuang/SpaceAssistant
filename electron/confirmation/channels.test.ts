import { describe, expect, it } from 'vitest'
import { channelFor, DesktopChannel } from './channels'
import type { AuditSink } from './channels'
import { ImChannel } from './imChannel'
import type { ConfirmRequest, SecurityAuditEvent } from '../../src/shared/confirmation/types'

function req(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    facts: {
      toolName: 'run_shell',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [{ kind: 'command-sequence', commands: [{ verb: 'curl', args: [], signature: 'curl x' }] }],
      summary: { text: '命令序列：curl x' }
    },
    riskLevel: 'high',
    memoryTiers: [],
    timeoutMs: null,
    ...overrides
  }
}

function auditSink(): AuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { events, record: (e) => events.push(e) }
}

describe('DesktopChannel', () => {
  it('approved 映射为 {kind:approved}，并落 confirm.request/outcome（同 requestId）', async () => {
    const audit = auditSink()
    const ch = new DesktopChannel({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      sessionId: 's1',
      toolName: 'run_shell',
      lane: 'desktop',
      audit,
      waitForToolConfirm: async () => 'approved'
    })
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'approved', cause: 'user-approved' })
    const events = audit.events
    expect(events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(events[0]!.requestId).toBe('req-1')
    expect(events[1]!.requestId).toBe('req-1')
    expect(events[1]!.outcome).toBe('approved')
    expect(events[0]!.factsSummary).toBe('命令序列：curl x')
  })

  it('timeout / rejected 正确映射', async () => {
    const audit = auditSink()
    const ch = new DesktopChannel({
      requestId: 'r',
      toolUseId: 't',
      sessionId: 's',
      toolName: 'run_shell',
      lane: 'desktop',
      audit,
      waitForToolConfirm: async () => 'timeout'
    })
    expect(await ch.request(req())).toEqual({ kind: 'timeout', cause: 'timeout' })
  })
})

describe('channelFor 远程分支（ImChannel 直连）', () => {
  const buildPending = () => ({
    sessionId: 's2',
    toolName: 'run_shell',
    messageId: 'm1',
    matchKey: 'u1',
    requestId: 'req-2'
  })

  it("入站 'y'→approved，confirm.request/outcome 审计同一 requestId 关联", async () => {
    const audit = auditSink()
    const im = new ImChannel({ lane: 'wechat', timeoutMs: 1000, audit, sendPrompt: () => undefined })
    const ch = channelFor({
      lane: 'wechat',
      requestId: 'req-2',
      sessionId: 's2',
      toolName: 'run_shell',
      imChannel: im,
      buildImPending: buildPending
    })
    const p = ch.request(req())
    const cid = im.listPending()[0]!.confirmId!
    im.tryResolveFromInbound({ kind: 'approve', confirmId: cid }, { matchKey: 'u1', messageId: 'm2' })
    await expect(p).resolves.toEqual({ kind: 'approved', cause: 'user-approved' })
    expect(audit.events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    expect(audit.events[0]!.requestId).toBe('req-2')
    expect(audit.events[1]!.requestId).toBe('req-2')
    expect(audit.events[1]!.outcome).toBe('approved')
  })

  it("入站 'n'→rejected；缺 imChannel 时兜底 rejected（不发消息）", async () => {
    const audit = auditSink()
    const im = new ImChannel({ lane: 'feishu', timeoutMs: 1000, audit, sendPrompt: () => undefined })
    const ch = channelFor({
      lane: 'feishu',
      requestId: 'req-3',
      sessionId: 's2',
      toolName: 'run_shell',
      imChannel: im,
      buildImPending: buildPending
    })
    const p = ch.request(req())
    const cid = im.listPending()[0]!.confirmId!
    im.tryResolveFromInbound({ kind: 'reject', confirmId: cid }, { matchKey: 'u1', messageId: 'm2' })
    await expect(p).resolves.toEqual({ kind: 'rejected', cause: 'user-denied' })
    expect(audit.events.at(-1)!.outcome).toBe('rejected')

    const noIm = channelFor({ lane: 'wechat', requestId: 'r', sessionId: 's', toolName: 'run_shell' })
    await expect(noIm.request(req())).resolves.toEqual({ kind: 'rejected', cause: 'no-answerer' })
  })
})

describe('P0 审计如实归因（B1 收窄范围）：confirm.* 事件 actor 如实', () => {
  it('DesktopChannel confirm.request/outcome actor=user，outcome 携带非空 cause', async () => {
    const audit = auditSink()
    const ch = new DesktopChannel({
      requestId: 'req-actor-1',
      toolUseId: 'tool-actor-1',
      sessionId: 's1',
      toolName: 'run_shell',
      lane: 'desktop',
      audit,
      waitForToolConfirm: async () => 'approved'
    })
    await ch.request(req())
    const events = audit.events
    expect(events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    // request 无裁决：actor 如实但不落 cause；outcome 携带非空 cause
    expect(events[0]!.actor).toBe('user')
    expect(events[0]!.cause).toBeUndefined()
    expect(events[1]!.actor).toBe('user')
    expect(events[1]!.cause).toBe('user-approved')
  })

  it('DesktopChannel 用户拒绝 cause=user-denied、超时 cause=timeout', async () => {
    const audit = auditSink()
    const ch = new DesktopChannel({
      requestId: 'r',
      toolUseId: 't',
      sessionId: 's',
      toolName: 'run_shell',
      lane: 'desktop',
      audit,
      waitForToolConfirm: async () => 'rejected'
    })
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'rejected', cause: 'user-denied' })
    expect(audit.events.at(-1)!.cause).toBe('user-denied')

    const audit2 = auditSink()
    const ch2 = new DesktopChannel({
      requestId: 'r2',
      toolUseId: 't2',
      sessionId: 's',
      toolName: 'run_shell',
      lane: 'desktop',
      audit: audit2,
      waitForToolConfirm: async () => 'timeout'
    })
    const outcome2 = await ch2.request(req())
    expect(outcome2).toEqual({ kind: 'timeout', cause: 'timeout' })
    expect(audit2.events.at(-1)!.cause).toBe('timeout')
    // 超时无回答动作，actor 如实为 system
    expect(audit2.events.at(-1)!.actor).toBe('system')
  })

  it('channelFor automation 分支：拒绝 actor 保持 system（无回答者）、cause=no-answerer', async () => {
    const audit = auditSink()
    const ch = channelFor({
      lane: 'automation',
      requestId: 'req-auto-1',
      sessionId: 's-auto',
      toolName: 'write_file',
      audit
    })
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'rejected', cause: 'no-answerer' })
    const events = audit.events
    expect(events.map((e) => e.event)).toEqual(['confirm.outcome'])
    expect(events[0]!.actor).toBe('system')
    expect(events[0]!.cause).toBe('no-answerer')
    expect(events[0]!.reason).toBe('no-answerer')
  })
})
