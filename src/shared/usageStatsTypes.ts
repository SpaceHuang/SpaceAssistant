/**
 * Agent Token 用量统计 —— 主进程与渲染进程共享的指标 / 维度类型。
 * 口径基准见 docs/requirement/agent-token-usage-analytics-requirement.md §2 / §8。
 */

/** 模型维度：按「服务 + 模型」组合筛选（DIM3：同模型跨服务分开统计）。 */
export type UsageModelFilter = {
  model: string
  llmServiceId?: string
}

export type UsageStatsFilters = {
  models?: UsageModelFilter[]
  sessionIds?: string[]
  appVersions?: string[]
}

export type UsageStatsRangeArgs = {
  /** 本地自然日 YYYY-MM-DD（含） */
  from: string
  /** 本地自然日 YYYY-MM-DD（含） */
  to: string
  dimensions?: UsageStatsFilters
}

/** 每日序列的一个点（§8.1 `usage-stats:daily`）。 */
export type UsageDailyPoint = {
  day: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** 兼容字段：仅显式缓存 provider 会 > 0，界面仅值 > 0 时展示 */
  cacheCreationTokens: number
  /** 方案 B：cacheRead / (input − cacheCreation)；分母为 0 或当日无数据时为 null（断线，不画 0%） */
  hitRate: number | null
  toolCallCount: number
  toolErrorCount: number
  toolSkippedCount: number
  turnCount: number
  stepCount: number
  /** Σstep / Σturn；当日无 Turn 时为 null */
  avgStepsPerTurn: number | null
}

/** 区间汇总（§8.1 `usage-stats:summary`：6 项核心指标 + 佐证指标）。 */
export type UsageSummary = {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 方案 B；分母为 0 时 null（显示 —） */
  hitRate: number | null
  toolCallCount: number
  toolErrorCount: number
  toolSkippedCount: number
  /** 工具出错率 = error / call；call 为 0 时 null */
  toolErrorRate: number | null
  turnCount: number
  stepCount: number
  avgStepsPerTurn: number | null
}

/** 可选筛选值枚举（§8.1 `usage-stats:dimensions`）。 */
export type UsageDimensions = {
  models: UsageModelFilter[]
  /** 已删除会话 name 为 null（界面显示「已删除会话」） */
  sessions: Array<{ sessionId: string; name: string | null }>
  appVersions: string[]
}

/** 保留期设置（C8：按天、可配置、删除留痕）。 */
export type UsageRetentionDays = '30' | '90' | '365' | 'forever'

export const USAGE_RETENTION_DAYS_VALUES: UsageRetentionDays[] = ['30', '90', '365', 'forever']

export const DEFAULT_USAGE_RETENTION_DAYS: UsageRetentionDays = '365'

/** 折线图数据量保护（§5.3.2：最多渲染 366 个点）。 */
export const USAGE_MAX_RANGE_DAYS = 366
