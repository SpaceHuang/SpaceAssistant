import type { FileConfirmMode } from '../domainTypes'
import type { PolicyPackage, PolicyPackageMap } from '../policy/policyPackages'
import type {
  CacheKey,
  DecisionCacheEntry,
  ExecutionLane,
  PolicyAction,
  PolicyWhen,
  SecurityAuditEvent
} from './types'

/**
 * 设置中心「工具与安全」页（§7 五区）跨进程载荷类型。
 * 主进程装配（electron/confirmation/settingsSecurityModel.ts），渲染端只读消费。
 */

/** 策略规则展示视图：默认规则 + 用户覆盖合并（locked 条目只读）。 */
export interface SecuritySettingsRuleView {
  id: string
  when: PolicyWhen
  /** 当前生效动作（已合并覆盖）。 */
  action: PolicyAction
  /** 内置默认动作（未合并覆盖）。 */
  defaultAction: PolicyAction
  locked: boolean
  reason: string
  overridden: boolean
  /** 规则适用链路（rule.match.lane）；缺省表示不限定链路、全链路通用。 */
  lanes?: ExecutionLane[]
}

/** 五区数据装配结果。 */
export interface SecuritySettingsModelPayload {
  /** 1. 策略套餐（每链路） */
  packages: PolicyPackageMap
  /** 2. 确认模式 */
  confirmMode: FileConfirmMode
  /** 3. 工具开关（deniedTools） */
  deniedTools: string[]
  /** 4. 确认记忆（decision_cache 全量，渲染端按档位分组） */
  memoryEntries: DecisionCacheEntry[]
  /** 5. 安全审计摘要 */
  audit: { retentionDays: number; haveAuditLog: boolean }
  /** 策略规则合并视图（套餐编辑器数据源） */
  rules: SecuritySettingsRuleView[]
}

/** 审计查询条件（security:query-audit）。 */
export interface SecurityAuditQueryPayload {
  since?: number
  until?: number
  lane?: ExecutionLane
  event?: string
  toolName?: string
  limit?: number
}

export type SecurityAuditQueryResult = SecurityAuditEvent[]

/** 清除确认记忆：单条（带 key）或全部（缺省）。 */
export interface SecurityClearCachePayload {
  key?: CacheKey
}

export type { PolicyPackage, PolicyPackageMap }
