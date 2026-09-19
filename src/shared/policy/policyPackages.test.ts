import { describe, expect, it } from 'vitest'
import type { PolicyRule } from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import {
  DEFAULT_POLICY_PACKAGES,
  effectiveActionFor,
  isPackageAvailableForLane,
  isPolicyPackage,
  normalizePolicyPackages,
  resolvePolicyRules,
  validateRuleOverride
} from './policyPackages'

const RULES: PolicyRule[] = [
  { id: 'locked-deny', when: 'invocation', action: 'deny', locked: true, reason: '底线' },
  { id: 'locked-ask', when: 'invocation', action: 'ask', locked: true, reason: '必须真人' },
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

  it('normalizePolicyPackages：automation 非法档位收敛为 standard（M2，仅提供 standard）', () => {
    expect(normalizePolicyPackages({ automation: 'loose' }).automation).toBe('standard')
    expect(normalizePolicyPackages({ automation: 'custom' }).automation).toBe('standard')
    expect(normalizePolicyPackages({ automation: 'strict' }).automation).toBe('standard')
  })

  it('isPolicyPackage 校验合法值', () => {
    expect(isPolicyPackage('strict')).toBe(true)
    expect(isPolicyPackage('custom')).toBe(true)
    expect(isPolicyPackage('')).toBe(false)
    expect(isPolicyPackage(1)).toBe(false)
  })

  it('恒等 lane 的 standard 返回原规则引用（零行为变化快路径）', () => {
    const out = resolvePolicyRules({ lane: 'wechat', rules: RULES })
    expect(out).toBe(RULES)
  })

  it('standard 恒等返回原引用（desktop 的「自动」映射在引擎产出层经 deps.transform 生效）', () => {
    // 规则集层不做 standard 变换：ask 条目提升到引擎第 4 步会破坏 mcp-readonly-allow 等顺序语义
    const out = resolvePolicyRules({ lane: 'desktop', rules: RULES })
    expect(out).toBe(RULES)
    expect(effectiveActionFor('desktop', 'standard', { action: 'ask' })).toBe('auto-evaluator')
  })

  it('desktop strict：非 locked 的 allow/auto-evaluator 上调为 ask，locked 不动', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: RULES })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['locked-ask', 'ask'],
      ['auto-1', 'ask'],
      ['ask-1', 'ask'],
      ['allow-1', 'ask']
    ])
  })

  it('desktop loose：非 locked 的 ask 下调为 allow，auto-evaluator 保持，locked 不动', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'loose' }, rules: RULES })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['locked-ask', 'ask'],
      ['auto-1', 'auto-evaluator'],
      ['ask-1', 'allow'],
      ['allow-1', 'allow']
    ])
  })

  it('wechat loose：非 locked 的 ask 下调为 allow（现状等价）', () => {
    const out = resolvePolicyRules({ lane: 'wechat', packages: { wechat: 'loose' }, rules: RULES })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['locked-ask', 'ask'],
      ['auto-1', 'auto-evaluator'],
      ['ask-1', 'allow'],
      ['allow-1', 'allow']
    ])
  })

  it('automation 伪造档位（loose/strict/custom）一律按 standard 恒等（M2 运行时防护）', () => {
    for (const pkg of ['loose', 'strict', 'custom'] as const) {
      const out = resolvePolicyRules({ lane: 'automation', packages: { automation: pkg }, rules: RULES })
      expect(out.map((r) => r.action)).toEqual(RULES.map((r) => r.action))
    }
  })

  it('custom 套餐：应用动作覆盖；locked 与未知 id 被忽略；wechat 拒绝 auto-evaluator 覆盖（B2 引擎层）', () => {
    const out = resolvePolicyRules({
      lane: 'feishu',
      packages: { feishu: 'custom' },
      overrides: [
        { ruleId: 'ask-1', action: 'allow' },
        { ruleId: 'allow-1', action: 'auto-evaluator' },
        { ruleId: 'locked-deny', action: 'allow' },
        { ruleId: 'nope', action: 'deny' }
      ],
      rules: RULES
    })
    expect(out.map((r) => [r.id, r.action])).toEqual([
      ['locked-deny', 'deny'],
      ['locked-ask', 'ask'],
      ['auto-1', 'auto-evaluator'],
      ['ask-1', 'allow'],
      // allow-1 的 auto-evaluator 覆盖不在 feishu 动作域内 → 丢弃（fail-closed）
      ['allow-1', 'allow']
    ])
  })

  it('desktop custom：auto-evaluator 在动作域内，覆盖生效（B2）', () => {
    const out = resolvePolicyRules({
      lane: 'desktop',
      packages: { desktop: 'custom' },
      overrides: [{ ruleId: 'allow-1', action: 'auto-evaluator' }],
      rules: RULES
    })
    expect(out.find((r) => r.id === 'allow-1')?.action).toBe('auto-evaluator')
  })

  it('validateRuleOverride：locked 不可改、未知规则拒绝；动作域按 lane（B2）', () => {
    expect(validateRuleOverride(RULES, 'locked-deny', 'allow').ok).toBe(false)
    expect(validateRuleOverride(RULES, 'missing', 'ask').ok).toBe(false)
    // wechat/feishu 拒绝 auto-evaluator（3 态）；desktop 接受（4 态）
    expect(validateRuleOverride(RULES, 'ask-1', 'auto-evaluator', 'wechat').ok).toBe(false)
    expect(validateRuleOverride(RULES, 'ask-1', 'auto-evaluator', 'feishu').ok).toBe(false)
    expect(validateRuleOverride(RULES, 'ask-1', 'auto-evaluator', 'desktop').ok).toBe(true)
    // 未带 lane：按最严格 3 态（fail-closed）
    expect(validateRuleOverride(RULES, 'ask-1', 'auto-evaluator').ok).toBe(false)
    const ok = validateRuleOverride(RULES, 'ask-1', 'allow', 'wechat')
    expect(ok.ok).toBe(true)
  })

  it('isPackageAvailableForLane：automation 仅 standard；其余 lane 四档全开（§2.1）', () => {
    expect(isPackageAvailableForLane('automation', 'standard')).toBe(true)
    expect(isPackageAvailableForLane('automation', 'loose')).toBe(false)
    expect(isPackageAvailableForLane('automation', 'custom')).toBe(false)
    expect(isPackageAvailableForLane('desktop', 'loose')).toBe(true)
    expect(isPackageAvailableForLane('wechat', 'custom')).toBe(true)
  })
})

describe('auto-evaluator 基线规则的覆盖（shell-precheck-auto-allow）', () => {
  const AUTO_RULES: PolicyRule[] = [
    {
      id: 'shell-precheck-auto-allow',
      when: 'invocation',
      match: { lane: ['desktop'], toolName: 'run_shell' },
      action: 'auto-evaluator',
      reason: 'shell 预检'
    },
    { id: 'plain-ask', when: 'invocation', action: 'ask', reason: 'r2' }
  ]

  it('auto-evaluator 基线规则的覆盖按 lane 动作域校验（desktop 4 态）', () => {
    expect(validateRuleOverride(AUTO_RULES, 'shell-precheck-auto-allow', 'ask', 'desktop').ok).toBe(true)
    expect(validateRuleOverride(AUTO_RULES, 'shell-precheck-auto-allow', 'allow', 'desktop').ok).toBe(true)
    expect(validateRuleOverride(AUTO_RULES, 'shell-precheck-auto-allow', 'auto-evaluator', 'desktop').ok).toBe(true)
    // wechat 即使对该规则也拒绝 auto-evaluator（3 态动作域，B2）
    expect(validateRuleOverride(AUTO_RULES, 'shell-precheck-auto-allow', 'auto-evaluator', 'wechat').ok).toBe(false)
  })

  it('覆盖后剥离条件门控（configRequires/askUnless/requiresContext），用户显式定死动作', () => {
    const gated: PolicyRule[] = [{ ...AUTO_RULES[0]!, configRequires: { config: 'someFlag', equals: true } }]
    const out = resolvePolicyRules({
      lane: 'desktop',
      packages: { desktop: 'custom' },
      overrides: [{ ruleId: 'shell-precheck-auto-allow', action: 'ask' }],
      rules: gated
    })
    const r = out.find((x) => x.id === 'shell-precheck-auto-allow')!
    expect(r.action).toBe('ask')
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

describe('B1：desktop standard 下 locked ask 保持人工（不交 Agent 裁决）', () => {
  const LOCKED_DESKTOP_ASKS = ['toolkit-act-ask', 'lark-high-impact-ask', 'lark-unknown-ask']

  it('三条 locked ask 在 desktop standard 下动作仍为 ask', () => {
    const out = resolvePolicyRules({ lane: 'desktop', rules: DEFAULT_POLICY_RULES })
    for (const id of LOCKED_DESKTOP_ASKS) {
      expect(out.find((r) => r.id === id)?.action, id).toBe('ask')
    }
  })

  it('desktop strict/loose 下 locked ask 同样不变换', () => {
    for (const pkg of ['strict', 'loose'] as const) {
      const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: pkg }, rules: DEFAULT_POLICY_RULES })
      for (const id of LOCKED_DESKTOP_ASKS) {
        expect(out.find((r) => r.id === id)?.action, `${pkg}:${id}`).toBe('ask')
      }
    }
  })
})

describe('standard 规则集恒等（两端共用变换表经 effectiveActionFor 供显示/引擎产出层）', () => {
  it('desktop standard 规则集原样返回；wechat 同为原引用（零行为变化）', () => {
    expect(resolvePolicyRules({ lane: 'desktop', rules: DEFAULT_POLICY_RULES })).toBe(DEFAULT_POLICY_RULES)
    expect(resolvePolicyRules({ lane: 'wechat', rules: DEFAULT_POLICY_RULES })).toBe(DEFAULT_POLICY_RULES)
    // 生效动作（显示=实际）经 effectiveActionFor：desktop 询问行显示「自动」
    expect(effectiveActionFor('desktop', 'standard', { action: 'ask' })).toBe('auto-evaluator')
    expect(effectiveActionFor('wechat', 'standard', { action: 'ask' })).toBe('ask')
  })

  it('shell-precheck-auto-allow 保持 auto-evaluator（desktop standard「自动」内建快通道路径）', () => {
    const out = resolvePolicyRules({ lane: 'desktop', rules: DEFAULT_POLICY_RULES })
    expect(out.find((r) => r.id === 'shell-precheck-auto-allow')?.action).toBe('auto-evaluator')
  })
})

