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
import { renderCommandSequence } from './extractors/commandSequenceExtractor'
import type { ApprovalAdmissionLike } from '../runtime/agentRuntime'

/** 审批调用默认超时上界（方案 §12-2 取值 30s）；req.timeoutMs / policy.timeoutMs 可覆盖，必须有上界。 */
export const DEFAULT_AGENT_APPROVAL_TIMEOUT_MS = 30_000

/** P1-E(c)：线索包 [命令] 字段最多列出的子命令条数（超出以总数标注，保持有界）。 */
export const CLUE_COMMAND_MAX = 5

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

/**
 * 从事实信号提取结构化线索（方案 §12-1：目标路径 / 命令 / URL），不给全量会话。
 * P1-E(c)（D7）：[命令] 覆盖全部子命令（前 N 条 + 总数标注，有界）——
 * 旧实现只取 commands[0]，真正触发 high 风险的后续子命令（如 whoami）不进线索包。
 */
export function deriveClueExtras(facts: ConfirmRequest['facts']): Partial<ApprovalCluePack> {
  const extras: Partial<ApprovalCluePack> = {}
  for (const s of facts.signals) {
    if (s.kind === 'path-target' && !extras.targetPath) extras.targetPath = s.path
    if (s.kind === 'command-sequence' && !extras.command && s.commands.length > 0) {
      const rendered = renderCommandSequence(
        s.commands.slice(0, CLUE_COMMAND_MAX).map((cmd) => ({
          text: [cmd.verb, ...cmd.args].join(' '),
          connector: cmd.connector
        }))
      )
      extras.command =
        s.commands.length > CLUE_COMMAND_MAX ? `${rendered} （共 ${s.commands.length} 条）` : rendered
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
  /** 每次 attempt 独立持有取消/收敛出口；禁止并发 request 互相覆盖。 */
  private readonly inflight = new Map<string, { settle: (r: ApprovalInvocationResult) => void; cancel: () => void }>()

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
      /** 新审批资源域；存在时不占用任务启动准入计数。 */
      approvalAdmission?: ApprovalAdmissionLike
      deadlineAt?: number
    }
  ) {}

  async request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const profileId = this.deps.policy.approvalProfileId ?? 'approval-default'
    invocationSeq += 1
    const invocationId = `approval-${Date.now()}-${invocationSeq}`
    // 每次 attempt 使用唯一内层 ID，避免同一 AgentChannel 的并发/迟到取消互相串扰。
    const innerRequestId = `${this.deps.requestId}:approval:${invocationId}`

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
    const parentRemainingMs = this.deps.deadlineAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, this.deps.deadlineAt - Date.now())
    const effectiveTimeoutMs = Math.min(req.timeoutMs ?? this.deps.policy.timeoutMs ?? DEFAULT_AGENT_APPROVAL_TIMEOUT_MS, parentRemainingMs)
    if (effectiveTimeoutMs <= 0) return {
      kind: 'rejected',
      answererKind: 'agent',
      cause: 'timeout',
      reason: { summary: '审批已超过父任务截止时间。' }
    }
    const invocation: ApprovalInvocation = {
      clue,
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      requestId: innerRequestId,
      invocationId,
      profileId,
      // P1-4 通道打通：req.timeoutMs 优先（决策层/回答者配置下发），缺省 30s 上界
      timeoutMs: effectiveTimeoutMs,
      ...(this.deps.deadlineAt !== undefined ? { deadlineAt: this.deps.deadlineAt } : {})
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
    let result: ApprovalInvocationResult
    try {
      // 有界性（I4）：invokeApproval 竞速超时上界——内层实现自身另有超时，这里是通道级兜底
      result = await new Promise<ApprovalInvocationResult>((resolve) => {
        let settled = false
        // 嵌套准入票据(若已取得):随 finish 统一释放——settled 守卫保证恰好一次,
        // 取消路径(inflightSettle → finish)与超时路径不再依赖内层 invokeApproval 的后续 settle
        let admissionTicket: import('../runtime/callAdmissionGate').AdmissionTicket | null = null
        let approvalRelease: (() => void) | null = null
        const cancelApprovalQueue = () => { this.deps.approvalAdmission?.cancel(innerRequestId) }
        const timer = setTimeout(() => {
          if (settled) return
          signalChatCancel(innerRequestId)
          finish({ ok: false, cause: 'timeout' })
        }, invocation.timeoutMs)
        const finish = (r: ApprovalInvocationResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          admissionTicket?.release()
          admissionTicket = null
          approvalRelease?.()
          approvalRelease = null
          cancelApprovalQueue()
          resolve(r)
        }
        // B1(偏差 23):嵌套准入——保留位防自锁(等待方持票,回答者凭 reserved 位准入);
        // lane 继承等待方(this.deps.lane,P1-3:硬编码 automation 会让所有 lane 的嵌套审批
        // 与管家任务抢 30/小时配额且保留位检错 lane);票据覆盖内层回合全程,
        // 拿不到准入位 = 「拿不到裁决」(cause=unavailable),与裁决为否(agent-deny)分立
        if (this.deps.approvalAdmission) {
          this.deps.approvalAdmission.acquire({
            requestId: innerRequestId,
            parentTaskId: this.deps.requestId,
            deadlineAt: startedAt + invocation.timeoutMs
          }).then((admission) => {
            if (admission.kind !== 'granted') {
              finish({ ok: false, cause: 'unavailable' })
              return
            }
            if (settled) {
              admission.release()
              return
            }
            approvalRelease = admission.release
            this.deps.invokeApproval(invocation).then(
              (r) => finish(r),
              () => finish({ ok: false, cause: 'unavailable' })
            )
          }, () => finish({ ok: false, cause: 'unavailable' }))
        } else if (this.deps.admissionGate) {
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
                // 超时/取消可能已先行结算；迟到票据必须立即归还，不能启动已结束的审批。
                if (settled) {
                  admission.ticket.release()
                  return
                }
                admissionTicket = admission.ticket
                this.deps
                  .invokeApproval(invocation)
                  .then(finish, () => finish({ ok: false, cause: 'unavailable' }))
              },
              () => finish({ ok: false, cause: 'unavailable' })
            )
        } else {
          this.deps
            .invokeApproval(invocation)
            .then((r) => finish(r), () => finish({ ok: false, cause: 'unavailable' }))
        }
        this.inflight.set(innerRequestId, { settle: finish, cancel: cancelApprovalQueue })
      })
    } finally {
      this.inflight.delete(innerRequestId)
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
    // 中断该 AgentChannel 的所有活动 attempt；每个 attempt 都有自己的 requestId。
    for (const [innerRequestId, entry] of this.inflight) {
      signalChatCancel(innerRequestId)
      entry.cancel()
      entry.settle({ ok: false, cause: 'unavailable', summary: '安全审批已被取消，已按拒绝处理。' })
    }
  }
}
