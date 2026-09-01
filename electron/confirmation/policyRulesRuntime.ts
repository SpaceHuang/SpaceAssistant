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

/**
 * 按链路加载生效规则集：默认（standard 且无覆盖）返回 DEFAULT_POLICY_RULES 引用，
 * 保证未配置套餐/覆盖时与 P1–P3 行为逐项等价；strict/loose/custom 经 resolvePolicyRules 变换。
 */
export function loadEffectivePolicyRules(db: AppDatabase, lane: ExecutionLane): PolicyRule[] {
  const packages = readPolicyPackages(db)
  const pkg = packages[lane] ?? 'standard'
  if (pkg === 'standard') return DEFAULT_POLICY_RULES
  const overrides = pkg === 'custom' ? new PolicyRuleStore(getDbConnection(db)).listOverrides() : []
  return resolvePolicyRules({ lane, packages, overrides, rules: DEFAULT_POLICY_RULES })
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
