import { describe, expect, it } from 'vitest'
import type {
  ContentFacts,
  DecisionCacheView,
  ExecutionContext,
  PolicyEngineDeps,
  PolicyRule
} from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { decide } from './policyEngine'
import { DEFAULT_FLOOR, isActionWider, validatePolicyRulesFloor } from './policyFloor'
import { LANE_PROFILES, resolvePolicyRules } from './policyPackages'

/**
 * S1（偏差 15 收口）：user lane 的 strict / loose 重定义为**范围档**——
 * 档位决定「哪些域落入确认范围」（显式 ScopeRule 清单取代目标条目），
 * 不再对任意条目做整体宽严变换；宽严下界由 locked 底线（policyFloor）钉死。
 */

function mkFacts(
  toolName: string,
  actionClass: ContentFacts['actionClass'],
  signals: ContentFacts['signals'],
  baseRiskLevel: ContentFacts['baseRiskLevel'] = 'medium'
): ContentFacts {
  return { toolName, actionClass, baseRiskLevel, signals, summary: { text: 'summary' } }
}

function mkContext(lane: ExecutionContext['lane']): ExecutionContext {
  return { lane, origin: { kind: 'direct-owner' }, sessionId: 's1' }
}

function deps(overrides: Partial<PolicyEngineDeps> = {}): PolicyEngineDeps {
  return {
    cache: { lookup: () => null } as DecisionCacheView,
    config: {},
    migrationComplete: false,
    ...overrides
  }
}

function byId(rules: readonly PolicyRule[]): Map<string, PolicyRule> {
  return new Map(rules.map((r) => [r.id, r]))
}

const USER_LANES = ['desktop', 'wechat', 'feishu'] as const

describe('S1 结构断言：全 lane 无宽严变换', () => {
  it('LANE_PROFILES 任何 lane 的 transforms 都不含 strict / loose 键', () => {
    for (const lane of Object.keys(LANE_PROFILES) as Array<keyof typeof LANE_PROFILES>) {
      expect(Object.keys(LANE_PROFILES[lane].transforms), lane).not.toContain('strict')
      expect(Object.keys(LANE_PROFILES[lane].transforms), lane).not.toContain('loose')
    }
  })

  it('范围条目数据 lint：action ∈ {ask, allow}、id 机械命名、supersedes 目标存在且非 locked、match.lane 收窄为本 lane', () => {
    for (const lane of USER_LANES) {
      const scopes = LANE_PROFILES[lane].scopePackages ?? {}
      for (const pkg of ['strict', 'loose'] as const) {
        for (const rule of scopes[pkg] ?? []) {
          const expectedId = `scope-${pkg}-${rule.supersedes}`
          expect(rule.id, `${lane}:${pkg}`).toBe(expectedId)
          expect(['ask', 'allow'], `${lane}:${pkg}:${rule.id}`).toContain(rule.action)
          const target = DEFAULT_POLICY_RULES.find((r) => r.id === rule.supersedes)
          expect(target, `supersedes 目标存在:${rule.supersedes}`).toBeDefined()
          expect(target?.locked, `supersedes 目标不得为 locked:${rule.supersedes}`).toBeFalsy()
          expect(rule.match?.lane, `${lane}:${pkg}:${rule.id} lane 收窄`).toEqual([lane])
          expect(rule.locked, '范围条目自身不得 locked').toBeFalsy()
        }
      }
    }
  })
})

describe('S1 desktop 范围档', () => {
  it('strict：非 locked 的 allow/auto-evaluator 域全部被 scope-strict-*（ask）取代；locked 条目引用原样', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: DEFAULT_POLICY_RULES })
    const outById = byId(out)
    const strictTargets = [
      'shell-precheck-auto-allow',
      'script-clean-allow-desktop',
      'browser-act-allow-unconfigured',
      'lark-read-allow',
      'toolkit-read-allow',
      'mcp-readonly-allow'
    ]
    for (const target of strictTargets) {
      expect(outById.has(target), `被取代:${target}`).toBe(false)
      const scope = outById.get(`scope-strict-${target}`)
      expect(scope, `范围条目存在:scope-strict-${target}`).toBeDefined()
      expect(scope?.action).toBe('ask')
    }
    for (const base of DEFAULT_POLICY_RULES.filter((r) => r.locked)) {
      expect(outById.get(base.id), `${base.id} 原样`).toBe(base)
    }
  })

  it('strict：清单外的 ask 条目原样（范围档不整体变换宽严）', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: DEFAULT_POLICY_RULES })
    const outById = byId(out)
    for (const id of ['script-network-ask-desktop', 'browser-act-danger-ask', 'lark-write-ask', 'mcp-tool-ask']) {
      expect(outById.get(id), `${id} 原样`).toBe(DEFAULT_POLICY_RULES.find((r) => r.id === id))
    }
  })

  it('loose：仅显式低风险域（browser-navigate / mcp-tool）被 scope-loose-*（allow）取代', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'loose' }, rules: DEFAULT_POLICY_RULES })
    const outById = byId(out)
    expect(outById.has('browser-navigate-ask-desktop')).toBe(false)
    expect(outById.has('mcp-tool-ask')).toBe(false)
    expect(outById.get('scope-loose-browser-navigate-ask-desktop')?.action).toBe('allow')
    expect(outById.get('scope-loose-mcp-tool-ask')?.action).toBe('allow')
    expect(outById.get('scope-loose-mcp-tool-ask')?.match?.lane).toEqual(['desktop'])
  })

  it('loose：清单外高危域不随档位放行（范围不调宽严）', () => {
    const out = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'loose' }, rules: DEFAULT_POLICY_RULES })
    const outById = byId(out)
    for (const id of ['script-network-ask-desktop', 'browser-act-danger-ask', 'browser-act-ask-desktop', 'lark-write-ask']) {
      expect(outById.get(id)?.action, `${id} 保持 ask`).toBe('ask')
    }
    // 自动审批器与 locked 条目不在 loose 范围清单内，原样保留
    expect(outById.get('shell-precheck-auto-allow')).toBe(DEFAULT_POLICY_RULES.find((r) => r.id === 'shell-precheck-auto-allow'))
  })
})

describe('S1 wechat / feishu 范围档', () => {
  it('wechat strict：browser-act-unconfigured 域被 ask 副本取代；lark 域不涉及', () => {
    const out = resolvePolicyRules({ lane: 'wechat', packages: { wechat: 'strict' }, rules: DEFAULT_POLICY_RULES })
    const outById = byId(out)
    expect(outById.has('browser-act-allow-unconfigured')).toBe(false)
    expect(outById.get('scope-strict-browser-act-allow-unconfigured')?.action).toBe('ask')
  })

  it('feishu strict：lark-read 与 browser-act-unconfigured 域被 ask 副本取代', () => {
    const out = resolvePolicyRules({ lane: 'feishu', packages: { feishu: 'strict' }, rules: DEFAULT_POLICY_RULES })
    const outById = byId(out)
    expect(outById.has('lark-read-allow')).toBe(false)
    expect(outById.get('scope-strict-lark-read-allow')?.action).toBe('ask')
    expect(outById.has('browser-act-allow-unconfigured')).toBe(false)
    expect(outById.get('scope-strict-browser-act-allow-unconfigured')?.action).toBe('ask')
  })

  it('wechat / feishu loose：仅 browser-navigate 域被 allow 副本取代；写域（lark-write / im-write）不放宽', () => {
    for (const lane of ['wechat', 'feishu'] as const) {
      const out = resolvePolicyRules({ lane, packages: { [lane]: 'loose' }, rules: DEFAULT_POLICY_RULES })
      const outById = byId(out)
      expect(outById.has('browser-navigate-ask-remote'), lane).toBe(false)
      expect(outById.get('scope-loose-browser-navigate-ask-remote')?.action).toBe('allow')
      expect(outById.get('lark-write-ask')?.action, `${lane}:lark-write-ask 保持 ask`).toBe('ask')
      expect(outById.get('im-write-ask')?.action, `${lane}:im-write-ask 保持 ask`).toBe('ask')
    }
  })
})

describe('S1 底线属性：任意 lane × 档位不放宽 locked 底线', () => {
  it('全组合产出过 validatePolicyRulesFloor；locked 条目动作不放宽、条件签名原样', () => {
    for (const lane of USER_LANES) {
      for (const pkg of ['strict', 'standard', 'loose', 'custom'] as const) {
        const out = resolvePolicyRules({ lane, packages: { [lane]: pkg }, rules: DEFAULT_POLICY_RULES })
        expect(validatePolicyRulesFloor(out), `${lane}:${pkg}`).toEqual({ ok: true })
        const outById = byId(out)
        for (const base of DEFAULT_FLOOR.filter((r) => r.locked)) {
          const incoming = outById.get(base.id)
          expect(incoming, `${lane}:${pkg}:${base.id} 存在`).toBeDefined()
          expect(isActionWider(incoming!.action, base.action), `${lane}:${pkg}:${base.id} 宽度不放宽`).toBe(false)
          expect(JSON.stringify({ when: incoming!.when, match: incoming!.match ?? null })).toBe(
            JSON.stringify({ when: base.when, match: base.match ?? null })
          )
        }
      }
    }
  })

  it('automation 仅有 standard：strict / loose 输入恒等（M2 收敛不变）', () => {
    for (const pkg of ['strict', 'loose'] as const) {
      const out = resolvePolicyRules({ lane: 'automation', packages: { automation: pkg }, rules: DEFAULT_POLICY_RULES })
      expect(out).toBe(DEFAULT_POLICY_RULES)
    }
  })
})

describe('S1 判定集合（diff 留档：strict 与原宽严档等价；loose 收窄为显式低风险清单）', () => {
  it('desktop strict：clean 脚本需确认（scope-strict 取代自动放行）', () => {
    const rules = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: DEFAULT_POLICY_RULES })
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('desktop'),
      rules,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('scope-strict-script-clean-allow-desktop')
  })

  it('desktop strict：MCP 只读注解调用需确认（scope-strict 取代 mcp-readonly-allow）', () => {
    const rules = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: DEFAULT_POLICY_RULES })
    const d = decide(
      mkFacts('mcp__srv__tool', 'read', [{ kind: 'mcp-readonly', serverId: 'srv', toolName: 'tool' }]),
      mkContext('desktop'),
      rules,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('scope-strict-mcp-readonly-allow')
  })

  it('desktop loose：打开网页免确认（范围条目）；网络脚本仍需确认（范围外不放宽）', () => {
    const rules = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'loose' }, rules: DEFAULT_POLICY_RULES })
    const nav = decide(
      mkFacts('browser', 'read', [{ kind: 'browser-action', action: 'navigate-open' }]),
      mkContext('desktop'),
      rules,
      deps()
    )
    expect(nav.type).toBe('auto-allow')
    expect(nav.type === 'auto-allow' && nav.ruleId).toBe('scope-loose-browser-navigate-ask-desktop')
    const script = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'script-network', patterns: [] }], 'high'),
      mkContext('desktop'),
      rules,
      deps()
    )
    expect(script.type).toBe('require-confirm')
    expect(script.type === 'require-confirm' && script.ruleId).toBe('script-network-ask-desktop')
  })

  it('desktop standard：clean 脚本仍自动放行（standard 行为不变）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('auto-allow')
  })
})
