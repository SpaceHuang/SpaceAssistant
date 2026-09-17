import type {
  ApprovalInvocation,
  ApprovalInvocationResult,
  ConfirmAnswererPolicy,
  ConfirmOutcome,
  ConfirmRequest,
  ConfirmationChannel,
  ExecutionLane
} from '../../src/shared/confirmation/types'
import { signalChatCancel } from '../chatCancelRegistry'
import type { AuditSink } from './channels'

/** 审批调用默认超时上界（方案 §12-2 取值 30s）；req.timeoutMs / policy.timeoutMs 可覆盖，必须有上界。 */
export const DEFAULT_AGENT_APPROVAL_TIMEOUT_MS = 30_000

/** I5 深度计数：审批进行中的嵌套确认请求一律 fail-closed（豁免失效兜底）。 */
let approvalDepth = 0

let invocationSeq = 0

function summaryFor(cause: 'timeout' | 'unavailable' | 'unparsable' | 'config-error'): string {
  switch (cause) {
    case 'timeout':
      return '安全审批超时，已按拒绝处理。可改用只读方式完成，或缩小操作范围后重试。'
    case 'unparsable':
      return '安全审批输出无法解析，已按拒绝处理。'
    case 'config-error':
      return '安全审批配置不可用，已按拒绝处理。'
    default:
      return '安全审批服务暂不可用，已按拒绝处理。请改用只读方式或稍后重试。'
  }
}

/**
 * P2-3 AgentChannel：把一次审批 Agent 调用包装为 ConfirmOutcome（I1 回答者位置）。
 * - 不产生 memory（I3：裁决永不落缓存，返回值类型上就不含 memory）；
 * - fail-closed（I4）：超时 / 失败 / 不可解析一律 rejected，cause 与 agent-deny 可区分；
 * - I5 深度计数兜底：审批进行中再进入确认 → 立即 rejected(cause=recursion-blocked)；
 * - 审计 confirm.request / confirm.outcome 成对，actor='agent' + actorRef + latencyMs（审计五问）。
 */
export class AgentChannel implements ConfirmationChannel {
  /** 进行中调用的 chat 取消 id（cancel 时 signalChatCancel 中断内层）。 */
  private inflightCancelId: string | null = null
  /** 进行中调用的收敛出口（cancel 时以 fail-closed 收敛 request）。 */
  private inflightSettle: ((r: ApprovalInvocationResult) => void) | null = null

  constructor(
    private readonly deps: {
      lane: ExecutionLane
      requestId: string
      sessionId: string
      toolName: string
      policy: ConfirmAnswererPolicy
      audit?: AuditSink
      invokeApproval: (inv: ApprovalInvocation) => Promise<ApprovalInvocationResult>
    }
  ) {}

  async request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const profileId = this.deps.policy.approvalProfileId ?? 'approval-default'
    invocationSeq += 1
    const invocationId = `approval-${Date.now()}-${invocationSeq}`
    const innerRequestId = `${this.deps.requestId}:approval`

    // ===== I5 深度计数兜底：审批进行中不允许再进入确认流程 =====
    if (approvalDepth > 0) {
      const cause = 'recursion-blocked' as const
      this.deps.audit?.record({
        ts: Date.now(),
        event: 'confirm.outcome',
        lane: this.deps.lane,
        sessionId: this.deps.sessionId,
        requestId: this.deps.requestId,
        toolName: this.deps.toolName,
        outcome: 'rejected',
        cause,
        actor: 'agent',
        actorRef: { profileId, invocationId }
      })
      return {
        kind: 'rejected',
        answererKind: 'agent',
        cause,
        reason: { summary: '安全策略无法完成裁决：审批会话内不允许再进入确认流程，已拒绝。' }
      }
    }

    const clue = {
      toolName: req.facts.toolName,
      actionClass: req.facts.actionClass,
      riskLevel: req.riskLevel,
      summary: req.facts.summary.text,
      signals: req.facts.signals.map((s) => s.kind)
    }
    const invocation: ApprovalInvocation = {
      clue,
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      requestId: innerRequestId,
      invocationId,
      profileId,
      // P1-4 通道打通：req.timeoutMs 优先（决策层/回答者配置下发），缺省 30s 上界
      timeoutMs: req.timeoutMs ?? this.deps.policy.timeoutMs ?? DEFAULT_AGENT_APPROVAL_TIMEOUT_MS
    }

    this.deps.audit?.record({
      ts: Date.now(),
      event: 'confirm.request',
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      requestId: this.deps.requestId,
      toolName: this.deps.toolName,
      riskLevel: req.riskLevel,
      factsSummary: req.facts.summary.text,
      actor: 'agent',
      actorRef: { profileId, invocationId }
    })

    const startedAt = Date.now()
    approvalDepth += 1
    this.inflightCancelId = innerRequestId
    let result: ApprovalInvocationResult
    try {
      // 有界性（I4）：invokeApproval 竞速超时上界——内层实现自身另有超时，这里是通道级兜底
      result = await new Promise<ApprovalInvocationResult>((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          signalChatCancel(innerRequestId)
          resolve({ ok: false, cause: 'timeout' })
        }, invocation.timeoutMs)
        const finish = (r: ApprovalInvocationResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(r)
        }
        this.deps
          .invokeApproval(invocation)
          .then((r) => finish(r), () => finish({ ok: false, cause: 'unavailable' }))
        this.inflightSettle = (r) => finish(r)
      })
    } finally {
      approvalDepth -= 1
      this.inflightCancelId = null
      this.inflightSettle = null
    }
    const latencyMs = Date.now() - startedAt

    const outcome: ConfirmOutcome = !result.ok
      ? {
          kind: 'rejected',
          answererKind: 'agent',
          cause: result.cause,
          reason: { summary: result.summary ?? summaryFor(result.cause) }
        }
      : result.verdict.kind === 'approve'
        ? {
            kind: 'approved',
            answererKind: 'agent',
            cause: 'agent-approved',
            reason: result.verdict.reason
          }
        : {
            kind: 'rejected',
            answererKind: 'agent',
            cause: 'agent-deny',
            reason: result.verdict.reason
          }

    this.deps.audit?.record({
      ts: Date.now(),
      event: 'confirm.outcome',
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      requestId: this.deps.requestId,
      toolName: this.deps.toolName,
      outcome: outcome.kind === 'approved' ? 'approved' : 'rejected',
      cause: outcome.cause,
      actor: 'agent',
      actorRef: { profileId, invocationId },
      latencyMs
    })

    // I3：返回值不带 memory——即使内层实现错误地携带，写入断言（P0 第三道闸）也会拒绝
    return outcome
  }

  cancel(_requestId: string): void {
    // 中断内层审批调用（复用 Core 取消机制）并以 fail-closed 收敛本次确认
    if (this.inflightCancelId) signalChatCancel(this.inflightCancelId)
    this.inflightSettle?.({ ok: false, cause: 'unavailable', summary: '安全审批已被取消，已按拒绝处理。' })
  }
}
