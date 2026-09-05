import type { CoordinatorHooks } from './toolInvocationCoordinator'

export type LegacyConfirmationOutcome = 'approved' | 'rejected' | 'timeout'
export type LegacyConfirmationRejectReason = 'user' | 'remote_read_only' | 'authorization_revoked'

export interface LegacyConfirmationSnapshot {
  outcome: LegacyConfirmationOutcome
  needsConfirm: boolean
  rejectReason?: LegacyConfirmationRejectReason
}

export interface CoordinatorConfirmationDecision {
  approved: boolean
  errorCode?: 'INVOCATION_NOT_CONFIRMED' | 'CONFIRM_TIMEOUT' | 'AUTHORIZATION_REVOKED' | 'REMOTE_READ_ONLY'
}

/** 将既有 toolChatLoop 确认结果收窄为 coordinator 可消费的合同，不重新推导授权。 */
export function mapLegacyConfirmation(snapshot: LegacyConfirmationSnapshot): CoordinatorConfirmationDecision {
  if (snapshot.outcome === 'approved') return { approved: true }
  if (snapshot.outcome === 'timeout') return { approved: false, errorCode: 'CONFIRM_TIMEOUT' }
  if (snapshot.rejectReason === 'authorization_revoked') {
    return { approved: false, errorCode: 'AUTHORIZATION_REVOKED' }
  }
  if (snapshot.rejectReason === 'remote_read_only') {
    return { approved: false, errorCode: 'REMOTE_READ_ONLY' }
  }
  return { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }
}

/** 仅适配已经完成确认的结果；Gate/确认请求本身仍由上层负责。 */
export function coordinatorConfirmHook(snapshot: LegacyConfirmationSnapshot): NonNullable<CoordinatorHooks['confirm']> {
  const decision = mapLegacyConfirmation(snapshot)
  return async () => decision.approved
}
