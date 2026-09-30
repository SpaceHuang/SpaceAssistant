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

// ---------- 归因（agent-token-usage-content-attribution §6）----------

/** 归因区间查询参数：在通用区间/维度筛选之上要求指定估算器版本（I1：同报表不得混版本）。 */
export type UsageAttributionRangeArgs = UsageStatsRangeArgs & {
  estimatorVersion: string
}

/** 输入侧构成类别（SRC-A1/A2 + SRC-B5 + SRC-C3 的展示归并）。 */
export type UsageAttributionCategory =
  | 'system'
  | 'tools'
  | 'userText'
  | 'assistantText'
  | 'toolResults'
  | 'assistantThinking'
  | 'assistantToolUse'
  | 'other'

/**
 * 构成快照（视图①，口径 A：累计读取量）。
 * Σcategories == attributableInputTokens（AT7/AT14 恒等式，只对可归面子集承诺）；
 * attributionCoverage 是一等展示数字（I7），< 100% 必须显式呈现。
 */
export type UsageAttributionComposition = {
  estimatorVersion: string
  /** 可归因请求的精确输入总量（归一化目标，覆盖率的分子） */
  attributableInputTokens: number
  /** 区间全部请求的精确输入总量（分母，对齐 KPI「输入 Tokens」） */
  totalInputTokens: number
  /** 可归因 ÷ 全部；区间无请求时 null（空态，AT16） */
  attributionCoverage: number | null
  categories: Record<UsageAttributionCategory, number>
}

/** 构成漂移的单日点（视图②：按天堆叠面积图，Y 轴默认绝对量）。 */
export type UsageAttributionDailyPoint = Pick<
  UsageAttributionComposition,
  'categories' | 'attributableInputTokens' | 'totalInputTokens'
> & { day: string }

/** 输出侧三类拆分（SRC-D1；总量为协议精确 output_tokens，构成为估算归一化）。 */
export type UsageAttributionOutputSplit = {
  estimatorVersion: string
  attributableOutputTokens: number
  totalOutputTokens: number
  categories: { thinking: number; text: number; toolUseArgs: number }
}

/** 工具维度明细行（SRC-B2/B3 声明成本 + SRC-C1/C2 返回体量）。 */
export type UsageToolAttributionEntry = {
  name: string
  source: string
  /** 声明 schema 字符数（【派生】口径，非 token） */
  declaredChars: number
  /** 调用次数；未使用工具为 null */
  calls: number | null
  /** 累计返回字符数（【派生】口径，非 token）；未使用工具为 null */
  resultChars: number | null
}

/** 明细排行 + 未使用工具下钻（SRC-B4：unused = 有声明、无调用）。 */
export type UsageToolAttributionBreakdown = {
  used: UsageToolAttributionEntry[]
  unused: UsageToolAttributionEntry[]
  totalDeclaredChars: number
  unusedDeclaredChars: number
}

/** usage_step_facts 最近归因行（环构成段数据源，§6.7）：渲染端投影，单一类型来源在 shared。 */
export type UsageLatestSessionAttribution = {
  stepId: string
  turnId: string
  createdAt: number
  estimatorVersion: string | null
  systemTokens: number | null
  toolsTokens: number | null
  messageTokens: number | null
  attributionJson: string | null
}
