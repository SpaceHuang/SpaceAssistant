import { describe, expect, it, vi } from 'vitest'
import { channelFor, DesktopChannel, ImRequestChannel, DenyChannel, resolveConfirmChannel } from './channels'
import type { AuditSink } from './channels'
import { ImChannel } from './imChannel'
import type { ConfirmAnswererMap, ConfirmRequest, SecurityAuditEvent } from '../../src/shared/confirmation/types'

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

  it('P1-4 超时可配：req.timeoutMs 传递给 waitForToolConfirm', async () => {
    const wait = vi.fn(async () => 'approved' as const)
    const ch = new DesktopChannel({
      requestId: 'req-to',
      toolUseId: 'tool-to',
      sessionId: 's',
      toolName: 'run_shell',
      lane: 'desktop',
      waitForToolConfirm: wait
    })
    await ch.request(req({ timeoutMs: 30000 }))
    expect(wait).toHaveBeenCalledWith(
      'req-to',
      'tool-to',
      [],
      { toolName: 'run_shell', lane: 'desktop' },
      30000
    )
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

  it('deny × automation（显式配置）：拒绝 actor 保持 system（无回答者）、cause=no-answerer', async () => {
    const audit = auditSink()
    const ch = channelFor({
      lane: 'automation',
      requestId: 'req-auto-1',
      sessionId: 's-auto',
      toolName: 'write_file',
      answererPolicy: { kind: 'deny' },
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

describe('P1-1 resolveConfirmChannel 二维解析（回答者种类 × 传输通道）', () => {
  const baseArgs = {
    requestId: 'req-rcc',
    sessionId: 's-rcc',
    toolName: 'write_file'
  }
  const buildPending = () => ({
    sessionId: 's-rcc',
    toolName: 'write_file',
    messageId: 'm1',
    matchKey: 'u1'
  })

  it('user × desktop → DesktopChannel（现状等价）', () => {
    const ch = resolveConfirmChannel({ ...baseArgs, lane: 'desktop' })
    expect(ch).toBeInstanceOf(DesktopChannel)
  })

  it('user × wechat / feishu（有 imChannel）→ ImRequestChannel（现状等价）', () => {
    const im = new ImChannel({ lane: 'wechat', timeoutMs: 1000, sendPrompt: () => undefined })
    expect(
      resolveConfirmChannel({ ...baseArgs, lane: 'wechat', imChannel: im, buildImPending: buildPending })
    ).toBeInstanceOf(ImRequestChannel)
    const imF = new ImChannel({ lane: 'feishu', timeoutMs: 1000, sendPrompt: () => undefined })
    expect(
      resolveConfirmChannel({ ...baseArgs, lane: 'feishu', imChannel: imF, buildImPending: buildPending })
    ).toBeInstanceOf(ImRequestChannel)
  })

  it('deny × automation（显式配置，RejectingChannel 语义保留）→ DenyChannel，出口等价（rejected + no-answerer + system 审计）', async () => {
    const audit = auditSink()
    const ch = resolveConfirmChannel({ ...baseArgs, lane: 'automation', answererPolicy: { kind: 'deny' }, audit })
    expect(ch).toBeInstanceOf(DenyChannel)
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'rejected', cause: 'no-answerer' })
    expect(audit.events.at(-1)!.actor).toBe('system')
    expect(audit.events.at(-1)!.cause).toBe('no-answerer')
  })

  it('P3 收缩：回答者缺省 = user（由 gate 决策派生，不再按 lane 查默认表）；automation 无 IM 传输 → no-answerer deny 兜底', async () => {
    const ch = resolveConfirmChannel({ ...baseArgs, lane: 'automation' })
    expect(ch).toBeInstanceOf(DenyChannel)
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'rejected', cause: 'no-answerer' })
  })

  it('deny × IM（显式 notifyDenied）→ 回执被调用（不静默吞掉远端用户的等待）', async () => {
    const notifyDenied = vi.fn()
    const ch = resolveConfirmChannel({
      ...baseArgs,
      lane: 'wechat',
      answererPolicy: { kind: 'deny' },
      notifyDenied
    })
    expect(ch).toBeInstanceOf(DenyChannel)
    const r = req()
    await ch.request(r)
    expect(notifyDenied).toHaveBeenCalledWith(r)
  })

  it('deny × desktop → 静默拒绝（无 notifyDenied 出口）', async () => {
    const notifyDenied = vi.fn()
    const ch = resolveConfirmChannel({
      ...baseArgs,
      lane: 'desktop',
      answererPolicy: { kind: 'deny' },
      notifyDenied
    })
    await ch.request(req())
    expect(notifyDenied).not.toHaveBeenCalled()
  })

  it('配置损坏（非法 kind）→ fail-closed deny + cause=config-error + 告警审计，绝不回退 user', async () => {
    const audit = auditSink()
    const broken = { kind: 'robot' } as unknown as ConfirmAnswererMap['desktop']
    const ch = resolveConfirmChannel({ ...baseArgs, lane: 'desktop', answererPolicy: broken, audit })
    expect(ch).toBeInstanceOf(DenyChannel)
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'rejected', cause: 'config-error' })
    const warn = audit.events.find((e) => e.event === 'confirm.answerer-fallback')
    expect(warn).toBeTruthy()
    expect(warn!.actor).toBe('system')
  })

  it("kind='agent' 无 factory（P1 未接线）→ fail-closed deny + cause=config-error + 告警，绝不回退 user", async () => {
    const audit = auditSink()
    const ch = resolveConfirmChannel({ ...baseArgs, lane: 'automation', answererPolicy: { kind: 'agent' }, audit })
    expect(ch).toBeInstanceOf(DenyChannel)
    const outcome = await ch.request(req())
    expect(outcome).toEqual({ kind: 'rejected', cause: 'config-error' })
    expect(audit.events.find((e) => e.event === 'confirm.answerer-fallback')).toBeTruthy()
  })

  it("kind='agent' + factory → factory 产出通道（P2 AgentChannel 挂点）", () => {
    const stub = { request: async () => ({ kind: 'rejected', cause: 'agent-deny' } as const), cancel: () => undefined }
    const ch = resolveConfirmChannel({
      ...baseArgs,
      lane: 'automation',
      answererPolicy: { kind: 'agent', approvalProfileId: 'p1' },
      agentChannelFactory: () => stub
    })
    expect(ch).toBe(stub)
  })
})
