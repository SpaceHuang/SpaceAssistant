import type {
  ApprovalCluePack,
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

/**
 * P1-4 修复：递归兜底以「审批会话」为作用域（同调用树语义），不再是全局计数——
 * 审批执行链（approvalAgent）创建内部会话后标记，收敛后解除；只有确认请求本身
 * 来自**进行中的审批内部会话**（即豁免失效、gate 守卫被绕过的场景）才算递归。
 * 不同会话/不同 lane 的并发审批互不影响，审计归因不再失真。
 */
const activeApprovalSessions = new Set<string>()

export function markApprovalSessionActive(sessionId: string): void {
  activeApprovalSessions.add(sessionId)
}

export function unmarkApprovalSessionActive(sessionId: string): void {
  activeApprovalSessions.delete(sessionId)
}

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

/** 从事实信号提取结构化线索（方案 §12-1：目标路径 / 命令 / URL），不给全量会话。 */
function deriveClueExtras(facts: ConfirmRequest['facts']): Partial<ApprovalCluePack> {
  const extras: Partial<ApprovalCluePack> = {}
  for (const s of facts.signals) {
    if (s.kind === 'path-target' && !extras.targetPath) extras.targetPath = s.path
    if (s.kind === 'command-sequence' && !extras.command && s.commands.length > 0) {
      const c = s.commands[0]!
      extras.command = [c.verb, ...c.args].join(' ')
      const files = s.commands.flatMap((cmd) => (cmd.redirectTarget ? [cmd.redirectTarget] : []))
      if (files.length > 0) extras.involvedFiles = files
    }
    if (s.kind === 'network-egress' && !extras.url && s.domains.length > 0) extras.url = s.domains[0]
  }
  return extras
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
      /** 已声明的任务（D，可信证据）：装配方从外层任务上下文透传；缺省 = 无任务上下文。 */
      taskDigest?: string
      audit?: AuditSink
      invokeApproval: (inv: ApprovalInvocation) => Promise<ApprovalInvocationResult>
      /** B1(偏差 23):统一准入门(嵌套:审批回答者继承等待方 interactive 优先级 + 保留位)。 */
      admissionGate?: import('../runtime/callAdmissionGate').CallAdmissionGate
    }
  ) {}

  async request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const profileId = this.deps.policy.approvalProfileId ?? 'approval-default'
    invocationSeq += 1
    const invocationId = `approval-${Date.now()}-${invocationSeq}`
    const innerRequestId = `${this.deps.requestId}:approval`

    // ===== I5 兜底：确认请求来自进行中的审批内部会话（豁免失效）→ 立即 fail-closed =====
    if (activeApprovalSessions.has(this.deps.sessionId)) {
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
      signals: req.facts.signals.map((s) => s.kind),
      ...deriveClueExtras(req.facts),
      ...(this.deps.taskDigest ? { taskDigest: this.deps.taskDigest } : {})
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
        // B1(偏差 23):嵌套准入——保留位防自锁(等待方持票,回答者凭 reserved 位准入);
        // lane 继承等待方(this.deps.lane,P1-3:硬编码 automation 会让所有 lane 的嵌套审批
        // 与管家任务抢 30/小时配额且保留位检错 lane);票据覆盖内层回合全程,
        // 拿不到准入位 = 「拿不到裁决」(cause=unavailable),与裁决为否(agent-deny)分立
        const settleWithRelease = (r: ApprovalInvocationResult): void => {
          if (admissionTicket) {
            admissionTicket.release()
            admissionTicket = null
          }
          finish(r)
        }
        let admissionTicket: import('../runtime/callAdmissionGate').AdmissionTicket | null = null
        if (this.deps.admissionGate) {
          this.deps.admissionGate
            .acquire({
              lane: this.deps.lane,
              priority: 'interactive',
              role: 'approval-answerer',
              disposition: 'reject',
              requestId: innerRequestId
            })
            .then(
              (admission) => {
                if (!admission.ok) {
                  finish({ ok: false, cause: 'unavailable' })
                  return
                }
                admissionTicket = admission.ticket
                this.deps
                  .invokeApproval(invocation)
                  .then(settleWithRelease, () => settleWithRelease({ ok: false, cause: 'unavailable' }))
              },
              () => finish({ ok: false, cause: 'unavailable' })
            )
        } else {
          this.deps
            .invokeApproval(invocation)
            .then((r) => finish(r), () => finish({ ok: false, cause: 'unavailable' }))
        }
        this.inflightSettle = (r) => finish(r)
      })
    } finally {
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
      // 中1（评审）：裁决依据落审计——summary 与证据规模（evidence 原文不落，仅计数）
      ...(outcome.reason ? { reasonSummary: outcome.reason.summary, evidenceCount: outcome.reason.evidence?.length ?? 0 } : {}),
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
