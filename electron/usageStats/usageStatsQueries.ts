import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import {
  USAGE_MAX_RANGE_DAYS,
  type UsageDailyPoint,
  type UsageDimensions,
  type UsageStatsFilters,
  type UsageStatsRangeArgs,
  type UsageSummary
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
