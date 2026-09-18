import fs from 'fs'
import path from 'path'
import { computeTotalRequestInputTokens } from '../../src/shared/contextUsageEstimate'
import type { AppDatabase } from '../database'
import { getUsageTurnFact, insertUsageStepFact, upsertUsageTurnFact } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { localDayString } from './usageStatsRecorder'

export type UsageBackfillResult = {
  scannedSessionDirs: number
  stepRowsWritten: number
  turnRowsWritten: number
  skippedMalformedFiles: number
}

type TurnAccumulator = {
  firstTime: number
  toolResultCount: number
  toolErrorCount: number
  toolSkippedCount: number
  hasCleanTurnEnd: boolean
}

const TURN_EXEC_CONFIG_SQL =
  'SELECT execution_config_json FROM turns WHERE session_id = ? AND turn_id = ?'
const SESSION_MODEL_SQL = 'SELECT model FROM sessions WHERE id = ?'

function readExecConfig(
  conn: ReturnType<typeof getDbConnection>,
  sessionId: string,
  turnId: string
): { model?: string; llmServiceId?: string } | undefined {
  try {
    const row = conn.prepare(TURN_EXEC_CONFIG_SQL).get(sessionId, turnId) as
      | { execution_config_json: string | null }
      | undefined
    if (!row?.execution_config_json) return undefined
    const parsed = JSON.parse(row.execution_config_json) as { model?: unknown; llmServiceId?: unknown }
    return {
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.llmServiceId === 'string' ? { llmServiceId: parsed.llmServiceId } : {})
    }
  } catch {
    return undefined
  }
}

function readSessionModelFallback(conn: ReturnType<typeof getDbConnection>, sessionId: string): string | undefined {
  try {
    const row = conn.prepare(SESSION_MODEL_SQL).get(sessionId) as { model: string } | undefined
    return row?.model
  } catch {
    return undefined
  }
}

/** 台账行的宽松校验（坏行跳过；与 parseSessionEvent 的结构约束一致）。 */
function parseLedgerLine(line: string): { type: string; time: number; payload: Record<string, unknown> } | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (
      value &&
      typeof value.type === 'string' &&
      typeof value.time === 'number' &&
      value.payload &&
      typeof value.payload === 'object'
    ) {
      return { type: value.type, time: value.time, payload: value.payload as Record<string, unknown> }
    }
  } catch {
    /* 坏行跳过 */
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * 一次性历史回填（C7，§7.4）：扫描各 workDir 的 `sessions/<id>-<date>/events.jsonl`，
 * 从 `request_usage` / `tool_call` / `tool_result` 重建两张用量事实表。
 *
 * 已知局限（须在界面标注，不做数据造假）：
 * - 台账按会话数量清理，只覆盖「台账尚存的会话」，时间轴存在断层；
 * - `app_version` 统一标记 `unknown`；
 * - 旧台账无法区分「拒绝」与「执行失败」，拒绝会计入 tool_error_count（新采集数据不受影响）；
 * - 远程（飞书 / 微信）回合不落台账，回填天然为零；butler 历史 turnId 是会话 ID 占位。
 *
 * 幂等：step 行按 UNIQUE 键覆盖；turn 行**只在不存在时写入** —— 实时统计行
 * （内存变量判定，能区分未执行 / 执行失败）优先于台账重算。
 */
export function backfillUsageStats(db: AppDatabase, workDirs: string[]): UsageBackfillResult {
  const conn = getDbConnection(db)
  const result: UsageBackfillResult = {
    scannedSessionDirs: 0,
    stepRowsWritten: 0,
    turnRowsWritten: 0,
    skippedMalformedFiles: 0
  }
  // (sessionId:turnId) → 冻存执行配置，避免逐事件重复查询
  const execConfigCache = new Map<string, { model?: string; llmServiceId?: string } | undefined>()

  const resolveModelFields = (sessionId: string, turnId: string): { model?: string; llmServiceId?: string } => {
    const cacheKey = `${sessionId}:${turnId}`
    if (!execConfigCache.has(cacheKey)) {
      execConfigCache.set(cacheKey, readExecConfig(conn, sessionId, turnId))
    }
    const frozen = execConfigCache.get(cacheKey)
    if (frozen?.model || frozen?.llmServiceId) return frozen
    return { ...(frozen ?? {}), ...(frozen?.model ? {} : { model: readSessionModelFallback(conn, sessionId) }) }
  }

  for (const workDir of workDirs) {
    const sessionsRoot = path.join(workDir, 'sessions')
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionDir = path.join(sessionsRoot, entry.name)
      const eventsPath = path.join(sessionDir, 'events.jsonl')
      if (!fs.existsSync(eventsPath)) continue

      // 目录名 `{sessionId}-{YYYYMMDD}` → 前 36 位是 UUID（§7.4 回填要点）
      const sessionId = entry.name.slice(0, 36)

      let text: string
      try {
        text = fs.readFileSync(eventsPath, 'utf8')
      } catch {
        result.skippedMalformedFiles += 1
        continue
      }
      result.scannedSessionDirs += 1

      const turns = new Map<string, TurnAccumulator>()
      const toolCallTurnByToolUseId = new Map<string, string>()

      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const event = parseLedgerLine(line)
        if (!event) continue
        const payload = event.payload

        if (event.type === 'request_usage') {
          const turnId = typeof payload.turnId === 'string' ? payload.turnId : ''
          const stepId = typeof payload.requestId === 'string' ? payload.requestId : ''
          const usage = isRecord(payload.usage) ? payload.usage : undefined
          if (!turnId || !stepId || !usage) continue
          // 纯聊天回合（无任何 tool_result）也要有 turn 条目，否则 Turn 数缺失
          if (!turns.has(turnId)) {
            turns.set(turnId, {
              firstTime: event.time,
              toolResultCount: 0,
              toolErrorCount: 0,
              toolSkippedCount: 0,
              hasCleanTurnEnd: false
            })
          }
          const modelFields = resolveModelFields(sessionId, turnId)
          const cacheSemantics =
            typeof usage.cacheSemantics === 'string' ? usage.cacheSemantics : undefined
          insertUsageStepFact(db, {
            sessionId,
            turnId,
            stepId,
            createdAt: event.time,
            day: localDayString(event.time),
            model: modelFields.model ?? null,
            llmServiceId: modelFields.llmServiceId ?? null,
            appVersion: 'unknown',
            inputTokens: computeTotalRequestInputTokens({
              input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
              cache_read_input_tokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
              cache_creation_input_tokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
              ...(cacheSemantics ? { cacheSemantics: cacheSemantics as 'additive' | 'subset' } : {})
            }),
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
            cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
            cacheCreationTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
            cacheSemantics: cacheSemantics ?? null,
            source: 'api'
          })
          result.stepRowsWritten += 1
          continue
        }

        if (event.type === 'tool_call') {
          const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : ''
          const turnId = typeof payload.turnId === 'string' ? payload.turnId : ''
          if (toolUseId && turnId) toolCallTurnByToolUseId.set(toolUseId, turnId)
          continue
        }

        if (event.type === 'tool_result') {
          // 终态基准：只有落了 tool_result 的调用计入 tool_call_count；
          // synthetic 结果无 turnId，按 toolUseId 关联同会话 tool_call 归因（§2.4.0）。
          const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : ''
          const turnId =
            typeof payload.turnId === 'string' && payload.turnId
              ? payload.turnId
              : (toolUseId ? toolCallTurnByToolUseId.get(toolUseId) : undefined)
          if (!turnId) continue
          const synthetic = payload.synthetic === true
          const turnAcc = turns.get(turnId) ?? {
            firstTime: event.time,
            toolResultCount: 0,
            toolErrorCount: 0,
            toolSkippedCount: 0,
            hasCleanTurnEnd: false
          }
          turnAcc.toolResultCount += 1
          const resultObj = isRecord(payload.result) ? payload.result : undefined
          if (synthetic) {
            // 崩溃恢复合成的终态：计入「未执行」（§2.4.0）
            turnAcc.toolSkippedCount += 1
          } else if (resultObj?.notExecuted === true) {
            turnAcc.toolSkippedCount += 1
          } else if (resultObj && resultObj.success === false) {
            // 旧台账无 notExecuted 标记：拒绝与失败形状相同，按局限声明归执行失败
            turnAcc.toolErrorCount += 1
          }
          turns.set(turnId, turnAcc)
          continue
        }

        if (event.type === 'turn_end') {
          const turnId = typeof payload.turnId === 'string' ? payload.turnId : ''
          if (!turnId) continue
          const turnAcc = turns.get(turnId) ?? {
            firstTime: event.time,
            toolResultCount: 0,
            toolErrorCount: 0,
            toolSkippedCount: 0,
            hasCleanTurnEnd: false
          }
          if (payload.reason === 'interrupted') {
            turnAcc.hasCleanTurnEnd = false
          } else {
            turnAcc.hasCleanTurnEnd = true
          }
          turns.set(turnId, turnAcc)
        }
      }

      for (const [turnId, acc] of turns) {
        // 实时统计行优先：已存在的 turn 行不覆盖（幂等重跑也因此跳过）
        if (getUsageTurnFact(db, turnId)) continue
        const stepCount = countStepFacts(db, sessionId, turnId)
        if (stepCount === 0 && acc.toolResultCount === 0) continue
        const modelFields = resolveModelFields(sessionId, turnId)
        upsertUsageTurnFact(db, {
          turnId,
          sessionId,
          createdAt: acc.firstTime,
          day: localDayString(acc.firstTime),
          model: modelFields.model ?? null,
          llmServiceId: modelFields.llmServiceId ?? null,
          appVersion: 'unknown',
          stepCount,
          toolCallCount: acc.toolResultCount,
          toolErrorCount: acc.toolErrorCount,
          toolSkippedCount: acc.toolSkippedCount,
          // 台账无 turn_end（butler / 被清理）时不臆断结果，outcome 留空
          outcome: acc.hasCleanTurnEnd ? 'completed' : null
        })
        result.turnRowsWritten += 1
      }
    }
  }
  return result
}

function countStepFacts(db: AppDatabase, sessionId: string, turnId: string): number {
  const conn = getDbConnection(db)
  const row = conn
    .prepare('SELECT COUNT(*) AS c FROM usage_step_facts WHERE session_id = ? AND turn_id = ?')
    .get(sessionId, turnId) as { c: number }
  return row.c
}
