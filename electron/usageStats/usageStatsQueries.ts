import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import type { UsageTurnFactRow } from '../database/operations'
import { normalizeInputAttribution, normalizeOutputAttribution, type NormalizedInputAttribution, type StepAttributionJson } from '../../src/shared/usageAttribution'
import {
  USAGE_MAX_RANGE_DAYS,
  type UsageAttributionCategory,
  type UsageAttributionComposition,
  type UsageAttributionDailyPoint,
  type UsageAttributionOutputSplit,
  type UsageAttributionRangeArgs,
  type UsageDailyPoint,
  type UsageDimensions,
  type UsageStatsFilters,
  type UsageStatsRangeArgs,
  type UsageSummary,
  type UsageToolAttributionBreakdown,
  type UsageToolAttributionEntry
} from '../../src/shared/usageStatsTypes'

/** 本地自然日 + n 天（用于跨度截断与日期遍历；跨月/跨年由 Date 处理）。 */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + n)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day2 = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day2}`
}

/** 区间内的本地自然日序列（含两端），超出 366 点保护上限时截断（§5.3.2）。 */
function iterateDays(from: string, to: string): string[] {
  const days: string[] = []
  let cursor = from
  while (days.length < USAGE_MAX_RANGE_DAYS) {
    days.push(cursor)
    if (cursor >= to) break
    cursor = addDays(cursor, 1)
  }
  return days
}

type SqlFilterParams = {
  whereToken: string
  whereTurn: string
  paramsToken: (string | null)[]
  paramsTurn: (string | null)[]
}

/** 把 Filters 展开为两表共用的 WHERE 片段（多项之间「或」，§8.1）。 */
function buildFilterWhere(dimensions: UsageStatsFilters | undefined): SqlFilterParams {
  const tokenConds: string[] = []
  const turnConds: string[] = []
  const paramsToken: (string | null)[] = []
  const paramsTurn: (string | null)[] = []

  const models = dimensions?.models ?? []
  if (models.length > 0) {
    const parts = models.map(() => '(model = ? AND (? IS NULL OR llm_service_id = ?))')
    tokenConds.push(`(${parts.join(' OR ')})`)
    turnConds.push(`(${parts.join(' OR ')})`)
    for (const m of models) {
      const values = [m.model, m.llmServiceId ?? null, m.llmServiceId ?? null]
      paramsToken.push(...values)
      paramsTurn.push(...values)
    }
  }
  const sessionIds = dimensions?.sessionIds ?? []
  if (sessionIds.length > 0) {
    tokenConds.push(`session_id IN (${sessionIds.map(() => '?').join(', ')})`)
    turnConds.push(`session_id IN (${sessionIds.map(() => '?').join(', ')})`)
    paramsToken.push(...sessionIds)
    paramsTurn.push(...sessionIds)
  }
  const appVersions = dimensions?.appVersions ?? []
  if (appVersions.length > 0) {
    tokenConds.push(`app_version IN (${appVersions.map(() => '?').join(', ')})`)
    turnConds.push(`app_version IN (${appVersions.map(() => '?').join(', ')})`)
    paramsToken.push(...appVersions)
    paramsTurn.push(...appVersions)
  }

  return {
    whereToken: tokenConds.length > 0 ? ` AND ${tokenConds.join(' AND ')}` : '',
    whereTurn: turnConds.length > 0 ? ` AND ${turnConds.join(' AND ')}` : '',
    paramsToken,
    paramsTurn
  }
}

type TokenAggRow = {
  day: string
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
}

type TurnAggRow = {
  day: string
  toolCallCount: number | null
  toolErrorCount: number | null
  toolSkippedCount: number | null
  turnCount: number | null
  stepCount: number | null
}

function numberValue(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 方案 B 命中率：cacheRead / (input − cacheCreation)；分母 ≤ 0 时 null（§2.5）。 */
function hitRateOf(inputTokens: number, cacheCreationTokens: number, cacheReadTokens: number): number | null {
  const denominator = inputTokens - cacheCreationTokens
  return denominator > 0 ? cacheReadTokens / denominator : null
}

export function queryUsageDaily(db: AppDatabase, args: UsageStatsRangeArgs): UsageDailyPoint[] {
  const { whereToken, whereTurn, paramsToken, paramsTurn } = buildFilterWhere(args.dimensions)
  const conn = getDbConnection(db)

  const tokenRows = conn
    .prepare(
      `SELECT day,
              SUM(input_tokens)          AS inputTokens,
              SUM(output_tokens)         AS outputTokens,
              SUM(cache_read_tokens)     AS cacheReadTokens,
              SUM(cache_creation_tokens) AS cacheCreationTokens
       FROM usage_step_facts
       WHERE day >= ? AND day <= ?${whereToken}
       GROUP BY day`
    )
    .all(args.from, args.to, ...paramsToken) as TokenAggRow[]

  const turnRows = conn
    .prepare(
      `SELECT day,
              SUM(tool_call_count)    AS toolCallCount,
              SUM(tool_error_count)   AS toolErrorCount,
              SUM(tool_skipped_count) AS toolSkippedCount,
              COUNT(*)                AS turnCount,
              SUM(step_count)         AS stepCount
       FROM usage_turn_facts
       WHERE day >= ? AND day <= ?${whereTurn}
       GROUP BY day`
    )
    .all(args.from, args.to, ...paramsTurn) as TurnAggRow[]

  const tokenByDay = new Map(tokenRows.map((row) => [row.day, row]))
  const turnByDay = new Map(turnRows.map((row) => [row.day, row]))

  return iterateDays(args.from, args.to).map((day) => {
    const token = tokenByDay.get(day)
    const turnAgg = turnByDay.get(day)
    const inputTokens = numberValue(token?.inputTokens)
    const outputTokens = numberValue(token?.outputTokens)
    const cacheReadTokens = numberValue(token?.cacheReadTokens)
    const cacheCreationTokens = numberValue(token?.cacheCreationTokens)
    const turnCount = numberValue(turnAgg?.turnCount)
    const stepCount = numberValue(turnAgg?.stepCount)
    return {
      day,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      hitRate: hitRateOf(inputTokens, cacheCreationTokens, cacheReadTokens),
      toolCallCount: numberValue(turnAgg?.toolCallCount),
      toolErrorCount: numberValue(turnAgg?.toolErrorCount),
      toolSkippedCount: numberValue(turnAgg?.toolSkippedCount),
      turnCount,
      stepCount,
      avgStepsPerTurn: turnCount > 0 ? stepCount / turnCount : null
    }
  })
}

export function queryUsageSummary(db: AppDatabase, args: UsageStatsRangeArgs): UsageSummary {
  const { whereToken, whereTurn, paramsToken, paramsTurn } = buildFilterWhere(args.dimensions)
  const conn = getDbConnection(db)

  const tokenRow = conn
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0)          AS inputTokens,
              COALESCE(SUM(output_tokens), 0)         AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens
       FROM usage_step_facts
       WHERE day >= ? AND day <= ?${whereToken}`
    )
    .get(args.from, args.to, ...paramsToken) as {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }

  const turnRow = conn
    .prepare(
      `SELECT COALESCE(SUM(tool_call_count), 0)    AS toolCallCount,
              COALESCE(SUM(tool_error_count), 0)   AS toolErrorCount,
              COALESCE(SUM(tool_skipped_count), 0) AS toolSkippedCount,
              COUNT(*)                             AS turnCount,
              COALESCE(SUM(step_count), 0)         AS stepCount
       FROM usage_turn_facts
       WHERE day >= ? AND day <= ?${whereTurn}`
    )
    .get(args.from, args.to, ...paramsTurn) as {
    toolCallCount: number
    toolErrorCount: number
    toolSkippedCount: number
    turnCount: number
    stepCount: number
  }

  const hitRate = hitRateOf(tokenRow.inputTokens, tokenRow.cacheCreationTokens, tokenRow.cacheReadTokens)
  return {
    totalTokens: tokenRow.inputTokens + tokenRow.outputTokens,
    inputTokens: tokenRow.inputTokens,
    outputTokens: tokenRow.outputTokens,
    cacheReadTokens: tokenRow.cacheReadTokens,
    cacheCreationTokens: tokenRow.cacheCreationTokens,
    hitRate,
    toolCallCount: turnRow.toolCallCount,
    toolErrorCount: turnRow.toolErrorCount,
    toolSkippedCount: turnRow.toolSkippedCount,
    toolErrorRate: turnRow.toolCallCount > 0 ? turnRow.toolErrorCount / turnRow.toolCallCount : null,
    turnCount: turnRow.turnCount,
    stepCount: turnRow.stepCount,
    avgStepsPerTurn: turnRow.turnCount > 0 ? turnRow.stepCount / turnRow.turnCount : null
  }
}

export function queryUsageDimensions(db: AppDatabase): UsageDimensions {
  const conn = getDbConnection(db)

  const modelRows = conn
    .prepare(
      `SELECT DISTINCT model, llm_service_id AS llmServiceId
       FROM usage_step_facts
       WHERE model IS NOT NULL
       ORDER BY model, llm_service_id`
    )
    .all() as Array<{ model: string; llmServiceId: string | null }>

  const versionRows = conn
    .prepare(
      `SELECT DISTINCT app_version
       FROM usage_step_facts
       WHERE app_version IS NOT NULL
       ORDER BY app_version`
    )
    .all() as Array<{ app_version: string }>

  // 会话枚举取自两表 distinct session_id（跨 workDir 全量）；已删除会话 name 为 null。
  const sessionRows = conn
    .prepare(
      `SELECT session_id AS sessionId, MAX(sessions.name) AS name
       FROM (
         SELECT DISTINCT s.session_id, NULL AS alias_name FROM usage_step_facts s
         UNION
         SELECT DISTINCT t.session_id, NULL AS alias_name FROM usage_turn_facts t
       )
       LEFT JOIN sessions ON sessions.id = session_id
       -- 中2（评审）：内部/隐藏会话（审批 Agent、automation 内部会话）不进筛选下拉
       WHERE (sessions.ownership IS NULL OR sessions.ownership != 'internal')
         AND (sessions.visibility IS NULL OR sessions.visibility != 'hidden')
       GROUP BY session_id
       ORDER BY session_id`
    )
    .all() as Array<{ sessionId: string; name: string | null }>

  return {
    models: modelRows.map((row) => ({ model: row.model, llmServiceId: row.llmServiceId ?? undefined })),
    sessions: sessionRows.map((row) => ({ sessionId: row.sessionId, name: row.name ?? null })),
    appVersions: versionRows.map((row) => row.app_version)
  }
}

// ---------- 归因查询（agent-token-usage-content-attribution §6.6）----------

function emptyCategories(): Record<UsageAttributionCategory, number> {
  return { system: 0, tools: 0, userText: 0, assistantText: 0, toolResults: 0, assistantThinking: 0, assistantToolUse: 0, other: 0 }
}

/** 骨架键 → 展示类别（SRC-C3 的归并口径）。 */
function categorizeBlockKey(key: string): UsageAttributionCategory {
  if (key === 'user|text') return 'userText'
  if (key === 'assistant|text') return 'assistantText'
  if (key === 'user|tool_result') return 'toolResults'
  if (key === 'assistant|thinking') return 'assistantThinking'
  if (key === 'assistant|tool_use') return 'assistantToolUse'
  return 'other'
}

function parseAttribution(row: AttributionRow): StepAttributionJson | null {
  if (!row.attribution_json) return null
  try {
    const parsed = JSON.parse(row.attribution_json) as StepAttributionJson
    return parsed && typeof parsed === 'object' && parsed.blocks ? parsed : null
  } catch {
    return null
  }
}

type AttributionRow = {
  day: string
  input_tokens: number
  output_tokens: number
  /** 三源真列（SRC-A* 权重，block-v1 落库） */
  system_tokens: number | null
  tools_tokens: number | null
  estimator_version: string | null
  attribution_json: string | null
}

function fetchAttributionRows(db: AppDatabase, args: UsageAttributionRangeArgs): AttributionRow[] {
  const { whereToken, paramsToken } = buildFilterWhere(args.dimensions)
  const conn = getDbConnection(db)
  return conn
    .prepare(
      `SELECT day, input_tokens, output_tokens, system_tokens, tools_tokens, estimator_version, attribution_json
       FROM usage_step_facts
       WHERE day >= ? AND day <= ?${whereToken}
       ORDER BY created_at, id`
    )
    .all(args.from, args.to, ...paramsToken) as AttributionRow[]
}

function coverageOf(attributable: number, total: number): number | null {
  return total > 0 ? attributable / total : null
}

/**
 * 单行输入侧归一化（§6.3 两段式）：权重 = 三源真列（system/tools）+ 骨架块 tokens（messages），
 * 精确总量 = 该行 input_tokens；版本不一致或无归因 JSON 时返回 null（该行仅留在分母）。
 */
function normalizeRowInput(row: AttributionRow, estimatorVersion: string): NormalizedInputAttribution | null {
  if (row.estimator_version !== estimatorVersion) return null
  const attribution = parseAttribution(row)
  if (!attribution) return null
  return normalizeInputAttribution(
    {
      ...attribution,
      threeSources: {
        systemTokens: numberValue(row.system_tokens),
        toolsTokens: numberValue(row.tools_tokens),
        messageTokens: 0,
        estimatorVersion
      }
    },
    numberValue(row.input_tokens)
  )
}

function normalizeRowOutput(row: AttributionRow, estimatorVersion: string): { thinking: number; text: number; toolUseArgs: number } | null {
  if (row.estimator_version !== estimatorVersion) return null
  const attribution = parseAttribution(row)
  if (!attribution) return null
  return normalizeOutputAttribution(
    { ...attribution, threeSources: { systemTokens: 0, toolsTokens: 0, messageTokens: 0, estimatorVersion } },
    numberValue(row.output_tokens)
  )
}

/**
 * 构成快照（视图①，口径 A）。每行独立做 §6.3 两段式归一化（分子分母同请求、同版本，I1），
 * 归一化后再跨行累加——可归面子集的 Σcategories == attributableInputTokens（AT7/AT14）。
 * 版本不一致或无归因数据的行留在分母、不进分子（AT8/AT16/I7）。
 */
export function queryAttributionComposition(db: AppDatabase, args: UsageAttributionRangeArgs): UsageAttributionComposition {
  const rows = fetchAttributionRows(db, args)
  const categories = emptyCategories()
  let attributableInputTokens = 0
  let totalInputTokens = 0
  for (const row of rows) {
    totalInputTokens += numberValue(row.input_tokens)
    const normalized = normalizeRowInput(row, args.estimatorVersion)
    if (!normalized) continue
    categories.system += normalized.system
    categories.tools += normalized.tools
    for (const [key, tokens] of Object.entries(normalized.messageBlocks)) {
      categories[categorizeBlockKey(key)] += tokens
    }
    attributableInputTokens += numberValue(row.input_tokens)
  }
  return {
    estimatorVersion: args.estimatorVersion,
    attributableInputTokens,
    totalInputTokens,
    attributionCoverage: coverageOf(attributableInputTokens, totalInputTokens),
    categories
  }
}

/** 构成漂移（视图②）：按天的构成快照，恒等式逐天成立。 */
export function queryAttributionDaily(db: AppDatabase, args: UsageAttributionRangeArgs): UsageAttributionDailyPoint[] {
  const rows = fetchAttributionRows(db, args)
  const byDay = new Map<string, UsageAttributionDailyPoint>()
  for (const day of iterateDays(args.from, args.to)) {
    byDay.set(day, { day, categories: emptyCategories(), attributableInputTokens: 0, totalInputTokens: 0 })
  }
  for (const row of rows) {
    const point = byDay.get(row.day)
    if (!point) continue
    point.totalInputTokens += numberValue(row.input_tokens)
    const normalized = normalizeRowInput(row, args.estimatorVersion)
    if (!normalized) continue
    point.categories.system += normalized.system
    point.categories.tools += normalized.tools
    for (const [key, tokens] of Object.entries(normalized.messageBlocks)) {
      point.categories[categorizeBlockKey(key)] += tokens
    }
    point.attributableInputTokens += numberValue(row.input_tokens)
  }
  return [...byDay.values()]
}

/** 输出侧三类（SRC-D1）：按精确 output_tokens 摊回，Σcategories == attributableOutputTokens。 */
export function queryAttributionOutputSplit(db: AppDatabase, args: UsageAttributionRangeArgs): UsageAttributionOutputSplit {
  const rows = fetchAttributionRows(db, args)
  const categories = { thinking: 0, text: 0, toolUseArgs: 0 }
  let attributableOutputTokens = 0
  let totalOutputTokens = 0
  for (const row of rows) {
    totalOutputTokens += numberValue(row.output_tokens)
    const normalized = normalizeRowOutput(row, args.estimatorVersion)
    if (!normalized) continue
    categories.thinking += normalized.thinking
    categories.text += normalized.text
    categories.toolUseArgs += normalized.toolUseArgs
    attributableOutputTokens += numberValue(row.output_tokens)
  }
  return {
    estimatorVersion: args.estimatorVersion,
    attributableOutputTokens,
    totalOutputTokens,
    categories
  }
}

type ToolDimensionRow = { tool_attribution_json: string | null }

function parseToolDimension(row: ToolDimensionRow): { tools: Record<string, number>; toolSource: Record<string, number>; toolResults: Record<string, { calls: number; chars: number }> } | null {
  if (!row.tool_attribution_json) return null
  try {
    const parsed = JSON.parse(row.tool_attribution_json) as ReturnType<typeof parseToolDimension>
    return parsed && typeof parsed === 'object' && parsed.tools ? parsed : null
  } catch {
    return null
  }
}

/**
 * 工具维度明细（视图③，SRC-B2–B4 / SRC-C1–C2）：跨 turn 合并声明与返回体量。
 * 未使用 = 有声明、无调用记录（SRC-B4）；声明字符为【派生】口径，展示层不得呈现为 token（I2）。
 */
export function queryToolAttributionBreakdown(db: AppDatabase, args: UsageStatsRangeArgs): UsageToolAttributionBreakdown {
  const { whereTurn, paramsTurn } = buildFilterWhere(args.dimensions)
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      `SELECT tool_attribution_json FROM usage_turn_facts
       WHERE day >= ? AND day <= ?${whereTurn}`
    )
    .all(args.from, args.to, ...paramsTurn) as ToolDimensionRow[]

  const declaredChars = new Map<string, number>()
  const sourceByName = new Map<string, string>()
  const sourceChars = new Map<string, number>()
  const calls = new Map<string, number>()
  const resultChars = new Map<string, number>()
  for (const row of rows) {
    const dim = parseToolDimension(row)
    if (!dim) continue
    for (const [name, chars] of Object.entries(dim.tools)) {
      declaredChars.set(name, (declaredChars.get(name) ?? 0) + chars)
    }
    for (const [source, chars] of Object.entries(dim.toolSource)) {
      sourceChars.set(source, (sourceChars.get(source) ?? 0) + chars)
    }
    for (const [name, entry] of Object.entries(dim.toolResults)) {
      calls.set(name, (calls.get(name) ?? 0) + entry.calls)
      resultChars.set(name, (resultChars.get(name) ?? 0) + entry.chars)
    }
  }
  // 来源分类：toolResults/toolSource 未携带逐名来源时按名称推断（mcp_ 前缀约定，§7.3）
  const sourceOf = (name: string): string => {
    return name.startsWith('mcp_') ? 'mcp' : 'builtin'
  }
  const used: UsageToolAttributionEntry[] = []
  const unused: UsageToolAttributionEntry[] = []
  let totalDeclaredChars = 0
  let unusedDeclaredChars = 0
  // 合并声明与调用两个键集：有调用、无声明的工具（如跨 turn 声明缺失）仍计入 used，不静默丢失（I5）
  const allNames = new Set<string>([...declaredChars.keys(), ...calls.keys()])
  for (const name of allNames) {
    const chars = declaredChars.get(name) ?? 0
    totalDeclaredChars += chars
    const callCount = calls.get(name)
    const entry: UsageToolAttributionEntry = {
      name,
      source: sourceOf(name),
      declaredChars: chars,
      calls: callCount ?? null,
      resultChars: callCount != null ? (resultChars.get(name) ?? 0) : null
    }
    if (callCount != null) used.push(entry)
    else {
      unused.push(entry)
      unusedDeclaredChars += chars
    }
  }
  used.sort((a, b) => (b.resultChars ?? 0) - (a.resultChars ?? 0) || b.declaredChars - a.declaredChars)
  unused.sort((a, b) => b.declaredChars - a.declaredChars)
  return { used, unused, totalDeclaredChars, unusedDeclaredChars }
}
