import { describe, expect, it } from 'vitest'
import type {
  ContentFacts,
  DecisionCacheView,
  ExecutionContext,
  PolicyAction,
  PolicyEngineDeps,
  PolicyPackage,
  PolicyRule
} from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { decide } from './policyEngine'
import { LANE_PROFILES, effectiveActionFor, resolvePolicyRules } from './policyPackages'

/**
 * 桌面链路 ask 规则档位统一（docs/develop/desktop-ask-rule-tier-unification-plan.md v14）：
 * 按 ruleId 的档位动作覆盖（ruleActionOverrides）——基线动作 / transforms / scopePackages /
 * defaultRules.ts 全部零改动，仅 desktop × {standard, loose} 消费覆盖层。
 */

/** 合成兜底（applyDefault 产出，不在 DEFAULT_POLICY_RULES 内）。 */
const FALLBACK_ID = 'default-write-execute-ask'

/** §3 目标语义矩阵（desktop）：四档 × 5 规则。 */
const EXPECTED: Record<string, Record<PolicyPackage, PolicyAction>> = {
  'script-network-ask-desktop': { strict: 'ask', standard: 'auto-evaluator', loose: 'auto-evaluator', custom: 'ask' },
  'browser-act-danger-ask': { strict: 'ask', standard: 'auto-evaluator', loose: 'auto-evaluator', custom: 'ask' },
  'browser-act-ask-desktop': { strict: 'ask', standard: 'allow', loose: 'allow', custom: 'ask' },
  'lark-write-ask': { strict: 'ask', standard: 'auto-evaluator', loose: 'auto-evaluator', custom: 'ask' },
  [FALLBACK_ID]: { strict: 'ask', standard: 'auto-evaluator', loose: 'allow', custom: 'ask' }
}

const MATRIX_IDS = Object.keys(EXPECTED)

/** 与 toolCallGate 同源的引擎装配：deps.transform 绑定 lane + 档位。 */
function wiredDeps(lane: ExecutionContext['lane'], pkg: PolicyPackage, extra: Partial<PolicyEngineDeps> = {}): PolicyEngineDeps {
  return {
    cache: { lookup: () => null } as DecisionCacheView,
    config: {},
    migrationComplete: false,
    transform: (r) => effectiveActionFor(lane, pkg, r),
    ...extra
  }
}

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

describe('G2/G3/G4/G5：四档生效动作矩阵（effectiveActionFor，按 ruleId 覆盖）', () => {
  for (const id of MATRIX_IDS) {
    it(`${id}：strict/standard/loose/custom = ${MATRIX_IDS.map((k) => EXPECTED[id]![k as PolicyPackage]).join('/')}`, () => {
      for (const pkg of ['strict', 'standard', 'loose', 'custom'] as const) {
        const effective = effectiveActionFor('desktop', pkg, { id, action: 'ask' })
        expect(effective, `${id} × ${pkg}`).toBe(EXPECTED[id]![pkg])
      }
    })
  }

  it('locked / deny / confirm-every-time 豁免不受覆盖影响（isTransformExempt 优先）', () => {
    expect(effectiveActionFor('desktop', 'loose', { id: 'some-deny', action: 'deny' })).toBe('deny')
    expect(effectiveActionFor('desktop', 'loose', { id: 'some-locked', action: 'ask', locked: true })).toBe('ask')
    expect(
      effectiveActionFor('desktop', 'loose', { id: 'some-every', action: 'confirm-every-time' })
    ).toBe('confirm-every-time')
  })
})

describe('G4b/G3：decide() 集成（真实装配 transform = effectiveActionFor）', () => {
  it('desktop standard：一般浏览器 act 放行（browser-act-ask-desktop → allow）', () => {
    const d = decide(
      mkFacts('browser', 'execute', [{ kind: 'browser-action', action: 'act', dangerous: false }]),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      wiredDeps('desktop', 'standard')
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('browser-act-ask-desktop')
  })

  it('desktop loose：一般浏览器 act 放行；写/执行兜底放行（default-write-execute-ask → allow）', () => {
    const act = decide(
      mkFacts('browser', 'execute', [{ kind: 'browser-action', action: 'act', dangerous: false }]),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      wiredDeps('desktop', 'loose')
    )
    expect(act.type).toBe('auto-allow')
    expect(act.type === 'auto-allow' && act.ruleId).toBe('browser-act-ask-desktop')

    const fallback = decide(
      mkFacts('brand_new_tool', 'execute', []),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      wiredDeps('desktop', 'loose')
    )
    expect(fallback.type).toBe('auto-allow')
    expect(fallback.type === 'auto-allow' && fallback.ruleId).toBe(FALLBACK_ID)
  })

  it('desktop loose：段5 三条落机审（require-confirm answerer=agent，无快通道）', () => {
    const cases: Array<[string, ContentFacts]> = [
      ['script-network-ask-desktop', mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'script-network', patterns: [] }], 'high')],
      ['browser-act-danger-ask', mkFacts('browser', 'execute', [{ kind: 'browser-action', action: 'act', dangerous: true }], 'high')],
      ['lark-write-ask', mkFacts('run_lark_cli', 'write', [{ kind: 'lark-subcommand', impact: 'write' }])]
    ]
    for (const [ruleId, facts] of cases) {
      const d = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, wiredDeps('desktop', 'loose'))
      expect(d.type, ruleId).toBe('require-confirm')
      if (d.type === 'require-confirm') {
        expect(d.ruleId, ruleId).toBe(ruleId)
        expect(d.answerer, ruleId).toBe('agent')
      }
    }
  })

  it('G5：desktop strict 下五条目标全部保持真人（answerer=user）', () => {
    const factsList: ContentFacts[] = [
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'script-network', patterns: [] }], 'high'),
      mkFacts('browser', 'execute', [{ kind: 'browser-action', action: 'act', dangerous: false }]),
      mkFacts('run_lark_cli', 'write', [{ kind: 'lark-subcommand', impact: 'write' }]),
      mkFacts('brand_new_tool', 'execute', [])
    ]
    for (const facts of factsList) {
      const d = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, wiredDeps('desktop', 'strict'))
      expect(d.type).toBe('require-confirm')
      if (d.type === 'require-confirm') expect(d.answerer).toBe('user')
    }
  })

  it('G5c：desktop custom 下五条目标全部保持真人（B1 回归防护）', () => {
    const factsList: ContentFacts[] = [
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'script-network', patterns: [] }], 'high'),
      mkFacts('browser', 'execute', [{ kind: 'browser-action', action: 'act', dangerous: false }]),
      mkFacts('brand_new_tool', 'execute', [])
    ]
    for (const facts of factsList) {
      const d = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, wiredDeps('desktop', 'custom'))
      expect(d.type).toBe('require-confirm')
      if (d.type === 'require-confirm') expect(d.answerer).toBe('user')
    }
  })

  it('G6：extraction-failed 兜底恒为真人（M3 不变换例外，不登记覆盖层）', () => {
    const d = decide(
      mkFacts('write_file', 'write', [{ kind: 'extraction-failed', reason: '无法解析' }]),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      wiredDeps('desktop', 'loose')
    )
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') {
      expect(d.ruleId).toBe('default-extraction-failed')
      expect(d.answerer).toBe('user')
    }
  })
})

describe('合成兜底规则携带 id（applyDefault → deps.transform）', () => {
  it('transform 收到 { id: default-write-execute-ask }，按 id 覆盖可放行', () => {
    const seenIds: Array<string | undefined> = []
    const d = decide(
      mkFacts('brand_new_tool', 'execute', []),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      wiredDeps('desktop', 'standard', {
        transform: (r) => {
          seenIds.push(r.id)
          return r.id === FALLBACK_ID ? 'allow' : r.action
        }
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe(FALLBACK_ID)
    expect(seenIds).toContain(FALLBACK_ID)
  })
})

describe('G10：远程 lane 零变化（desktop-only 覆盖不外溢）', () => {
  it('wechat / feishu loose：远程可命中规则保持 ask（effectiveActionFor 层）', () => {
    // browser-act-danger-ask 无 lane 限定、lark-write-ask 含 feishu——两者远程可命中
    expect(effectiveActionFor('wechat', 'loose', { id: 'browser-act-danger-ask', action: 'ask' })).toBe('ask')
    expect(effectiveActionFor('feishu', 'loose', { id: 'lark-write-ask', action: 'ask' })).toBe('ask')
    // 合成兜底在远程同样恒等
    expect(effectiveActionFor('wechat', 'loose', { id: FALLBACK_ID, action: 'ask' })).toBe('ask')
    expect(effectiveActionFor('feishu', 'loose', { id: FALLBACK_ID, action: 'ask' })).toBe('ask')
  })

  it('wechat loose：未命中专门规则的 execute 调用仍落真人兜底（decide 层）', () => {
    const d = decide(
      mkFacts('brand_new_tool', 'execute', []),
      mkContext('wechat'),
      resolvePolicyRules({ lane: 'wechat', packages: { wechat: 'loose' }, rules: DEFAULT_POLICY_RULES }),
      wiredDeps('wechat', 'loose')
    )
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') {
      expect(d.ruleId).toBe(FALLBACK_ID)
      expect(d.answerer).toBe('user')
    }
  })
})

describe('G11：硬编码 lane 白名单防御（负向）', () => {
  it('即便人为给远程 profile 配 ruleActionOverrides，也不生效', () => {
    const wechatProfile = LANE_PROFILES.wechat as { ruleActionOverrides?: unknown }
    const feishuProfile = LANE_PROFILES.feishu as { ruleActionOverrides?: unknown }
    wechatProfile.ruleActionOverrides = { loose: { 'browser-act-danger-ask': 'allow', [FALLBACK_ID]: 'allow' } }
    feishuProfile.ruleActionOverrides = { loose: { 'lark-write-ask': 'allow' } }
    try {
      expect(effectiveActionFor('wechat', 'loose', { id: 'browser-act-danger-ask', action: 'ask' })).toBe('ask')
      expect(effectiveActionFor('wechat', 'loose', { id: FALLBACK_ID, action: 'ask' })).toBe('ask')
      expect(effectiveActionFor('feishu', 'loose', { id: 'lark-write-ask', action: 'ask' })).toBe('ask')
    } finally {
      delete wechatProfile.ruleActionOverrides
      delete feishuProfile.ruleActionOverrides
    }
  })
})

describe('G12：「loose 不得比 standard 严」守卫（Q9 选法 A，防未来漂移）', () => {
  /** 定义域：桌面可命中的非 locked ask 规则 = 数组内 6 条 + 合成兜底（v13 评审 D1）。 */
  const DOMAIN = [
    'script-network-ask-desktop',
    'browser-act-danger-ask',
    'browser-act-ask-desktop',
    'lark-write-ask',
    'browser-navigate-ask-desktop',
    'mcp-tool-ask',
    FALLBACK_ID
  ]

  it('standard 生效为 auto-evaluator 的规则，loose 生效须为 auto-evaluator 或 allow', () => {
    const standardResolved = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'standard' }, rules: DEFAULT_POLICY_RULES })
    const looseResolved = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'loose' }, rules: DEFAULT_POLICY_RULES })
    const looseById = new Map(looseResolved.map((r: PolicyRule) => [r.id, r]))
    for (const id of DOMAIN) {
      const standardEntry = standardResolved.find((r) => r.id === id)
      const standardEffective = standardEntry
        ? effectiveActionFor('desktop', 'standard', standardEntry)
        : effectiveActionFor('desktop', 'standard', { id, action: 'ask' })
      if (standardEffective !== 'auto-evaluator') continue
      // loose 侧：优先取同 id 解析条目；被 scope-loose-* 取代的规则（browser-navigate / mcp-tool）
      // 其取代条目本身即生效动作（scope 条目不参与档位变换）
      const looseEntry = looseById.get(id) ?? looseById.get(`scope-loose-${id}`)
      const looseEffective = looseEntry
        ? looseEntry.id.startsWith('scope-loose-')
          ? looseEntry.action
          : effectiveActionFor('desktop', 'loose', looseEntry)
        : effectiveActionFor('desktop', 'loose', { id, action: 'ask' })
      expect(['auto-evaluator', 'allow']).toContain(looseEffective)
      expect(looseEffective, `${id}：loose 不得比 standard 严`).not.toBe('ask')
    }
  })

  it('当前五条登记恰好覆盖矩阵要求（防漏登记的显式锚点）', () => {
    const overrides = LANE_PROFILES.desktop.ruleActionOverrides ?? {}
    expect(overrides.standard).toEqual({ 'browser-act-ask-desktop': 'allow' })
    expect(overrides.loose).toEqual({
      'script-network-ask-desktop': 'auto-evaluator',
      'browser-act-danger-ask': 'auto-evaluator',
      'browser-act-ask-desktop': 'allow',
      'lark-write-ask': 'auto-evaluator',
      [FALLBACK_ID]: 'allow'
    })
    // strict 不设：保持恒等 → 真人；custom 不可达（effectiveActionFor 提前恒等）
    expect(overrides.strict).toBeUndefined()
    expect(overrides.custom).toBeUndefined()
  })
})
