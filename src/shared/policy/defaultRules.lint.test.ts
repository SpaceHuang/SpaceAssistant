import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { resolvePolicyRules } from './policyPackages'
import type { PolicyRule } from '../confirmation/types'

/** 评审 B2 原则：凡是 allow / auto-evaluator 动作的规则必须带 lane 限定，防「恰好安全」漂移。 */
describe('defaultRules lane lint（偏差 22 防漂移）', () => {
  it('action ∈ {allow, auto-evaluator} 的规则都必须显式限定 match.lane', () => {
    const violations = DEFAULT_POLICY_RULES.filter(
      (rule) =>
        rule.when === 'invocation' &&
        (rule.action === 'allow' || rule.action === 'auto-evaluator') &&
        (!rule.match?.lane || rule.match.lane.length === 0)
    )
    expect(violations.map((r) => r.id)).toEqual([])
  })
})

describe('defaultRules denyClass 全量标注（R2 · O4 定案）', () => {
  it('会产 ask/deny 的规则必须声明 denyClass；allow/auto-evaluator 类不标', () => {
    const producing = DEFAULT_POLICY_RULES.filter((r) => r.action === 'ask' || r.action === 'deny')
    const missing = producing.filter((r) => !r.denyClass).map((r) => r.id)
    expect(missing).toEqual([])
    const mislabeled = DEFAULT_POLICY_RULES.filter(
      (r) => (r.action === 'allow' || r.action === 'auto-evaluator') && r.denyClass !== undefined
    ).map((r) => r.id)
    expect(mislabeled).toEqual([])
  })

  it('denyClass 取值闭合于三类', () => {
    for (const r of DEFAULT_POLICY_RULES) {
      if (r.denyClass !== undefined) {
        expect(['forbidden', 'insufficient-info', 'out-of-bounds']).toContain(r.denyClass)
      }
    }
  })

  it('deny 规则中「产品禁令」类标 forbidden；预算暂停类标 insufficient-info', () => {
    for (const id of ['script-network-deny-remote', 'remote-shell-disabled', 'im-no-wechat-send', 'ingress-direct-other-deny']) {
      expect(DEFAULT_POLICY_RULES.find((r) => r.id === id)?.denyClass).toBe('forbidden')
    }
    for (const id of ['remote-outbound-budget-pause-wechat', 'remote-outbound-budget-pause-lark']) {
      expect(DEFAULT_POLICY_RULES.find((r) => r.id === id)?.denyClass).toBe('insufficient-info')
    }
  })
})

describe('automation lane 显式规则集（偏差 21/22：反向证据翻转）', () => {
  it('存在以 automation 为 lane 的只读 allow 规则（read_file/list_directory/grep/list_work_dirs/history.read/skills.read/read_feishu_attachment）', () => {
    const rule = DEFAULT_POLICY_RULES.find((r) => r.id === 'automation-readonly-allow')
    expect(rule).toBeTruthy()
    expect(rule!.action).toBe('allow')
    expect(rule!.match?.lane).toContain('automation')
    const tools = rule!.match?.toolName
    const list = Array.isArray(tools) ? tools : tools ? [tools] : []
    for (const t of ['read_file', 'list_directory', 'grep', 'list_work_dirs', 'history.read', 'skills.read', 'read_feishu_attachment']) {
      expect(list).toContain(t)
    }
  })

  it('存在 automation 默认兜底 confirm 规则（catch-all ask，locked 防放宽）', () => {
    const rule = DEFAULT_POLICY_RULES.find((r) => r.id === 'automation-default-confirm')
    expect(rule).toBeTruthy()
    expect(rule!.action).toBe('ask')
    expect(rule!.locked).toBe(true)
    expect(rule!.match?.lane).toEqual(['automation'])
    // catch-all：不限定 toolName
    expect(rule!.match?.toolName).toBeUndefined()
  })

  it('resolvePolicyRules guard：automation lane 不得套用 loose 档（偏差 15 最小防护；S1 范围档语义）', () => {
    // 对照：user lane（desktop）loose 生效——清单内低风险域被 allow 范围条目取代
    const loosened = resolvePolicyRules({
      lane: 'desktop',
      packages: { desktop: 'loose' },
      rules: DEFAULT_POLICY_RULES
    })
    const loosenedScope = loosened.find((r) => r.id === 'scope-loose-mcp-tool-ask')
    expect(loosenedScope?.action).toBe('allow')

    // automation 伪造 loose：仅提供 standard，规则集恒等（M2 收敛）
    const automation = resolvePolicyRules({
      lane: 'automation',
      packages: { automation: 'loose' },
      rules: DEFAULT_POLICY_RULES
    })
    const automationAsk = automation.find((r) => r.id === 'im-write-ask')
    expect(automationAsk?.action).toBe('ask')
    expect(automation.find((r) => r.id.startsWith('scope-'))).toBeUndefined()
  })
})

describe('P2-8 desktop-only lint 收紧（评审 N6）', () => {
  it('auto-evaluator 动作规则的 lane 限定必须为 desktop-only（防无 lane 限定规则绕过 lane 矩阵）', () => {
    const violations = DEFAULT_POLICY_RULES.filter(
      (rule) => rule.when === 'invocation' && rule.action === 'auto-evaluator' && JSON.stringify(rule.match?.lane) !== JSON.stringify(['desktop'])
    )
    expect(violations.map((r) => `${r.id}:${JSON.stringify(r.match?.lane)}`)).toEqual([])
  })
})
