import type { ExecutionLane, PolicyRule } from '../../src/shared/confirmation/types'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import {
  DEFAULT_POLICY_PACKAGES,
  normalizePolicyPackages,
  resolvePolicyRules,
  resolveImPolicyRulesForVersion,
  isPolicyPackage,
  validateRuleOverride,
  type PolicyPackage,
  type PolicyPackageMap
} from '../../src/shared/policy/policyPackages'
import { getConfigValue, setConfigValue, type AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { PolicyRuleStore } from './policyRuleStore'
import { readImPolicySnapshot } from './imPolicyStore'

/** 套餐映射持久化 key（configs 表 key-value，JSON）。 */
export const POLICY_PACKAGES_CONFIG_KEY = 'config.policyPackages'
/** 安全审计保留天数持久化 key（默认 180，设置页可调，§5.6-1）。 */
export const SECURITY_AUDIT_RETENTION_CONFIG_KEY = 'config.securityAuditRetentionDays'
/** 被「不启用」的系统保护规则 id 集合持久化 key（可切换的禁止类规则，§7）。 */
export const DISABLED_POLICY_RULE_IDS_CONFIG_KEY = 'config.disabledPolicyRuleIds'

export const DEFAULT_SECURITY_AUDIT_RETENTION_DAYS = 180

export function readPolicyPackages(db: AppDatabase): PolicyPackageMap {
  const raw = getConfigValue(db, POLICY_PACKAGES_CONFIG_KEY)
  if (!raw) return { ...DEFAULT_POLICY_PACKAGES }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const normalized = normalizePolicyPackages(parsed)
    // M2 告警（评审低项）：伪造/不可用档位被收敛 standard 时留痕（shared 模块无日志依赖，告警在装配侧落）
    for (const lane of ['desktop', 'wechat', 'feishu', 'automation'] as const) {
      if (parsed[lane] !== undefined && parsed[lane] !== normalized[lane]) {
        void import('../agentLogger/agentLogger').then((m) =>
          m.logAgentEvent('warn', 'policy.package.normalized', {
            detail: `policy package for lane ${lane} normalized: ${String(parsed[lane])} -> ${normalized[lane]}`,
            timestamp: Date.now()
          })
        )
      }
    }
    return normalized
  } catch {
    return { ...DEFAULT_POLICY_PACKAGES }
  }
}

export function writePolicyPackages(db: AppDatabase, packages: PolicyPackageMap): void {
  setConfigValue(db, POLICY_PACKAGES_CONFIG_KEY, JSON.stringify(packages))
}

export function readSecurityAuditRetentionDays(db: AppDatabase): number {
  const raw = getConfigValue(db, SECURITY_AUDIT_RETENTION_CONFIG_KEY)
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SECURITY_AUDIT_RETENTION_DAYS
}

export function writeSecurityAuditRetentionDays(db: AppDatabase, days: number): void {
  setConfigValue(db, SECURITY_AUDIT_RETENTION_CONFIG_KEY, String(Math.floor(days)))
}

/** 读取被「不启用」（关闭）的系统保护规则 id 集合；缺省为空数组。 */
export function readDisabledPolicyRuleIds(db: AppDatabase): string[] {
  const raw = getConfigValue(db, DISABLED_POLICY_RULE_IDS_CONFIG_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** 写回被「不启用」的系统保护规则 id 集合（去重、保序）。 */
export function writeDisabledPolicyRuleIds(db: AppDatabase, ids: string[]): void {
  const nonToggleableLockedIds = new Set(DEFAULT_POLICY_RULES.filter((rule) => rule.locked && rule.action !== 'deny').map((rule) => rule.id))
  const uniq = Array.from(new Set(ids)).filter((id) => !nonToggleableLockedIds.has(id))
  setConfigValue(db, DISABLED_POLICY_RULE_IDS_CONFIG_KEY, JSON.stringify(uniq))
}

/** 某条系统保护规则是否处于「不启用」状态。 */
export function isPolicyRuleDisabled(db: AppDatabase, ruleId: string): boolean {
  return readDisabledPolicyRuleIds(db).includes(ruleId)
}

/**
 * 按链路加载生效规则集 + 当前档位（toolCallGate 装配 deps.transform 用）。
 * desktop standard 的「自动」变换在此生效；恒等 lane（standard 无变换）返回 DEFAULT_POLICY_RULES 引用。
 */
/** 规则来源（P3：审计能回答「我设的 allow 为什么没生效」）。 */
export type PolicyRuleOriginSource = 'builtin' | 'package' | 'user-override' | 'migration'

export interface PolicyRuleOrigin {
  source: PolicyRuleOriginSource
  /** 被遮蔽规则的痕迹（哪条被哪条盖住）。 */
  shadowed?: Array<{ source: PolicyRuleOriginSource }>
}

/**
 * 带来源的生效规则解析（P3）：规则集与 loadEffectivePolicyRules 同判，
 * 额外携带每条生效规则的来源维度与被遮蔽痕迹。
 * （合并适配：回答者由动作派生后不再有 answererKind 套餐约束，standard 恒等快路径全 lane 一致。）
 */
export function resolveEffectivePolicyRulesWithOrigin(
  db: AppDatabase,
  lane: ExecutionLane
): { rules: PolicyRule[]; origins: Record<string, PolicyRuleOrigin>; disabledRuleIds: string[] } {
  const origins: Record<string, PolicyRuleOrigin> = {}
  if (lane === 'wechat' || lane === 'feishu') {
    try {
      const snapshot = readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
      if (snapshot.policyBehaviorVersion === 'im-standard-v2' || snapshot.policyBehaviorVersion === 'im-v1.6') {
        const toggleableDenyIds = new Set(DEFAULT_POLICY_RULES
          .filter((rule) => rule.locked && rule.action === 'deny').map((rule) => rule.id))
        const imDisabledRuleIds = Array.isArray(snapshot.snapshot.disabledRuleIds)
          ? [...new Set(snapshot.snapshot.disabledRuleIds.filter((id): id is string =>
            typeof id === 'string' && toggleableDenyIds.has(id)))]
          : []
        const baseRules = DEFAULT_POLICY_RULES.filter((rule) => !imDisabledRuleIds.includes(rule.id)) as PolicyRule[]
        const legacyPackages = snapshot.snapshot.legacySelectedPackages && typeof snapshot.snapshot.legacySelectedPackages === 'object' &&
          !Array.isArray(snapshot.snapshot.legacySelectedPackages)
          ? snapshot.snapshot.legacySelectedPackages as Record<string, unknown> : {}
        const selectedPackage = isPolicyPackage(snapshot.snapshot.selectedPackage)
          ? snapshot.snapshot.selectedPackage
          : isPolicyPackage(legacyPackages[lane]) ? legacyPackages[lane] as PolicyPackage
            : 'standard'
        const rawOverrides = snapshot.snapshot.ruleOverrides
        const overrides = rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)
          ? rawOverrides as Record<string, unknown> : {}
        const validatedOverrides = Object.entries(overrides).flatMap(([ruleId, action]) => {
          const validation = validateRuleOverride(DEFAULT_POLICY_RULES, ruleId, action, lane)
          return validation.ok ? [{ ruleId, action: action as PolicyRule['action'] }] : []
        })
        const rules = snapshot.policyBehaviorVersion === 'im-standard-v2'
          ? resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion,
            pkg: selectedPackage, rules: baseRules })
          : resolvePolicyRules({ lane, packages: { ...DEFAULT_POLICY_PACKAGES, [lane]: selectedPackage },
            overrides: [], rules: baseRules })
        const origins: Record<string, PolicyRuleOrigin> = Object.fromEntries(rules.map((rule) => [rule.id,
          { source: rule.action !== DEFAULT_POLICY_RULES.find((base) => base.id === rule.id)?.action ? 'package' : 'builtin',
            ...(rule.action !== DEFAULT_POLICY_RULES.find((base) => base.id === rule.id)?.action ? { shadowed: [{ source: 'builtin' as const }] } : {}) }]))
        // Reuse the custom policy resolver so an explicit user action removes the old
        // rule's conditional gates (configRequires / askUnless / requiresContext).
        const withOverrides = resolvePolicyRules({ lane, packages: { ...DEFAULT_POLICY_PACKAGES, [lane]: 'custom' },
          overrides: validatedOverrides, rules })
        const userOverrideIds = new Set(validatedOverrides.map(({ ruleId }) => ruleId))
        for (let index = 0; index < rules.length; index += 1) {
          const resolvedRule = withOverrides[index]!
          rules[index] = userOverrideIds.has(resolvedRule.id) ? { ...resolvedRule, userOverride: true } : resolvedRule
        }
        for (const [ruleId, action] of Object.entries(overrides)) {
          const validation = validateRuleOverride(DEFAULT_POLICY_RULES, ruleId, action, lane)
          if (!validation.ok) continue
          origins[ruleId] = { source: 'user-override', shadowed: [{ source: 'builtin' }] }
        }
        return { rules, origins, disabledRuleIds: imDisabledRuleIds }
      }
    } catch {
      // Legacy installations continue through the legacy policy sources below.
    }
  }
  const packages = readPolicyPackages(db)
  const disabledRuleIds = readDisabledPolicyRuleIds(db)
  const nonToggleableLockedIds = new Set(DEFAULT_POLICY_RULES.filter((rule) => rule.locked && rule.action !== 'deny').map((rule) => rule.id))
  const safeDisabledRuleIds = disabledRuleIds.filter((id) => !nonToggleableLockedIds.has(id))
  const pkg = packages[lane] ?? 'standard'
  const baseRules = safeDisabledRuleIds.length
    ? (DEFAULT_POLICY_RULES.filter((r) => !safeDisabledRuleIds.includes(r.id)) as PolicyRule[])
    : DEFAULT_POLICY_RULES
  const overrides = pkg === 'custom' ? new PolicyRuleStore(getDbConnection(db)).listOverrides() : []
  const resolved = resolvePolicyRules({ lane, packages, overrides, rules: baseRules })
  const overrideById = new Map(overrides.map((o) => [o.ruleId, o]))
  const baseById = new Map(baseRules.map((r) => [r.id, r]))
  const resolvedWithUserOverrides = resolved.map((rule) => overrideById.has(rule.id) ? { ...rule, userOverride: true as const } : rule)
  for (const rule of resolvedWithUserOverrides) {
    const override = overrideById.get(rule.id)
    if (override) {
      origins[rule.id] = { source: 'user-override', shadowed: [{ source: 'builtin' }] }
    } else if (baseById.get(rule.id)?.action !== rule.action) {
      // 档位范围条目（scope-*，S1 偏差 15）改变了默认动作来源
      origins[rule.id] = { source: 'package', shadowed: [{ source: 'builtin' }] }
    } else {
      origins[rule.id] = { source: 'builtin' }
    }
  }
  return { rules: resolvedWithUserOverrides, origins, disabledRuleIds: safeDisabledRuleIds }
}

export function loadLanePolicyContext(db: AppDatabase, lane: ExecutionLane): { rules: PolicyRule[]; pkg: PolicyPackage } {
  const packages = readPolicyPackages(db)
  const disabledRuleIds = readDisabledPolicyRuleIds(db)
  const nonToggleableLockedIds = new Set(DEFAULT_POLICY_RULES.filter((rule) => rule.locked && rule.action !== 'deny').map((rule) => rule.id))
  const safeDisabledRuleIds = disabledRuleIds.filter((id) => !nonToggleableLockedIds.has(id))
  if (safeDisabledRuleIds.length !== disabledRuleIds.length) writeDisabledPolicyRuleIds(db, safeDisabledRuleIds)
  const pkg = packages[lane] ?? 'standard'
  const baseRules = safeDisabledRuleIds.length
    ? (DEFAULT_POLICY_RULES.filter((r) => !safeDisabledRuleIds.includes(r.id)) as PolicyRule[])
    : DEFAULT_POLICY_RULES
  const overrides = pkg === 'custom' ? new PolicyRuleStore(getDbConnection(db)).listOverrides() : []
  return { rules: resolvePolicyRules({ lane, packages, overrides, rules: baseRules }), pkg }
}

/**
 * 按链路加载生效规则集：恒等情形（standard、无清单目标命中的 strict/loose）返回 DEFAULT_POLICY_RULES
 * 引用（零行为变化快路径）；strict / loose 为范围档（scope-* 条目取代目标，S1 偏差 15）；
 * desktop standard 的「自动」ask→auto-evaluator 由引擎产出层经 deps.transform 解释，不在规则集层面。
 */
export function loadEffectivePolicyRules(db: AppDatabase, lane: ExecutionLane): PolicyRule[] {
  return loadLanePolicyContext(db, lane).rules
}

/** 设置页展示用：默认规则 + 当前覆盖合并视图（overridden 标记）。 */
export function listPolicyRulesWithOverrides(db: AppDatabase): Array<{
  rule: PolicyRule
  overridden: boolean
  overrideAction?: PolicyRule['action']
}> {
  const overrides = new PolicyRuleStore(getDbConnection(db)).listOverrides()
  const byId = new Map(overrides.map((o) => [o.ruleId, o]))
  return DEFAULT_POLICY_RULES.map((rule) => {
    const o = byId.get(rule.id)
    return o
      ? { rule: { ...rule, action: o.action }, overridden: true, overrideAction: o.action }
      : { rule, overridden: false }
  })
}

export type { PolicyPackage, PolicyPackageMap }
