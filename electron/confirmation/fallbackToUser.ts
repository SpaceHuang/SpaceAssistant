/**
 * 桌面链路 fail-open-to-user：回退触发判定（desktop-fail-open-to-user-plan.md §4.4）。
 *
 * 完整判定式（实现层的唯一入口，§4 矩阵描述去向、本判定决定是否进入回退路径）：
 *
 *   可回退 = lane === 'desktop'                              // ① 链路：回退仅装配在桌面
 *     && channelOutcome.answererKind === 'agent'             // ② 来源：主回答者确为 agent（评审 v3 B1）
 *     && cause ∈ { unavailable, timeout }                    // ③ 类别：§4 矩阵可回退两格
 *     && !chatSignal.aborted                                 // ④ 中止守卫之一（评审 v3 B2）
 *     && !sharedApprovalRecoveryFailed                       // ④ 中止守卫之二
 *
 * 判定数据化（§4：判定表放在通道层，不放提示词、不进规则集）。
 * 判据：环境/运行时问题 → 转人工；产品契约 / 结构性问题 → 保持 deny；有效裁决 → 不回退。
 */
import type { ConfirmOutcome, ConfirmOutcomeCause, ExecutionLane } from '../../src/shared/confirmation/types'

/** §4 矩阵可回退两格：环境 / 运行时失败（unavailable=拿不到准入位或调用失败；timeout=超出审批上界）。 */
export const FALLBACK_ELIGIBLE_CAUSES = ['unavailable', 'timeout'] as const

export type FallbackEligibleCause = (typeof FALLBACK_ELIGIBLE_CAUSES)[number]

export function isFallbackEligibleCause(cause: ConfirmOutcomeCause): cause is FallbackEligibleCause {
  return (FALLBACK_ELIGIBLE_CAUSES as readonly string[]).includes(cause)
}

export interface FallbackDecisionInput {
  lane: ExecutionLane
  channelOutcome: ConfirmOutcome
  /**
   * 判定时刻的 chatSignal.aborted。回退判定位于主通道 request 之后，既有中止检查
   * 覆盖不到这个窗口：Skill v2.1 后用户点停止以 cause='cancelled' 结算（③ 已挡），
   * 但租约恢复失败路径 failApprovalGroup('unavailable') 的 settle 仍命中③——本守卫
   * 与 sharedApprovalRecoveryFailed 一起构成与结算值无关的显式中止防线。
   */
  chatAborted: boolean
  /** failApprovalGroup 首句置位，一个条件覆盖全部中止来源（用户取消 / 审批组失败 / 租约恢复失败）。 */
  sharedApprovalRecoveryFailed: boolean
}

export function shouldFallbackToUser(input: FallbackDecisionInput): boolean {
  if (input.lane !== 'desktop') return false
  const outcome = input.channelOutcome
  if (outcome.kind === 'approved-with-action') return false
  // ② 普通 ask 的 DesktopChannel outcome（经 mapToolOutcome）与 DenyChannel outcome 均不携带
  //    answererKind，只有 AgentChannel 恒携带 'agent'——普通 ask 卡超时不得再弹一张卡。
  if (outcome.answererKind !== 'agent') return false
  if (!isFallbackEligibleCause(outcome.cause)) return false
  if (input.chatAborted) return false
  if (input.sharedApprovalRecoveryFailed) return false
  return true
}
