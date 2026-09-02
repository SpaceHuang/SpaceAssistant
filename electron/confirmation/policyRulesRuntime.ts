import type { ExecutionLane, PolicyRule } from '../../src/shared/confirmation/types'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import {
  DEFAULT_POLICY_PACKAGES,
  normalizePolicyPackages,
  resolvePolicyRules,
  type PolicyPackage,
  type PolicyPackageMap
} from '../../src/shared/policy/policyPackages'
import { getConfigValue, setConfigValue, type AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { PolicyRuleStore } from './policyRuleStore'

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
    return normalizePolicyPackages(JSON.parse(raw))
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
  const uniq = Array.from(new Set(ids))
  setConfigValue(db, DISABLED_POLICY_RULE_IDS_CONFIG_KEY, JSON.stringify(uniq))
}

/** 某条系统保护规则是否处于「不启用」状态。 */
export function isPolicyRuleDisabled(db: AppDatabase, ruleId: string): boolean {
  return readDisabledPolicyRuleIds(db).includes(ruleId)
}

/**
 * 按链路加载生效规则集：默认（standard 且无覆盖）返回 DEFAULT_POLICY_RULES 引用，
 * 保证未配置套餐/覆盖时与 P1–P3 行为逐项等价；strict/loose/custom 经 resolvePolicyRules 变换。
 */
export function loadEffectivePolicyRules(db: AppDatabase, lane: ExecutionLane): PolicyRule[] {
  const packages = readPolicyPackages(db)
  const disabledRuleIds = readDisabledPolicyRuleIds(db)
  const pkg = packages[lane] ?? 'standard'
  // 未被「不启用」的系统保护规则，拦截其作为第 1 步硬拒绝被评估。
  const baseRules = disabledRuleIds.length
    ? (DEFAULT_POLICY_RULES.filter((r) => !disabledRuleIds.includes(r.id)) as PolicyRule[])
    : DEFAULT_POLICY_RULES
  // 默认（standard 且无禁用规则）返回 DEFAULT_POLICY_RULES 引用，保持零行为变化快路径。
  if (pkg === 'standard' && disabledRuleIds.length === 0) return DEFAULT_POLICY_RULES
  const overrides = pkg === 'custom' ? new PolicyRuleStore(getDbConnection(db)).listOverrides() : []
  return resolvePolicyRules({ lane, packages, overrides, rules: baseRules })
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
