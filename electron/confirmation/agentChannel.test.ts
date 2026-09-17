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

  it('I5 深度计数兜底：审批进行中再进入 AgentChannel → 立即 rejected + cause=recursion-blocked', async () => {
    let release: (() => void) | undefined
    const { ch } = channel({
      invokeApproval: () =>
        new Promise<ApprovalInvocationResult>((resolve) => {
          release = () => resolve({ ok: true, verdict: APPROVE })
        })
    })
    const outer = ch.request(req())
    // 外层审批尚未返回时，嵌套的确认请求必须被立即拒绝（豁免失效兜底）
    const nested = channel()
    const nestedOutcome = await nested.ch.request(req())
    expect(nestedOutcome).toMatchObject({ kind: 'rejected', cause: 'recursion-blocked' })
    release?.()
    await expect(outer).resolves.toMatchObject({ kind: 'approved' })
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
