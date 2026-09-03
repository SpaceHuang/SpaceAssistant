import { describe, expect, it } from 'vitest'
import type { PolicyRule } from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'
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

describe('auto-evaluator 规则的覆盖（确认模式并入规则列表）', () => {
  const AUTO_RULES = [
    {
      id: 'desktop-auto-approve',
      when: 'invocation' as const,
      match: { lane: ['desktop' as const], toolName: ['write_file', 'edit_file'] },
      action: 'auto-evaluator' as const,
      configRequires: { config: 'confirmMode', equals: 'auto' },
      reason: 'r'
    },
    { id: 'plain-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'r2' }
  ]

  it('默认动作为 auto-evaluator 的规则允许覆盖为 询问/允许/自动', () => {
    expect(validateRuleOverride(AUTO_RULES, 'desktop-auto-approve', 'ask').ok).toBe(true)
    expect(validateRuleOverride(AUTO_RULES, 'desktop-auto-approve', 'allow').ok).toBe(true)
    expect(validateRuleOverride(AUTO_RULES, 'desktop-auto-approve', 'auto-evaluator').ok).toBe(true)
    // 普通规则仍不允许覆盖成 auto-evaluator
    expect(validateRuleOverride(AUTO_RULES, 'plain-ask', 'auto-evaluator').ok).toBe(false)
  })

  it('覆盖后剥离条件门控（configRequires/askUnless/requiresContext），用户显式定死动作', () => {
    const out = resolvePolicyRules({
      lane: 'desktop',
      packages: { desktop: 'custom' },
      overrides: [{ ruleId: 'desktop-auto-approve', action: 'ask' }],
      rules: AUTO_RULES
    })
    const r = out.find((x) => x.id === 'desktop-auto-approve')!
    expect(r.action).toBe('ask')
    expect(r.configRequires).toBeUndefined()
  })

  it('覆盖为 auto-evaluator：保留评估器语义且不再受 confirmMode 门控', () => {
    const out = resolvePolicyRules({
      lane: 'desktop',
      packages: { desktop: 'custom' },
      overrides: [{ ruleId: 'desktop-auto-approve', action: 'auto-evaluator' }],
      rules: AUTO_RULES
    })
    const r = out.find((x) => x.id === 'desktop-auto-approve')!
    expect(r.action).toBe('auto-evaluator')
    expect(r.configRequires).toBeUndefined()
  })
})

describe('fail-closed 兜底规则必须 locked（评审中等项）', () => {
  const FAIL_CLOSED_IDS = ['lark-high-impact-ask', 'lark-unknown-ask', 'script-uncertified-ask-remote']

  it('三条 fail-closed ask 规则均标 locked', () => {
    for (const id of FAIL_CLOSED_IDS) {
      const rule = DEFAULT_POLICY_RULES.find((r) => r.id === id)
      expect(rule, id).toBeDefined()
      expect(rule!.locked, id).toBe(true)
    }
  })

  it('loose 套餐不得把 fail-closed ask 下调为 allow', () => {
    const out = resolvePolicyRules({
      lane: 'feishu',
      packages: { feishu: 'loose' },
      rules: DEFAULT_POLICY_RULES
    })
    for (const id of FAIL_CLOSED_IDS) {
      const rule = out.find((r) => r.id === id)
      expect(rule?.action, id).toBe('ask')
    }
  })

  it('locked 规则拒绝规则覆盖（validateRuleOverride）', () => {
    for (const id of FAIL_CLOSED_IDS) {
      expect(validateRuleOverride(DEFAULT_POLICY_RULES, id, 'allow').ok).toBe(false)
    }
  })
})
