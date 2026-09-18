import { describe, expect, it } from 'vitest'
import {
  APPROVAL_AUTHORIZATION_LEVELS,
  APPROVAL_RISK_LEVELS,
  deriveApprovalOutcome
} from './approvalVerdict'
import type { ApprovalAuthorizationDimension, ApprovalRiskDimension } from './types'

/**
 * 阈值矩阵逐格期望表（对比分析 §4-A，Guardian policy.md Outcome Policy 对齐）：
 * - critical → 无条件 deny；
 * - high → 仅 authorization ≥ medium 放行；
 * - low / medium → approve。
 */
const MATRIX: Record<ApprovalRiskDimension, Record<ApprovalAuthorizationDimension, 'approve' | 'deny'>> = {
  low: { unknown: 'approve', low: 'approve', medium: 'approve', high: 'approve' },
  medium: { unknown: 'approve', low: 'approve', medium: 'approve', high: 'approve' },
  high: { unknown: 'deny', low: 'deny', medium: 'approve', high: 'approve' },
  critical: { unknown: 'deny', low: 'deny', medium: 'deny', high: 'deny' }
}

describe('deriveApprovalOutcome（Skill v2 阈值矩阵）', () => {
  it('维度枚举完整：4 风险 × 4 授权', () => {
    expect([...APPROVAL_RISK_LEVELS]).toEqual(['low', 'medium', 'high', 'critical'])
    expect([...APPROVAL_AUTHORIZATION_LEVELS]).toEqual(['unknown', 'low', 'medium', 'high'])
  })

  for (const risk of APPROVAL_RISK_LEVELS) {
    for (const auth of APPROVAL_AUTHORIZATION_LEVELS) {
      it(`矩阵[${risk} × ${auth}] → ${MATRIX[risk][auth]}`, () => {
        expect(deriveApprovalOutcome(risk, auth)).toBe(MATRIX[risk][auth])
      })
    }
  }
})
