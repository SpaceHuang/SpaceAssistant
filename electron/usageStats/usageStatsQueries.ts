import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import {
  calculateAttributionCoverage,
  emptyTurnToolDimension,
  hasAttributionWeights,
  normalizeInputAttribution,
  type StepAttributionJson,
  type TurnToolDimension,
  type ToolSourceClass
} from '../../src/shared/usageAttribution'
import {
  USAGE_MAX_RANGE_DAYS,
  type UsageAttributionSummary,
  type UsageDailyPoint,
  type UsageLatestAttribution,
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
function buildFilterWhere(dimensions: UsageStatsFilters | undefined, aliases: { token?: string; turn?: string } = {}): SqlFilterParams {
  const tokenConds: string[] = []
  const turnConds: string[] = []
  const tokenPrefix = aliases.token ? `${aliases.token}.` : ''
  const turnPrefix = aliases.turn ? `${aliases.turn}.` : ''
  const paramsToken: (string | null)[] = []
  const paramsTurn: (string | null)[] = []

  const models = dimensions?.models ?? []
  if (models.length > 0) {
    const parts = models.map(() => `(${tokenPrefix}model = ? AND (? IS NULL OR ${tokenPrefix}llm_service_id = ?))`)
    const turnParts = models.map(() => `(${turnPrefix}model = ? AND (? IS NULL OR ${turnPrefix}llm_service_id = ?))`)
    tokenConds.push(`(${parts.join(' OR ')})`)
    turnConds.push(`(${turnParts.join(' OR ')})`)
    for (const m of models) {
      const values = [m.model, m.llmServiceId ?? null, m.llmServiceId ?? null]
      paramsToken.push(...values)
      paramsTurn.push(...values)
    }
  }
  const sessionIds = dimensions?.sessionIds ?? []
  if (sessionIds.length > 0) {
    tokenConds.push(`${tokenPrefix}session_id IN (${sessionIds.map(() => '?').join(', ')})`)
    turnConds.push(`${turnPrefix}session_id IN (${sessionIds.map(() => '?').join(', ')})`)
    paramsToken.push(...sessionIds)
    paramsTurn.push(...sessionIds)
  }
  const appVersions = dimensions?.appVersions ?? []
  if (appVersions.length > 0) {
    tokenConds.push(`${tokenPrefix}app_version IN (${appVersions.map(() => '?').join(', ')})`)
    turnConds.push(`${turnPrefix}app_version IN (${appVersions.map(() => '?').join(', ')})`)
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

type AttributionSqlRow = {
  day: string
  sessionId: string
  turnId: string
  stepId: string
  inputTokens: number | null
  attributionJson: string | null
  estimatorVersion: string | null
  systemTokens: number | null
  toolsTokens: number | null
  messageTokens: number | null
}

function parseRecordJson(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

function addNumericRecord(target: Record<string, number>, source: unknown): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) target[key] = (target[key] ?? 0) + raw
  }
}

function aggregateToolDimensions(rows: readonly { toolAttributionJson: string | null }[]): UsageAttributionSummary['toolDimensions'] {
  const result: TurnToolDimension = emptyTurnToolDimension()
  for (const row of rows) {
    const json = parseRecordJson(row.toolAttributionJson)
    if (!json) continue
    addNumericRecord(result.tools, json.tools)
    addNumericRecord(result.toolSource, json.toolSource)
    if (json.toolSources && typeof json.toolSources === 'object' && !Array.isArray(json.toolSources)) {
      for (const [name, source] of Object.entries(json.toolSources)) {
        if (source === 'builtin' || source === 'mcp' || source === 'skill' || source === 'other') result.toolSources[name] = source as ToolSourceClass
      }
    }
    if (json.toolResults && typeof json.toolResults === 'object' && !Array.isArray(json.toolResults)) {
      for (const [name, raw] of Object.entries(json.toolResults)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const value = raw as { calls?: unknown; chars?: unknown }
        if (typeof value.calls !== 'number' || !Number.isFinite(value.calls) || value.calls < 0 || typeof value.chars !== 'number' || !Number.isFinite(value.chars) || value.chars < 0) continue
        const total = result.toolResults[name] ?? { calls: 0, chars: 0 }
        total.calls += value.calls
        total.chars += value.chars
        result.toolResults[name] = total
      }
    }
  }
  return result
}

/** Cross-session input attribution and turn tool dimensions, using the exact summary filters and composite ownership keys. */
export function queryUsageAttribution(db: AppDatabase, args: UsageStatsRangeArgs): UsageAttributionSummary {
  const { whereToken, whereTurn, paramsToken, paramsTurn } = buildFilterWhere(args.dimensions)
  const conn = getDbConnection(db)
  const rows = conn.prepare(
    `SELECT day, session_id AS sessionId, turn_id AS turnId, step_id AS stepId,
            input_tokens AS inputTokens, attribution_json AS attributionJson, estimator_version AS estimatorVersion,
            system_tokens AS systemTokens, tools_tokens AS toolsTokens, message_tokens AS messageTokens
     FROM usage_step_facts
     WHERE day >= ? AND day <= ?${whereToken}
     ORDER BY session_id, turn_id, step_id`
  ).all(args.from, args.to, ...paramsToken) as AttributionSqlRow[]

  const summary = queryUsageSummary(db, args)
  const coverage = calculateAttributionCoverage(rows.map((row) => ({
    inputTokens: row.inputTokens,
    attributionJson: row.attributionJson,
    estimatorVersion: row.estimatorVersion
  })))
  if (coverage.exactInputTokens !== summary.inputTokens) throw new Error('USAGE_ATTRIBUTION_FILTERED_INPUT_TOTAL_MISMATCH')

  const versions = new Map<string, UsageAttributionSummary['byEstimatorVersion'][number]>()
  const dailyVersions = new Map<string, UsageAttributionSummary['dailyByEstimatorVersion'][number]>()
  for (const row of rows) {
    if (row.inputTokens === null || row.attributionJson === null || !row.estimatorVersion) continue
    const json = parseRecordJson(row.attributionJson) as StepAttributionJson | undefined
    if (!json || !hasAttributionWeights(json)) continue
    const attribution = {
      ...json,
      threeSources: {
        systemTokens: row.systemTokens ?? 0,
        toolsTokens: row.toolsTokens ?? 0,
        messageTokens: row.messageTokens ?? 0,
        estimatorVersion: row.estimatorVersion
      }
    }
    const normalized = normalizeInputAttribution(attribution, row.inputTokens)
    const version = versions.get(row.estimatorVersion) ?? {
      estimatorVersion: row.estimatorVersion,
      attributableInputTokens: 0,
      unattributedInputTokens: 0,
      coverageRatio: null,
      composition: { system: 0, tools: 0, messageBlocks: {} }
    }
    version.attributableInputTokens += row.inputTokens
    version.composition.system += normalized.system
    version.composition.tools += normalized.tools
    for (const [key, value] of Object.entries(normalized.messageBlocks)) version.composition.messageBlocks[key] = (version.composition.messageBlocks[key] ?? 0) + value
    versions.set(row.estimatorVersion, version)
    const dailyKey = `${row.day}\u0000${row.estimatorVersion}`
    const daily = dailyVersions.get(dailyKey) ?? {
      day: row.day, estimatorVersion: row.estimatorVersion, inputTokens: 0,
      composition: { system: 0, tools: 0, messageBlocks: {} }
    }
    daily.inputTokens += row.inputTokens
    daily.composition.system += normalized.system
    daily.composition.tools += normalized.tools
    for (const [key, value] of Object.entries(normalized.messageBlocks)) daily.composition.messageBlocks[key] = (daily.composition.messageBlocks[key] ?? 0) + value
    dailyVersions.set(dailyKey, daily)
  }
  for (const coverageGroup of coverage.byEstimatorVersion) {
    const version = versions.get(coverageGroup.estimatorVersion)
    if (version) {
      version.unattributedInputTokens = coverageGroup.unattributedInputTokens
      version.coverageRatio = coverageGroup.coverageRatio
    }
  }

  const { whereTurn: whereTurnAliased, paramsTurn: paramsTurnAliased } = buildFilterWhere(args.dimensions, { turn: 't' })
  const turnRows = conn.prepare(
    `SELECT t.tool_attribution_json AS toolAttributionJson
     FROM usage_turn_facts t
     INNER JOIN (
       SELECT DISTINCT session_id, turn_id FROM usage_step_facts
       WHERE day >= ? AND day <= ?${whereToken}
     ) selected ON selected.session_id = t.session_id AND selected.turn_id = t.turn_id
     WHERE t.day >= ? AND t.day <= ?${whereTurnAliased}`
  ).all(args.from, args.to, ...paramsToken, args.from, args.to, ...paramsTurnAliased) as Array<{ toolAttributionJson: string | null }>

  return {
    exactInputTokens: summary.inputTokens,
    byEstimatorVersion: [...versions.values()].sort((a, b) => a.estimatorVersion.localeCompare(b.estimatorVersion)),
    dailyByEstimatorVersion: [...dailyVersions.values()].sort((a, b) => a.day.localeCompare(b.day) || a.estimatorVersion.localeCompare(b.estimatorVersion)),
    toolDimensions: aggregateToolDimensions(turnRows)
  }
}

/** Latest attributable exact step for one session, identified by the persisted session/turn/step key. */
export function queryLatestUsageAttribution(db: AppDatabase, sessionId: string): UsageLatestAttribution | null {
  const conn = getDbConnection(db)
  const row = conn.prepare(
    `SELECT input_tokens AS inputTokens, attribution_json AS attributionJson, estimator_version AS estimatorVersion,
            system_tokens AS systemTokens, tools_tokens AS toolsTokens, message_tokens AS messageTokens
     FROM usage_step_facts
     WHERE session_id = ? AND input_tokens IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).get(sessionId) as AttributionSqlRow | undefined
  if (!row || row.inputTokens === null || !row.estimatorVersion || row.attributionJson === null) return null
  const json = parseRecordJson(row.attributionJson)
  if (!json || !hasAttributionWeights(json)) return null
  const normalized = normalizeInputAttribution({
    ...json,
    threeSources: {
      systemTokens: row.systemTokens ?? 0,
      toolsTokens: row.toolsTokens ?? 0,
      messageTokens: row.messageTokens ?? 0,
      estimatorVersion: row.estimatorVersion
    }
  } as StepAttributionJson & { threeSources: { systemTokens: number; toolsTokens: number; messageTokens: number; estimatorVersion: string } }, row.inputTokens)
  return {
    exactInputTokens: row.inputTokens,
    estimatorVersion: row.estimatorVersion,
    attributableInputTokens: row.inputTokens,
    unattributedInputTokens: 0,
    coverageRatio: 1,
    composition: normalized
  }
}
