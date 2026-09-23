/**
 * P2-3 AgentChannel：把一次审批调用包装为 ConfirmOutcome。
 * I3（不产生 memory）、I4（fail-closed cause 可区分）、I5（深度计数兜底）、审计五问（actor/actorRef/latencyMs）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentChannel } from './agentChannel'
import type { AuditSink } from './channels'
import type {
  ApprovalInvocation,
  ApprovalInvocationResult,
  ApprovalVerdict,
  ConfirmRequest,
  SecurityAuditEvent
} from '../../src/shared/confirmation/types'
import { ApprovalAdmission } from '../../packages/agent-core/src/approval'

function req(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    facts: {
      toolName: 'write_file',
      actionClass: 'write',
      baseRiskLevel: 'medium',
      signals: [{ kind: 'path-target', path: 'a.txt', zone: 'workdir-normal' }],
      summary: { text: 'write_file a.txt' }
    },
    riskLevel: 'medium',
    memoryTiers: [],
    timeoutMs: null,
    ...overrides
  }
}

function audit(): AuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { events, record: (e) => events.push(e) }
}

const APPROVE: ApprovalVerdict = { kind: 'approve', reason: { summary: '常规工作目录内写入，风险可控' } }
const DENY: ApprovalVerdict = { kind: 'deny', reason: { summary: '目标在敏感目录外，拒绝写入' } }

function channel(overrides: Partial<ConstructorParameters<typeof AgentChannel>[0]> = {}) {
  const invokeApproval = vi.fn(
    async (): Promise<ApprovalInvocationResult> => ({ ok: true, verdict: APPROVE })
  )
  const ch = new AgentChannel({
    lane: 'automation',
    requestId: 'req-agent-1',
    sessionId: 's-agent',
    toolName: 'write_file',
    policy: { kind: 'agent', approvalProfileId: 'approval-default' },
    invokeApproval,
    ...overrides
  })
  return { ch, invokeApproval }
}

describe('AgentChannel（P2-3）', () => {
  it('approve 裁决 → approved + answererKind=agent + cause=agent-approved，无 memory（I3）', async () => {
    const { ch } = channel()
    const outcome = await ch.request(req())
    expect(outcome.kind).toBe('approved')
    expect(outcome).toMatchObject({ answererKind: 'agent', cause: 'agent-approved' })
    expect('memory' in outcome).toBe(false)
  })

  it('deny 裁决 → rejected + cause=agent-deny，reason.summary 保留（理由回传）', async () => {
    const ch2 = new AgentChannel({
      lane: 'automation',
      requestId: 'r',
      sessionId: 's',
      toolName: 'write_file',
      policy: { kind: 'agent' },
      invokeApproval: async () => ({ ok: true, verdict: DENY })
    })
    const outcome = await ch2.request(req())
    expect(outcome).toMatchObject({ kind: 'rejected', answererKind: 'agent', cause: 'agent-deny' })
    expect(outcome.kind === 'rejected' && outcome.reason?.summary).toBe('目标在敏感目录外，拒绝写入')
  })

  it('invokeApproval 超时 → rejected + cause=timeout（非挂 5 分钟）', async () => {
    const { ch } = channel({
      invokeApproval: () => new Promise<ApprovalInvocationResult>(() => undefined)
    })
    const outcome = await ch.request(req({ timeoutMs: 30 }))
    expect(outcome).toMatchObject({ kind: 'rejected', answererKind: 'agent', cause: 'timeout' })
  })

  it('审批槽已获准但内层挂起时，超时仍释放审批槽', async () => {
    const pool = new ApprovalAdmission({ concurrency: 1, queueLimit: 1 })
    const { ch } = channel({ approvalAdmission: pool, invokeApproval: () => new Promise<ApprovalInvocationResult>(() => undefined) })
    await ch.request(req({ timeoutMs: 10 }))
    expect(pool.snapshot()).toEqual({ active: 0, queued: 0 })
    await expect(pool.acquire({ requestId: 'next', parentTaskId: 'parent' })).resolves.toMatchObject({ kind: 'granted' })
  })

  it('invokeApproval 失败（unavailable/unparsable/config-error）→ rejected 且 cause 逐一透传', async () => {
    for (const cause of ['unavailable', 'unparsable', 'config-error'] as const) {
      const { ch } = channel({
        invokeApproval: async () => ({ ok: false, cause, summary: `x-${cause}` })
      })
      const outcome = await ch.request(req())
      expect(outcome.kind).toBe('rejected')
      expect(outcome.kind === 'rejected' && outcome.cause).toBe(cause)
    }
  })

  it('超时取 req.timeoutMs ?? policy.timeoutMs ?? 30s（有上界，I4）', async () => {
    vi.useFakeTimers()
    const hanging = () => new Promise<ApprovalInvocationResult>(() => undefined)
    // req.timeoutMs 优先
    const a = channel({ invokeApproval: hanging })
    const pa = a.ch.request(req({ timeoutMs: 25 }))
    const paDone = vi.fn()
    void pa.then(paDone)
    await vi.advanceTimersByTimeAsync(40)
    expect(paDone).toHaveBeenCalled()
    // policy.timeoutMs 次之
    const b = channel({ invokeApproval: hanging, policy: { kind: 'agent', timeoutMs: 40 } })
    const pb = b.ch.request(req())
    const pbDone = vi.fn()
    void pb.then(pbDone)
    await vi.advanceTimersByTimeAsync(50)
    expect(pbDone).toHaveBeenCalled()
    // 都没有 → 30s 默认上界
    const c = channel({ invokeApproval: hanging })
    const pc = c.ch.request(req())
    const pcDone = vi.fn()
    void pc.then(pcDone)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(pcDone).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pcDone).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('confirm.request / confirm.outcome 成对，actor=agent + actorRef.profileId + latencyMs（审计五问）', async () => {
    const a = audit()
    const { ch, invokeApproval } = channel({ audit: a })
    await ch.request(req())
    expect(invokeApproval).toHaveBeenCalledTimes(1)
    const inv = invokeApproval.mock.calls[0]![0] as ApprovalInvocation
    expect(inv.profileId).toBe('approval-default')
    expect(inv.clue.toolName).toBe('write_file')
    expect(inv.clue.summary).toBe('write_file a.txt')
    expect(a.events.map((e) => e.event)).toEqual(['confirm.request', 'confirm.outcome'])
    for (const ev of a.events) {
      expect(ev.actor).toBe('agent')
      expect(ev.actorRef?.profileId).toBe('approval-default')
    }
    expect(typeof a.events[1]!.latencyMs).toBe('number')
    expect(a.events[1]!.cause).toBe('agent-approved')
  })

  it('I5 兜底（P1-4 修复：会话作用域）：确认请求来自进行中的审批内部会话 → 立即 rejected + cause=recursion-blocked', async () => {
    const { markApprovalSessionActive, unmarkApprovalSessionActive } = await import('./agentChannel')
    markApprovalSessionActive('sess-approval-inner')
    try {
      const ch2 = new AgentChannel({
        lane: 'automation',
        requestId: 'r-inner',
        sessionId: 'sess-approval-inner',
        toolName: 'write_file',
        policy: { kind: 'agent' },
        invokeApproval: async () => ({ ok: true, verdict: APPROVE })
      })
      const outcome = await ch2.request(req())
      expect(outcome).toMatchObject({ kind: 'rejected', cause: 'recursion-blocked' })
    } finally {
      unmarkApprovalSessionActive('sess-approval-inner')
    }
    // 守卫解除后同会话恢复正常裁决
    const ch3 = new AgentChannel({
      lane: 'automation',
      requestId: 'r-inner-2',
      sessionId: 'sess-approval-inner',
      toolName: 'write_file',
      policy: { kind: 'agent' },
      invokeApproval: async () => ({ ok: true, verdict: APPROVE })
    })
    await expect(ch3.request(req())).resolves.toMatchObject({ kind: 'approved' })
  })

  it('P1-4 并发不误伤：两个不同会话的审批同时进行，均正常裁决、无 recursion-blocked', async () => {
    let release1: (() => void) | undefined
    let release2: (() => void) | undefined
    const makeHanging = (setter: (fn: () => void) => void) =>
      new Promise<ApprovalInvocationResult>((resolve) => {
        setter(() => resolve({ ok: true, verdict: APPROVE }))
      })
    const chA = new AgentChannel({
      lane: 'automation',
      requestId: 'req-a',
      sessionId: 'sess-a',
      toolName: 'write_file',
      policy: { kind: 'agent' },
      invokeApproval: () => makeHanging((fn) => (release1 = fn))
    })
    const chB = new AgentChannel({
      lane: 'automation',
      requestId: 'req-b',
      sessionId: 'sess-b',
      toolName: 'write_file',
      policy: { kind: 'agent' },
      invokeApproval: () => makeHanging((fn) => (release2 = fn))
    })
    const pa = chA.request(req())
    const pb = chB.request(req())
    release2?.()
    await expect(pb).resolves.toMatchObject({ kind: 'approved' })
    release1?.()
    await expect(pa).resolves.toMatchObject({ kind: 'approved' })
  })

  it('独立审批池满载时排队，不消耗旧任务准入票据', async () => {
    const pool = new ApprovalAdmission({ concurrency: 1, queueLimit: 1 })
    let releaseFirst: (() => void) | undefined
    const pending = new Promise<ApprovalInvocationResult>((resolve) => { releaseFirst = () => resolve({ ok: true, verdict: APPROVE }) })
    const first = channel({ approvalAdmission: pool, invokeApproval: () => pending }).ch
    const secondInvoke = vi.fn(async () => ({ ok: true as const, verdict: APPROVE }))
    const second = channel({ approvalAdmission: pool, invokeApproval: secondInvoke }).ch
    const firstResult = first.request(req({ timeoutMs: 5_000 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const secondResult = second.request(req({ timeoutMs: 5_000 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondInvoke).not.toHaveBeenCalled()
    releaseFirst?.()
    await expect(firstResult).resolves.toMatchObject({ kind: 'approved' })
    await expect(secondResult).resolves.toMatchObject({ kind: 'approved' })
  })

  it('取消排队中的审批会移除 waiter，之后释放槽位也不会启动模型', async () => {
    const pool = new ApprovalAdmission({ concurrency: 1, queueLimit: 1 })
    const held = await pool.acquire({ requestId: 'held', parentTaskId: 'p-held' })
    const invoke = vi.fn(async () => ({ ok: true as const, verdict: APPROVE }))
    const { ch } = channel({ approvalAdmission: pool, invokeApproval: invoke })
    const pending = ch.request(req({ timeoutMs: 5_000 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    ch.cancel('outer')
    await expect(pending).resolves.toMatchObject({ kind: 'rejected' })
    expect(pool.snapshot().queued).toBe(0)
    if (held.kind === 'granted') held.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('cancel 中断内层调用（signalChatCancel）', async () => {
    const invokeApproval = vi.fn(() => new Promise<ApprovalInvocationResult>(() => undefined))
    const ch = new AgentChannel({
      lane: 'automation',
      requestId: 'req-cancel',
      sessionId: 's',
      toolName: 'write_file',
      policy: { kind: 'agent' },
      invokeApproval
    })
    const pending = ch.request(req({ timeoutMs: 60_000 }))
    const inv = invokeApproval.mock.calls[0]![0] as ApprovalInvocation
    ch.cancel('whatever')
    // cancel 后审批内层请求被信号取消，request 以 fail-closed 收敛
    await expect(pending).resolves.toMatchObject({ kind: 'rejected' })
    void inv
  })
})

describe('AgentChannel 任务声明透传（D：可信证据）', () => {
  it('deps.taskDigest → invocation.clue.taskDigest 原样透传', async () => {
    const { ch, invokeApproval } = channel({ taskDigest: '整理报告目录并汇总周报' })
    await ch.request(req())
    const inv = invokeApproval.mock.calls[0]![0] as ApprovalInvocation
    expect(inv.clue.taskDigest).toBe('整理报告目录并汇总周报')
  })

  it('缺省（无任务上下文调用方）→ clue.taskDigest undefined', async () => {
    const { ch, invokeApproval } = channel()
    await ch.request(req())
    const inv = invokeApproval.mock.calls[0]![0] as ApprovalInvocation
    expect(inv.clue.taskDigest).toBeUndefined()
  })
})
