import type { CoordinatorHooks } from './toolInvocationCoordinator'

export type LegacyConfirmationOutcome = 'approved' | 'rejected' | 'timeout'

/**
 * P1-2 拒绝理由的来源形态（评审 N2 迁移）：
 *  - 'user'：用户意志拒绝（含桌面/IM 卡片拒绝与取消）
 *  - 'policy'：策略驱动的拒绝（原 remote_read_only / authorization_revoked，细分见 policyCode）
 *  - 'agent'：审批 Agent 裁决拒绝（P2 接线）
 *  - 'timeout' / 'no-answerer'：未拿到裁决的 fail-closed 路径
 */
export type LegacyConfirmationRejectReason = 'user' | 'policy' | 'agent' | 'timeout' | 'no-answerer'

/** rejectReason='policy' 时的细分来源（供既有 errorCode 与文案对照，迁移期不回归）。 */
export type LegacyPolicyCode = 'remote_read_only' | 'authorization_revoked'

export interface LegacyConfirmationSnapshot {
  outcome: LegacyConfirmationOutcome
  needsConfirm: boolean
  rejectReason?: LegacyConfirmationRejectReason
  policyCode?: LegacyPolicyCode
}

export interface CoordinatorConfirmationDecision {
  approved: boolean
  errorCode?: 'INVOCATION_NOT_CONFIRMED' | 'CONFIRM_TIMEOUT' | 'AUTHORIZATION_REVOKED' | 'REMOTE_READ_ONLY'
}

/** P1-2 旧值迁移映射（评审 N2）：'user'→'user'；'remote_read_only'/'authorization_revoked'→'policy'（策略驱动非用户意志）。 */
export function migrateLegacyRejectReason(
  legacy: 'user' | 'remote_read_only' | 'authorization_revoked'
): LegacyConfirmationRejectReason {
  if (legacy === 'user') return 'user'
  return 'policy'
}

/** 将既有 toolChatLoop 确认结果收窄为 coordinator 可消费的合同，不重新推导授权。 */
export function mapLegacyConfirmation(snapshot: LegacyConfirmationSnapshot): CoordinatorConfirmationDecision {
  if (snapshot.outcome === 'approved') return { approved: true }
  if (snapshot.outcome === 'timeout') return { approved: false, errorCode: 'CONFIRM_TIMEOUT' }
  if (snapshot.rejectReason === 'policy') {
    if (snapshot.policyCode === 'authorization_revoked') {
      return { approved: false, errorCode: 'AUTHORIZATION_REVOKED' }
    }
    if (snapshot.policyCode === 'remote_read_only') {
      return { approved: false, errorCode: 'REMOTE_READ_ONLY' }
    }
  }
  return { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }
}

/** 仅适配已经完成确认的结果；Gate/确认请求本身仍由上层负责。 */
export function coordinatorConfirmHook(snapshot: LegacyConfirmationSnapshot): NonNullable<CoordinatorHooks['confirm']> {
  const decision = mapLegacyConfirmation(snapshot)
  return async () => decision.approved
}
