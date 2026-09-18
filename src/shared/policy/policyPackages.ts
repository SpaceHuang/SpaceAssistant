import type { ConfirmAnswererKind, ExecutionLane, PolicyAction, PolicyRule } from '../confirmation/types'

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
   * custom 档是用户显式覆盖，不经变换表改写。
   */
  transforms: Partial<Record<'strict' | 'standard' | 'loose', Partial<Record<PolicyAction, PolicyAction>>>>
}

/**
 * 桌面（决策 7/8）：standard 非 locked `ask → auto-evaluator`（=「自动」：快通道 + 审批 Agent）；
 * strict 收紧（allow/auto-evaluator → ask）；loose 放宽（ask → allow，auto-evaluator 保持）。
 */
const DESKTOP_TRANSFORMS: LaneProfile['transforms'] = {
  strict: { allow: 'ask', 'auto-evaluator': 'ask' },
  standard: { ask: 'auto-evaluator' },
  loose: { ask: 'allow' }
}

/** wechat/feishu：standard 恒等（本轮零行为变化硬回归）；无 auto-evaluator 条目，strict 只上调 allow。 */
const IM_TRANSFORMS: LaneProfile['transforms'] = {
  strict: { allow: 'ask' },
  loose: { ask: 'allow' }
}

export const LANE_PROFILES: Record<ExecutionLane, LaneProfile> = {
  desktop: {
    availablePackages: ['strict', 'standard', 'loose', 'custom'],
    userSelectable: true,
    availableActions: ['deny', 'allow', 'ask', 'auto-evaluator'],
    transforms: DESKTOP_TRANSFORMS
  },
  wechat: {
    availablePackages: ['strict', 'standard', 'loose', 'custom'],
    userSelectable: true,
    availableActions: ['deny', 'allow', 'ask'],
    transforms: IM_TRANSFORMS
  },
  feishu: {
    availablePackages: ['strict', 'standard', 'loose', 'custom'],
    userSelectable: true,
    availableActions: ['deny', 'allow', 'ask'],
    transforms: IM_TRANSFORMS
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
 * custom 档恒等（用户覆盖即最终动作，动作域合法性由 validateRuleOverride 按 lane 校验）；
 * 档位不在本链路 transforms 中（如 automation × strict）按恒等返回，收敛责任在调用方（M2）。
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
 * P2-5：非 user 回答者（agent / deny）的 custom 覆盖只保留收紧项。
 * 覆盖到 allow 的条目一律丢弃：对 allow 基准是无操作，对 ask/deny 基准是向下覆盖。
 * deny 回答者（无任何应答者）同样受此约束——否则「全拒」会被 custom 静默翻转为「放行」。
 */
function applyCustomForNonUserAnswerer(rules: PolicyRule[], overrides: PolicyRuleOverrideInput[]): PolicyRule[] {
  if (overrides.length === 0) return rules
  return applyCustom(rules, overrides.filter((o) => o.action !== 'allow'))
}

/**
 * P2-5 写入强校验（对齐 validateRuleOverride 的强制度）：
 * 非 user 回答者（agent = 审批裁决 / deny = 无应答者）的 lane 不得套用 loose
 * ——「无人监督 + 自动放宽」组合会把 confirm 面静默翻转为全自动放行（缺口 9）。
 */
export function validatePolicyPackageForLane(
  lane: ExecutionLane,
  pkg: PolicyPackage,
  answererKind: ConfirmAnswererKind
): { ok: true } | { ok: false; error: string } {
  if (answererKind !== 'user' && pkg === 'loose') {
    return { ok: false, error: `lane ${lane} 的回答者非人类（${answererKind}），不得使用 loose 套餐` }
  }
  return { ok: true }
}

/**
 * 按链路解析生效规则集：基础规则 + 套餐变换/自定义覆盖。
 * 默认（standard 且无覆盖）返回原数组引用，保证零行为变化的快路径。
 * P2-5：answererKind='agent' 的 lane 不得 loose（按 standard 处理）、custom 只保留收紧覆盖。
 */
export function resolvePolicyRules(args: {
  lane: ExecutionLane
  packages?: Partial<PolicyPackageMap>
  overrides?: PolicyRuleOverrideInput[]
  rules: PolicyRule[]
  /** 回答者种类（P2-5 套餐约束的维度）；缺省 'user' 保持既有行为。 */
  answererKind?: ConfirmAnswererKind
}): PolicyRule[] {
  const pkg = args.packages?.[args.lane] ?? 'standard'
  // P2 guard（偏差 15 最小防护）：automation 无人类应答者，无豁免来源——不得套用 loose 档。
  // P2-5 评审修复：约束扩到一切非 user 回答者（agent / deny）——deny 的「全拒」面不得被 loose 静默翻转为放行。
  const nonUserAnswerer = args.answererKind === 'agent' || args.answererKind === 'deny'
  if (pkg === 'loose' && (args.lane === 'automation' || nonUserAnswerer)) return args.rules
  switch (pkg) {
    case 'strict':
      return applyStrict(args.rules)
    case 'loose':
      return applyLoose(args.rules)
    case 'custom':
      return nonUserAnswerer
        ? applyCustomForNonUserAnswerer(args.rules, args.overrides ?? [])
        : applyCustom(args.rules, args.overrides ?? [])
    default:
      return args.rules
  }
}
