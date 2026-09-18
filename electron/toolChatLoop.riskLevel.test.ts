import { describe, expect, it } from 'vitest'
import { confirmRequestedRiskLevel } from './toolChatLoop'
import { DEFAULT_POLICY_RULES } from '../src/shared/policy/defaultRules'

describe('confirmRequestedRiskLevel（评审 v2 建议 7）', () => {
  const gate = (type: string, riskLevel?: 'low' | 'medium' | 'high') =>
    ({ decision: { type, ...(riskLevel ? { riskLevel } : {}) } }) as Parameters<typeof confirmRequestedRiskLevel>[0]

  it('browser 类 low 裁决 → 确认卡 medium（不低于旧硬编码兜底）', () => {
    expect(confirmRequestedRiskLevel(gate('require-confirm', 'low'))).toBe('medium')
  })

  it('toolkit act 类 high 裁决 → high（不降档）', () => {
    expect(confirmRequestedRiskLevel(gate('require-confirm', 'high'))).toBe('high')
  })

  it('medium 裁决 → medium', () => {
    expect(confirmRequestedRiskLevel(gate('require-confirm', 'medium'))).toBe('medium')
  })

  it('非 require-confirm 决策 → medium', () => {
    expect(confirmRequestedRiskLevel(gate('allow'))).toBe('medium')
    expect(confirmRequestedRiskLevel(gate('deny'))).toBe('medium')
  })
})

describe('confirmedByUser 纵深防御前提固化（评审 v2 建议 8）', () => {
  it('toolkit-act-ask 必须 locked 且无 askUnless（无记忆档位/auto-allow 路径）——act 能力恒经确认', () => {
    const rule = DEFAULT_POLICY_RULES.find((r) => r.id === 'toolkit-act-ask')
    expect(rule).toBeDefined()
    expect(rule!.action).toBe('ask')
    expect(rule!.locked).toBe(true)
    expect('askUnless' in rule! ? rule!.askUnless : undefined).toBeUndefined()
  })
})
