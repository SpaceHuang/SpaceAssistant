import type {
  DecisionCacheEntry,
  ExecutionLane,
  PolicyRule
} from '../../src/shared/confirmation/types'
import type { FileConfirmMode } from '../../src/shared/domainTypes'

export type PolicyPackage = 'strict' | 'standard' | 'loose' | 'custom'

export interface SettingsSecurityModel {
  /** 1. 策略套餐 */
  packages: Record<ExecutionLane, PolicyPackage>
  /** 2. 确认模式 */
  confirmMode: FileConfirmMode
  /** 3. 工具开关（deniedTools） */
  deniedTools: string[]
  /** 4. 确认记忆管理（来自 decision_cache） */
  memoryEntries: DecisionCacheEntry[]
  /** 5. 安全审计保留（由审计日志模块承载；此处给出可读性摘要） */
  audit: { retentionDays: number; haveAuditLog: boolean }
}

/**
 * 设置中心"工具与安全"页（§7 五区）的数据装配：套餐/确认模式/工具开关/确认记忆/审计摘要。
 * 纯数据函数，供渲染端直接消费；审计日志实体由 SecurityAuditLog 提供。
 */
export function buildSettingsSecurityModel(args: {
  packages: Record<ExecutionLane, PolicyPackage>
  confirmMode: FileConfirmMode
  deniedTools: string[]
  cache: DecisionCacheEntry[]
  rules: PolicyRule[]
  retentionDays: number
  haveAuditLog: boolean
}): SettingsSecurityModel {
  return {
    packages: {
      desktop: args.packages.desktop ?? 'standard',
      wechat: args.packages.wechat ?? 'standard',
      feishu: args.packages.feishu ?? 'standard',
      automation: args.packages.automation ?? 'standard'
    },
    confirmMode: args.confirmMode,
    deniedTools: args.deniedTools,
    memoryEntries: args.cache,
    audit: { retentionDays: args.retentionDays, haveAuditLog: args.haveAuditLog }
  }
}
