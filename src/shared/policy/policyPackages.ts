import type { ExecutionLane, PolicyAction, PolicyRule } from '../confirmation/types'

/**
 * 策略套餐（顶层设计 §4 第 1 区 / §5）：每条链路选择 严格/标准/宽松/自定义 之一。
 * - standard：内置默认规则原样生效；
 * - strict：非 locked 的 allow/auto-evaluator 条目上调为 ask（宁可多问）；
 * - loose：非 locked 的 ask 条目下调为 allow（用户显式选择，设置页带风险警示）；
 * - custom：应用用户在 policy_rules 表中的规则覆盖（仅动作/参数，规则不可增删、顺序不可改）。
 *
 * locked 条目在任何套餐下都不可被调松/改写（系统保护底线）。
 */
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

/** 从持久化 JSON（可能残缺/损坏）解析套餐映射，缺省链路回退 standard。 */
export function normalizePolicyPackages(raw: unknown): PolicyPackageMap {
  const out: PolicyPackageMap = { ...DEFAULT_POLICY_PACKAGES }
  if (!raw || typeof raw !== 'object') return out
  for (const lane of ['desktop', 'wechat', 'feishu', 'automation'] as const) {
    const v = (raw as Record<string, unknown>)[lane]
    if (isPolicyPackage(v)) out[lane] = v
  }
  return out
}

/** 规则覆盖（与 electron PolicyRuleStore 行结构对齐；参数保留，引擎本期只消费动作）。 */
export interface PolicyRuleOverrideInput {
  ruleId: string
  action: PolicyAction
  params?: Record<string, unknown>
}

/** 自定义套餐可编辑的动作集合（普通规则限定 deny/allow/ask）。 */
const CUSTOM_EDITABLE_ACTIONS: readonly PolicyAction[] = ['deny', 'allow', 'ask']
/** 默认动作即 auto-evaluator 的规则（自动审批器入口）允许的动作域：询问/允许/自动。 */
const AUTO_EVALUATOR_EDITABLE_ACTIONS: readonly PolicyAction[] = ['deny', 'allow', 'ask', 'auto-evaluator']

/**
 * 自定义套餐覆盖校验（主进程强制，UI 仅作前置提示）：
 * 规则必须存在、非 locked；普通规则动作 ∈ {deny, allow, ask}；
 * 默认动作即 auto-evaluator 的规则（如 desktop-auto-approve）额外允许覆盖回 auto-evaluator。
 * 不可增删规则、顺序不可改由"仅按 id 覆盖动作"天然保证。
 */
export function validateRuleOverride(
  baseRules: PolicyRule[],
  ruleId: string,
  action: unknown
): { ok: true; rule: PolicyRule } | { ok: false; error: string } {
  const rule = baseRules.find((r) => r.id === ruleId)
  if (!rule) return { ok: false, error: `unknown rule: ${ruleId}` }
  if (rule.locked) return { ok: false, error: `rule is locked: ${ruleId}` }
  const editable = rule.action === 'auto-evaluator' ? AUTO_EVALUATOR_EDITABLE_ACTIONS : CUSTOM_EDITABLE_ACTIONS
  if (!editable.includes(action as PolicyAction)) {
    return { ok: false, error: `invalid action: ${String(action)}` }
  }
  return { ok: true, rule }
}

function applyStrict(rules: PolicyRule[]): PolicyRule[] {
  return rules.map((r) =>
    !r.locked && (r.action === 'allow' || r.action === 'auto-evaluator') ? { ...r, action: 'ask' as const } : r
  )
}

function applyLoose(rules: PolicyRule[]): PolicyRule[] {
  return rules.map((r) => (!r.locked && r.action === 'ask' ? { ...r, action: 'allow' as const } : r))
}

function applyCustom(rules: PolicyRule[], overrides: PolicyRuleOverrideInput[]): PolicyRule[] {
  if (overrides.length === 0) return rules
  const byId = new Map(overrides.map((o) => [o.ruleId, o]))
  return rules.map((r) => {
    if (r.locked) return r
    const o = byId.get(r.id)
    if (!o) return r
    const editable = r.action === 'auto-evaluator' ? AUTO_EVALUATOR_EDITABLE_ACTIONS : CUSTOM_EDITABLE_ACTIONS
    if (!editable.includes(o.action)) return r
    // 覆盖 = 用户显式定死动作：剥离条件门控（configRequires/askUnless/requiresContext），
    // 否则被门控拦截时覆盖静默失效（如 desktop-auto-approve 覆盖为"询问"但 confirmMode≠auto 不命中）
    const { configRequires: _c, askUnless: _a, requiresContext: _r, ...rest } = r
    return { ...rest, action: o.action }
  })
}

/**
 * 按链路解析生效规则集：基础规则 + 套餐变换/自定义覆盖。
 * 默认（standard 且无覆盖）返回原数组引用，保证零行为变化的快路径。
 */
export function resolvePolicyRules(args: {
  lane: ExecutionLane
  packages?: Partial<PolicyPackageMap>
  overrides?: PolicyRuleOverrideInput[]
  rules: PolicyRule[]
}): PolicyRule[] {
  const pkg = args.packages?.[args.lane] ?? 'standard'
  switch (pkg) {
    case 'strict':
      return applyStrict(args.rules)
    case 'loose':
      return applyLoose(args.rules)
    case 'custom':
      return applyCustom(args.rules, args.overrides ?? [])
    default:
      return args.rules
  }
}
