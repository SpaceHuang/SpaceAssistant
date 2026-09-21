import type { ExecutionLane, PolicyAction, PolicyRule } from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'

/**
 * 策略套餐（顶层设计 §4 第 1 区 / §5）：每条链路选择 严格/标准/宽松/自定义 之一。
 * - standard：内置默认规则原样生效（desktop 的「自动」ask→auto-evaluator 由引擎产出层解释）；
 * - strict / loose（S1，偏差 15 收口）：**范围档**——档位决定「哪些域落入确认范围」，
 *   以显式 ScopeRule 清单取代目标条目（机械命名 scope-<档>-<目标 id>），不对任意条目做整体宽严变换；
 *   strict = 全部非 locked 自动放行域纳入确认范围；loose = 显式低风险域移出确认范围（清单外一律 standard）；
 * - custom：应用用户在 policy_rules 表中的规则覆盖（仅动作/参数，规则不可增删、顺序不可改）。
 *
 * locked 条目在任何套餐下都不可被调松/改写（系统保护底线，policyFloor 校验兜底）。
 */

/** 范围条目（S1）：取代 supersedes 指向的默认条目（仅本档生效集内），其余字段为完整 PolicyRule。 */
export interface ScopeRule extends PolicyRule {
  /** 被本范围条目取代的默认条目 id（目标必须存在且非 locked）。 */
  supersedes: string
}
export type PolicyPackage = 'strict' | 'standard' | 'loose' | 'custom'

export type PolicyPackageMap = Record<ExecutionLane, PolicyPackage>

export const DEFAULT_POLICY_PACKAGES: PolicyPackageMap = {
  desktop: 'standard',
  wechat: 'standard',
  feishu: 'standard',
  automation: 'standard'
}

const VALID_PACKAGES: readonly PolicyPackage[] = ['strict', 'standard', 'loose', 'custom']

export function isPolicyPackage(value: unknown): value is PolicyPackage {
  return typeof value === 'string' && (VALID_PACKAGES as string[]).includes(value)
}

/** 从持久化 JSON（可能残缺/损坏）解析套餐映射，缺省链路回退 standard；
 * 档位不在本链路 availablePackages 内（如 automation 伪造 loose/custom）一律收敛 standard（M2 运行时防护）。 */
export function normalizePolicyPackages(raw: unknown): PolicyPackageMap {
  const out: PolicyPackageMap = { ...DEFAULT_POLICY_PACKAGES }
  if (!raw || typeof raw !== 'object') return out
  for (const lane of ['desktop', 'wechat', 'feishu', 'automation'] as const) {
    const v = (raw as Record<string, unknown>)[lane]
    if (isPolicyPackage(v) && LANE_PROFILES[lane].availablePackages.includes(v)) out[lane] = v
  }
  return out
}

/** 规则覆盖（与 electron PolicyRuleStore 行结构对齐；参数保留，引擎本期只消费动作）。 */
export interface PolicyRuleOverrideInput {
  ruleId: string
  action: PolicyAction
  params?: Record<string, unknown>
}

/**
 * 链路档位档案（§2.1）：档位不是跨链路共享的全局枚举——每条链路自带「提供哪几档 +
 * 可编辑动作域 + 每档动作变换」，跨链路不对齐；同名档位在不同链路是不同的东西。
 * 变换表放 src/shared 两端同源（显示=实际，§9 风险表）。
 */
export interface LaneProfile {
  /** 本链路提供的档位（不在集合内的档位按 standard 收敛，见 M2 运行时防护）。 */
  availablePackages: readonly PolicyPackage[]
  /** 用户是否可在设置页选择档位（automation 不展示）。 */
  userSelectable: boolean
  /** custom 档可编辑动作域（B2）：auto-evaluator 仅 desktop 可用。 */
  availableActions: readonly PolicyAction[]
  /**
   * 档位 → 基线动作 → 生效动作映射（仅声明清单，未列出即恒等）。
   * S1（偏差 15）：仅保留 standard 的 desktop「自动」映射（路径选择，非宽严）；
   * strict / loose 已范围化（scopePackages），不再做宽严变换。
   * custom 档是用户显式覆盖，不经变换表改写。
   */
  transforms: Partial<Record<'strict' | 'standard' | 'loose', Partial<Record<PolicyAction, PolicyAction>>>>
  /**
   * 范围档条目清单（S1，偏差 15）：strict / loose 的域覆盖面显式数据化。
   * 条目经 resolvePolicyRules 取代 supersedes 目标注入本档生效集；
   * 目标不存在于传入规则集时不注入（合成规则集恒等）。
   */
  scopePackages?: Partial<Record<'strict' | 'loose', readonly ScopeRule[]>>
}

/**
 * 桌面（决策 7/8）：standard 非 locked `ask → auto-evaluator`（=「自动」：快通道 + 审批 Agent）。
 * S1：strict / loose 宽严映射移除（范围化，见 DESKTOP_SCOPE_PACKAGES）。
 */
const DESKTOP_TRANSFORMS: LaneProfile['transforms'] = {
  standard: { ask: 'auto-evaluator' }
}

/** wechat/feishu：恒等（S1：strict / loose 宽严映射移除，范围化见各 lane scope 清单）。 */
const IM_TRANSFORMS: LaneProfile['transforms'] = {}

/**
 * 范围条目构造（S1）：从默认规则派生本档副本——机械命名 scope-<档>-<目标 id>、
 * match.lane 收窄为本 lane、locked 强制 false。
 * strict（收紧）保留目标条目的确认条件门控（askUnless/configRequires/requiresContext）——
 * 收紧不越过用户显式配置；loose（放行）剥离门控——「何时确认」条件不约束档位显式放行。
 */
function scopeVariant(
  lane: ExecutionLane,
  pkg: 'strict' | 'loose',
  supersedesId: string,
  action: PolicyAction,
  reason: string
): ScopeRule {
  const base = DEFAULT_POLICY_RULES.find((r) => r.id === supersedesId)
  if (!base) throw new Error(`scope supersedes target not found: ${supersedesId}`)
  const { askUnless: _a, configRequires: _c, requiresContext: _r, ...ungated } = base
  return {
    ...(pkg === 'strict' ? base : ungated),
    id: `scope-${pkg}-${supersedesId}`,
    action,
    locked: false,
    reason,
    match: { ...base.match, lane: [lane] },
    supersedes: supersedesId
  }
}

/**
 * desktop 范围档（S1）：strict = 全部非 locked 自动放行域（预检快通道 / clean 脚本 / act 免确认开关 /
 * lark 读 / toolkit 读 / MCP 只读）纳入确认范围——判定集合与原宽严档等价；
 * loose = 显式低风险域（打开网页 / MCP 工具调用）移出确认范围——较原全域 ask→allow 收窄（偏差 15 预期收紧）。
 */
const DESKTOP_SCOPE_PACKAGES: LaneProfile['scopePackages'] = {
  strict: [
    scopeVariant('desktop', 'strict', 'shell-precheck-auto-allow', 'ask', 'strict 范围档：shell 预检快通道纳入确认范围'),
    scopeVariant('desktop', 'strict', 'script-clean-allow-desktop', 'ask', 'strict 范围档：clean 脚本免确认纳入确认范围'),
    scopeVariant('desktop', 'strict', 'browser-act-allow-unconfigured', 'ask', 'strict 范围档：浏览器 act 免确认开关域纳入确认范围'),
    scopeVariant('desktop', 'strict', 'lark-read-allow', 'ask', 'strict 范围档：lark 读类免确认纳入确认范围'),
    scopeVariant('desktop', 'strict', 'toolkit-read-allow', 'ask', 'strict 范围档：能力集合只读免确认纳入确认范围'),
    scopeVariant('desktop', 'strict', 'mcp-readonly-allow', 'ask', 'strict 范围档：MCP 只读注解免确认纳入确认范围')
  ],
  loose: [
    scopeVariant('desktop', 'loose', 'browser-navigate-ask-desktop', 'allow', 'loose 范围档：打开网页属低风险域，移出确认范围'),
    scopeVariant('desktop', 'loose', 'mcp-tool-ask', 'allow', 'loose 范围档：MCP 工具调用属显式放行域，移出确认范围')
  ]
}

/** wechat 范围档（S1）：远程链路保守——strict 只收 act 免确认开关域；loose 只放行打开网页。 */
const WECHAT_SCOPE_PACKAGES: LaneProfile['scopePackages'] = {
  strict: [
    scopeVariant('wechat', 'strict', 'browser-act-allow-unconfigured', 'ask', 'strict 范围档：浏览器 act 免确认开关域纳入确认范围')
  ],
  loose: [
    scopeVariant('wechat', 'loose', 'browser-navigate-ask-remote', 'allow', 'loose 范围档：远程打开网页属低风险域，移出确认范围')
  ]
}

/** feishu 范围档（S1）：在 wechat 基础上 strict 额外收 lark 读类域。 */
const FEISHU_SCOPE_PACKAGES: LaneProfile['scopePackages'] = {
  strict: [
    scopeVariant('feishu', 'strict', 'lark-read-allow', 'ask', 'strict 范围档：lark 读类免确认纳入确认范围'),
    scopeVariant('feishu', 'strict', 'browser-act-allow-unconfigured', 'ask', 'strict 范围档：浏览器 act 免确认开关域纳入确认范围')
  ],
  loose: [
    scopeVariant('feishu', 'loose', 'browser-navigate-ask-remote', 'allow', 'loose 范围档：远程打开网页属低风险域，移出确认范围')
  ]
}

export const LANE_PROFILES: Record<ExecutionLane, LaneProfile> = {
  desktop: {
    availablePackages: ['strict', 'standard', 'loose', 'custom'],
    userSelectable: true,
    availableActions: ['deny', 'allow', 'ask', 'auto-evaluator'],
    transforms: DESKTOP_TRANSFORMS,
    scopePackages: DESKTOP_SCOPE_PACKAGES
  },
  wechat: {
    availablePackages: ['strict', 'standard', 'loose', 'custom'],
    userSelectable: true,
    availableActions: ['deny', 'allow', 'ask'],
    transforms: IM_TRANSFORMS,
    scopePackages: WECHAT_SCOPE_PACKAGES
  },
  feishu: {
    availablePackages: ['strict', 'standard', 'loose', 'custom'],
    userSelectable: true,
    availableActions: ['deny', 'allow', 'ask'],
    transforms: IM_TRANSFORMS,
    scopePackages: FEISHU_SCOPE_PACKAGES
  },
  // automation：仅 standard、不可用户选、无可编辑档（其唯一 ask 为 locked；回答者=agent 由 lane 派生）
  automation: {
    availablePackages: ['standard'],
    userSelectable: false,
    availableActions: [],
    transforms: {}
  }
}

/**
 * 不可变换集（§2.1 普遍例外）：`deny`、`confirm-every-time`、`locked` 条目——
 * 任何档位都不变换（放宽与收紧都不）。「必须真人 / 系统底线」语义的条目不因档位而换路径。
 * `extraction-failed` 兜底在引擎合成规则侧豁免（policyEngine.applyDefault）。
 */
function isTransformExempt(rule: Pick<PolicyRule, 'action' | 'locked'>): boolean {
  return Boolean(rule.locked) || rule.action === 'deny' || rule.action === 'confirm-every-time'
}

/**
 * 基线动作 → 生效动作（显示=实际：渲染端与引擎共用）。
 * S1（偏差 15）：映射表仅剩 desktop standard「自动」（路径选择非宽严）；strict / loose 恒等。
 * custom 档恒等（用户覆盖即最终动作，动作域合法性由 validateRuleOverride 按 lane 校验）；
 * 档位不在本链路 transforms 中按恒等返回，收敛责任在调用方（M2）。
 */
export function effectiveActionFor(
  lane: ExecutionLane,
  pkg: PolicyPackage,
  rule: Pick<PolicyRule, 'action' | 'locked'>
): PolicyAction {
  if (isTransformExempt(rule)) return rule.action
  if (pkg === 'custom') return rule.action
  const mapping = LANE_PROFILES[lane].transforms[pkg]
  return mapping?.[rule.action] ?? rule.action
}

/**
 * 自定义套餐覆盖校验（主进程强制，UI 仅作前置提示；B2 动作域按 lane）：
 * 规则必须存在、非 locked；动作 ∈ 本链路 availableActions
 * （desktop 4 态含 auto-evaluator；wechat/feishu 3 态拒绝 auto-evaluator）。
 * 调用方未带 lane 时按最严格 3 态域（fail-closed：auto-evaluator 仅在显式 desktop 下接受）。
 * 不可增删规则、顺序不可改由"仅按 id 覆盖动作"天然保证。
 */
export function validateRuleOverride(
  baseRules: PolicyRule[],
  ruleId: string,
  action: unknown,
  lane?: ExecutionLane
): { ok: true; rule: PolicyRule } | { ok: false; error: string } {
  const rule = baseRules.find((r) => r.id === ruleId)
  if (!rule) return { ok: false, error: `unknown rule: ${ruleId}` }
  if (rule.locked) return { ok: false, error: `rule is locked: ${ruleId}` }
  const domain: readonly PolicyAction[] = lane
    ? LANE_PROFILES[lane].availableActions
    : (['deny', 'allow', 'ask'] as const)
  if (!domain.includes(action as PolicyAction)) {
    return { ok: false, error: `invalid action: ${String(action)}` }
  }
  return { ok: true, rule }
}

/**
 * custom 覆盖应用（M2 纵深防御）：过滤掉不在本链路 availableActions 的覆盖
 * （B2：auto-evaluator 仅 desktop；wechat/feishu 拒绝——入口校验之外的引擎层防线）。
 * 覆盖 = 用户显式定死动作：剥离条件门控（configRequires/askUnless/requiresContext），
 * 否则被门控拦截时覆盖静默失效。
 */
function applyCustom(lane: ExecutionLane, rules: PolicyRule[], overrides: PolicyRuleOverrideInput[]): PolicyRule[] {
  if (overrides.length === 0) return rules
  const allowed = new Set<PolicyAction>(LANE_PROFILES[lane].availableActions)
  const byId = new Map(overrides.filter((o) => allowed.has(o.action)).map((o) => [o.ruleId, o]))
  if (byId.size === 0) return rules
  return rules.map((r) => {
    if (r.locked) return r
    const o = byId.get(r.id)
    if (!o) return r
    const { configRequires: _c, askUnless: _a, requiresContext: _r, ...rest } = r
    return { ...rest, action: o.action }
  })
}

/**
 * 档位是否在本链路可用（§2.1 availablePackages；automation 仅 standard）。
 * IPC 写入入口（security:set-policy-package）与运行时防护（normalizePolicyPackages 收敛）共用此口径。
 */
export function isPackageAvailableForLane(lane: ExecutionLane, pkg: PolicyPackage): boolean {
  return LANE_PROFILES[lane].availablePackages.includes(pkg)
}

/** 范围条目注入生效集时剥离机制字段 supersedes（生效集内是普通 PolicyRule）。 */
function scopeAsRule(scope: ScopeRule): PolicyRule {
  const { supersedes: _superseded, ...rule } = scope
  return rule
}

/**
 * 范围档应用（S1，偏差 15）：以显式清单条目取代 supersedes 目标（本档生效集内）。
 * 目标不在传入规则集时不注入（合成规则集恒等、返回原引用）；其余条目一律原样——
 * 档位只决定「哪些域」的裁定条目被取代，不做任何整体宽严变换。
 */
function applyScope(lane: ExecutionLane, pkg: 'strict' | 'loose', rules: PolicyRule[]): PolicyRule[] {
  const scopes = LANE_PROFILES[lane].scopePackages?.[pkg]
  if (!scopes || scopes.length === 0) return rules
  const bySupersedes = new Map(scopes.map((s) => [s.supersedes, s]))
  let hit = false
  const out = rules.map((r) => {
    const scope = bySupersedes.get(r.id)
    if (!scope) return r
    hit = true
    return scopeAsRule(scope)
  })
  return hit ? out : rules
}

/**
 * 按链路解析生效规则集（§2.1 LANE_PROFILES）：基础规则 + 范围档条目取代 / 自定义覆盖。
 * - 恒等情形（standard、无清单目标命中的 strict / loose、无覆盖的 custom）返回原数组引用，保证零行为变化快路径；
 * - 档位不在本链路可用集合 → 视为 standard（M2：automation 伪造 loose/custom 等）；
 * - 决策 1：不再按回答者收紧套餐（「非 user 不许 loose」论证不成立，以用户显式选择为准）；
 * - S1（偏差 15）：strict / loose 为范围档——显式 ScopeRule 取代目标条目，全 lane 无宽严变换。
 */
export function resolvePolicyRules(args: {
  lane: ExecutionLane
  packages?: Partial<PolicyPackageMap>
  overrides?: PolicyRuleOverrideInput[]
  rules: PolicyRule[]
}): PolicyRule[] {
  const profile = LANE_PROFILES[args.lane]
  let pkg = args.packages?.[args.lane] ?? 'standard'
  if (!profile.availablePackages.includes(pkg)) pkg = 'standard'
  switch (pkg) {
    case 'strict':
    case 'loose':
      return applyScope(args.lane, pkg, args.rules)
    case 'custom':
      return applyCustom(args.lane, args.rules, args.overrides ?? [])
    default:
      // standard 恒等：desktop 的「自动」（ask→auto-evaluator）不在规则集层面变换——
      // 规则集变换会把 ask 条目提升到引擎第 4 步，破坏 mcp-readonly-allow 等条目的顺序语义；
      // 该映射由引擎产出时经 deps.transform（effectiveActionFor 同源）解释，规则顺序保持。
      return args.rules
  }
}
