import { computeTotalRequestInputTokens } from '../../src/shared/contextUsageEstimate'
import { resolveUsageCacheSemanticsFromBaseUrl } from '../../src/shared/usageCacheSemantics'
import type { SessionUsage } from '../../src/shared/sessionUsage'
import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from '../database'
import { insertUsageStepFact, upsertUsageTurnFact } from '../database/operations'

/** 主进程启动时注入一次（app.getVersion()），写入时取快照（需求 §7.3 原则 3）。 */
let cachedAppVersion: string | undefined

export function setUsageStatsAppVersion(version: string): void {
  cachedAppVersion = version
}

/** 记录时间戳 → 本地自然日 YYYY-MM-DD（DIM1：时区固定为系统本地时区）。 */
export function localDayString(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export type UsageStepUsageInput = {
  sessionId: string
  turnId: string
  stepId: string
  usage: SessionUsage
  /** 用于 cacheSemantics 缺失时按端点推断（需求 §2.6.3） */
  baseUrl?: string
  model?: string | null
  llmServiceId?: string | null
  now?: number
}

export type UsageTurnToolCounts = {
  stepCount: number
  toolCallCount: number
  toolErrorCount: number
  toolSkippedCount: number
}

export type UsageTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'recovered' | 'interrupted'

export type TurnSummaryInput = {
  turnId: string
  sessionId: string
  outcome: UsageTurnOutcome
  counts: UsageTurnToolCounts
  model?: string | null
  llmServiceId?: string | null
  now?: number
}

/**
 * 后台异步语义的容错包装：写入失败重试 1 次，仍失败记 `usageStats.write.failed`
 * 告警并丢弃该条数据，绝不向对话链路抛错（需求 §7.3 原则 1 / §9.2）。
 */
function safeWrite(db: AppDatabase | undefined, turnId: string, stepId: string | undefined, write: () => void): void {
  if (!db) return
  try {
    write()
  } catch {
    try {
      write()
    } catch {
      logAgentEvent('warn', 'usageStats.write.failed', {
        turnId,
        ...(stepId !== undefined ? { stepId } : {})
      })
    }
  }
}

/** 每次 LLM 调用拿到 usage 后写一行 usage_step_facts（口径归一化见需求 §2.2.1）。 */
export function recordStepUsage(db: AppDatabase | undefined, input: UsageStepUsageInput): void {
  const now = input.now ?? Date.now()
  const usage = input.usage
  const cacheSemantics = usage.cacheSemantics ?? resolveUsageCacheSemanticsFromBaseUrl(input.baseUrl)
  const inputTokens = computeTotalRequestInputTokens({ ...usage, cacheSemantics })
  safeWrite(db, input.turnId, input.stepId, () => {
    insertUsageStepFact(db!, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      createdAt: now,
      day: localDayString(now),
      model: input.model ?? null,
      llmServiceId: input.llmServiceId ?? null,
      appVersion: cachedAppVersion ?? null,
      inputTokens,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheSemantics,
      source: 'api'
    })
  })
}

/** Turn 收口时写一行 usage_turn_facts（重复收口按主键覆盖，恢复/重试幂等）。 */
export function recordTurnSummary(db: AppDatabase | undefined, input: TurnSummaryInput): void {
  const now = input.now ?? Date.now()
  safeWrite(db, input.turnId, undefined, () => {
    upsertUsageTurnFact(db!, {
      turnId: input.turnId,
      sessionId: input.sessionId,
      createdAt: now,
      day: localDayString(now),
      model: input.model ?? null,
      llmServiceId: input.llmServiceId ?? null,
      appVersion: cachedAppVersion ?? null,
      stepCount: input.counts.stepCount,
      toolCallCount: input.counts.toolCallCount,
      toolErrorCount: input.counts.toolErrorCount,
      toolSkippedCount: input.counts.toolSkippedCount,
      outcome: input.outcome
    })
  })
}
