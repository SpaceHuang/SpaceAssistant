import type {
  DecisionCacheEntry,
  ExecutionLane,
  PolicyRule
} from '../../src/shared/confirmation/types'
import type { FileConfirmMode } from '../../src/shared/domainTypes'
import type {
  SecuritySettingsModelPayload,
  SecuritySettingsRuleView
} from '../../src/shared/confirmation/settingsCenter'
import {
  DEFAULT_POLICY_PACKAGES,
  type PolicyPackage,
  type PolicyPackageMap
} from '../../src/shared/policy/policyPackages'

export type { PolicyPackage }

/** @deprecated 使用 SecuritySettingsModelPayload（src/shared/confirmation/settingsCenter.ts） */
export type SettingsSecurityModel = SecuritySettingsModelPayload

/**
 * 设置中心"工具与安全"页（§7 五区）的数据装配：套餐/确认模式/工具开关/确认记忆/审计摘要/规则视图。
 * 纯数据函数，供渲染端直接消费；审计日志实体由 SecurityAuditLog 提供。
 */
export function buildSettingsSecurityModel(args: {
  packages: Partial<Record<ExecutionLane, PolicyPackage>>
  confirmMode: FileConfirmMode
  deniedTools: string[]
  cache: DecisionCacheEntry[]
  rules: SecuritySettingsRuleView[]
  retentionDays: number
  haveAuditLog: boolean
}): SecuritySettingsModelPayload {
  return {
    packages: {
      desktop: args.packages.desktop ?? DEFAULT_POLICY_PACKAGES.desktop,
      wechat: args.packages.wechat ?? DEFAULT_POLICY_PACKAGES.wechat,
      feishu: args.packages.feishu ?? DEFAULT_POLICY_PACKAGES.feishu,
      automation: args.packages.automation ?? DEFAULT_POLICY_PACKAGES.automation
    },
    confirmMode: args.confirmMode,
    deniedTools: args.deniedTools,
    memoryEntries: args.cache,
    audit: { retentionDays: args.retentionDays, haveAuditLog: args.haveAuditLog },
    rules: args.rules
  }
}

/** 默认规则 → 展示视图（无覆盖）。 */
export function toRuleViews(
  rules: PolicyRule[],
  overrides: Array<{ ruleId: string; action: PolicyRule['action'] }>
): SecuritySettingsRuleView[] {
  const byId = new Map(overrides.map((o) => [o.ruleId, o]))
  return rules.map((rule) => {
    const o = byId.get(rule.id)
    return {
      id: rule.id,
      when: rule.when,
      action: o?.action ?? rule.action,
      defaultAction: rule.action,
      locked: rule.locked === true,
      reason: rule.reason,
      overridden: o != null && o.action !== rule.action
    }
  })
}
