import { describe, expect, it } from 'vitest'
import type { PolicyRule } from '../confirmation/types'
import {
  DEFAULT_POLICY_PACKAGES,
  isPolicyPackage,
  normalizePolicyPackages,
  resolvePolicyRules,
  validateRuleOverride
} from './policyPackages'

const RULES: PolicyRule[] = [
  { id: 'locked-deny', when: 'invocation', action: 'deny', locked: true, reason: '底线' },
  { id: 'auto-1', when: 'invocation', action: 'auto-evaluator', reason: '自动审批' },
  { id: 'ask-1', when: 'invocation', action: 'ask', reason: '询问' },
  { id: 'allow-1', when: 'invocation', action: 'allow', reason: '放行' }
]

describe('policyPackages（§4 第 1 区 套餐解析）', () => {
  it('normalizePolicyPackages：缺省/损坏输入回退全 standard', () => {
    expect(normalizePolicyPackages(null)).toEqual(DEFAULT_POLICY_PACKAGES)
    expect(normalizePolicyPackages('bad')).toEqual(DEFAULT_POLICY_PACKAGES)
    expect(normalizePolicyPackages({ desktop: 'strict', wechat: 'bogus' })).toEqual({
      ...DEFAULT_POLICY_PACKAGES,
      desktop: 'strict'
    })
  })

  it('isPolicyPackage 校验合法值', () => {
    expect(isPolicyPackage('strict')).toBe(true)
    expect(isPolicyPackage('custom')).toBe(true)
    expect(isPolicyPackage('')).toBe(false)
    expect(isPolicyPackage(1)).toBe(false)
  })

  it('standard 套餐返回原规则引用（零行为变化快路径）', () => {
    const out = resolvePolicyRules({ lane: 'desktop', rules: RULES })
    expect(out).toBe(RULES)
  })

  it('strict 套餐：非 locked 的 allow/auto-evaluator 上调为 ask，locked 不动', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: RULES })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['auto-1', 'ask'],
      ['ask-1', 'ask'],
      ['allow-1', 'ask']
    ])
    // 不改原数组
    expect(RULES[3]!.action).toBe('allow')
  })

  it('loose 套餐：非 locked 的 ask 下调为 allow，locked 与 deny 不动', () => {
    const out = resolvePolicyRules({ lane: 'wechat', packages: { wechat: 'loose' }, rules: RULES })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['auto-1', 'auto-evaluator'],
      ['ask-1', 'allow'],
      ['allow-1', 'allow']
    ])
  })

  it('custom 套餐：应用动作覆盖；locked 与未知 id 被忽略', () => {
    const out = resolvePolicyRules({
      lane: 'feishu',
      packages: { feishu: 'custom' },
      overrides: [
        { ruleId: 'ask-1', action: 'allow' },
        { ruleId: 'locked-deny', action: 'allow' },
        { ruleId: 'nope', action: 'deny' }
      ],
      rules: RULES
    })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['auto-1', 'auto-evaluator'],
      ['ask-1', 'allow'],
      ['allow-1', 'allow']
    ])
  })

  it('validateRuleOverride：locked 不可改、未知规则拒绝、动作限定 deny/allow/ask', () => {
    expect(validateRuleOverride(RULES, 'locked-deny', 'allow').ok).toBe(false)
    expect(validateRuleOverride(RULES, 'missing', 'ask').ok).toBe(false)
    expect(validateRuleOverride(RULES, 'ask-1', 'auto-evaluator').ok).toBe(false)
    const ok = validateRuleOverride(RULES, 'ask-1', 'allow')
    expect(ok.ok).toBe(true)
  })
})
