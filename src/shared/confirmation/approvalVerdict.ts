import type { ApprovalAuthorizationDimension, ApprovalRiskDimension } from './types'

/**
 * Skill v2 双维裁决的阈值矩阵（对比分析 docs/analysis/codex-guardian-vs-security-approval-comparison.md
 * §4-A，Guardian policy.md Outcome Policy 对齐）。纯函数、无 I/O：解析器（electron/confirmation/
 * approvalAgent.ts parseApprovalVerdict）用它对 approve 结论做降级校验。
 */

export const APPROVAL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const

export const APPROVAL_AUTHORIZATION_LEVELS = ['unknown', 'low', 'medium', 'high'] as const

const AUTHORIZATION_RANK: Record<ApprovalAuthorizationDimension, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3
}

export function authorizationRank(authorization: ApprovalAuthorizationDimension): number {
  return AUTHORIZATION_RANK[authorization]
}

/**
 * 授权上限截断：automation 无人场景 cap='low'（真实人类授权信号仅 P3 桌面档位启用），
 * 即使裁决模型自报 medium/high 也被压回上限——提示词条款 + 代码强制双重防线。
 */
export function capAuthorization(
  authorization: ApprovalAuthorizationDimension,
  max: ApprovalAuthorizationDimension
): ApprovalAuthorizationDimension {
  return AUTHORIZATION_RANK[authorization] <= AUTHORIZATION_RANK[max] ? authorization : max
}

/**
 * 阈值矩阵：
 * - critical → deny（无条件，任何授权不可覆盖）；
 * - high → 仅 authorization ≥ medium 放行；
 * - low / medium → approve。
 * 只用于对 approve 结论做降级校验（fail-closed 单向）：deny 结论不进矩阵，永不被升级。
 */
export function deriveApprovalOutcome(
  risk: ApprovalRiskDimension,
  authorization: ApprovalAuthorizationDimension
): 'approve' | 'deny' {
  if (risk === 'critical') return 'deny'
  if (risk === 'high') {
    return AUTHORIZATION_RANK[authorization] >= AUTHORIZATION_RANK.medium ? 'approve' : 'deny'
  }
  return 'approve'
}
