import { getConfigValue, setConfigValue } from '../database/operations'
import type { AppDatabase } from '../database'
import { deleteUsageFactsBeforeDay, listOrphanUsageTurns, upsertUsageTurnFact } from '../database/operations'
import type { UsageFactsCleanupResult } from '../database/operations'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { localDayString, type UsageTurnOutcome } from './usageStatsRecorder'
import {
  DEFAULT_USAGE_RETENTION_DAYS,
  USAGE_RETENTION_DAYS_VALUES,
  type UsageRetentionDays
} from '../../src/shared/usageStatsTypes'

const RETENTION_CONFIG_KEY = 'config.usageStatsRetentionDays'

/** 读取保留期配置（C8）；缺省 / 非法值回退默认 365 天。 */
export function readUsageRetentionDays(db: AppDatabase): UsageRetentionDays {
  const raw = getConfigValue(db, RETENTION_CONFIG_KEY)
  return isRetentionValue(raw) ? raw : DEFAULT_USAGE_RETENTION_DAYS
}

export function writeUsageRetentionDays(db: AppDatabase, value: UsageRetentionDays): void {
  setConfigValue(db, RETENTION_CONFIG_KEY, value)
}

function isRetentionValue(value: string | undefined): value is UsageRetentionDays {
  return value !== undefined && (USAGE_RETENTION_DAYS_VALUES as readonly string[]).includes(value)
}

/**
 * 启动时按保留期清理（C8：按天、删除留痕）。
 * 返回 null 表示「永久保留」跳过；否则返回删除行数与日期区间供留痕日志。
 */
export function cleanupUsageFactsByRetention(db: AppDatabase, now = Date.now()): UsageFactsCleanupResult | null {
  const retention = readUsageRetentionDays(db)
  if (retention === 'forever') return null
  const retentionDays = Number(retention)
  // 保留最近 N 个自然日（含今天）：删除 day < today-(N-1)
  const cutoff = shiftDay(localDayString(now), -(retentionDays - 1))
  const result = deleteUsageFactsBeforeDay(db, cutoff)
  if (result.deletedStepRows > 0 || result.deletedTurnRows > 0) {
    logAgentEvent('info', 'usageStats.retention.cleaned', {
      retentionDays,
      cutoffExclusive: cutoff,
      deletedStepRows: result.deletedStepRows,
      deletedTurnRows: result.deletedTurnRows,
      earliestDeletedDay: result.earliestDeletedDay,
      latestDeletedDay: result.latestDeletedDay
    })
  }
  return result
}

/** 日期字符串 + n 天（跨月/跨年由 Date 处理）。 */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + n)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayNum = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayNum}`
}

/**
 * 崩溃补齐（§7.3.1）：对「有 usage_step_facts 行、但缺 usage_turn_facts 行」的 Turn
 * 补一行 outcome='interrupted' 的汇总；工具计数不可知按 0 写入（不做推测）。
 * 返回补齐行数。
 */
export function reconcileUsageTurnFacts(db: AppDatabase): number {
  const orphans = listOrphanUsageTurns(db)
  let patched = 0
  for (const orphan of orphans) {
    const outcome: UsageTurnOutcome = 'interrupted'
    upsertUsageTurnFact(db, {
      turnId: orphan.turnId,
      sessionId: orphan.sessionId,
      createdAt: orphan.firstCreatedAt,
      day: orphan.day,
      model: orphan.model,
      llmServiceId: orphan.llmServiceId,
      appVersion: orphan.appVersion,
      stepCount: orphan.stepCount,
      toolCallCount: 0,
      toolErrorCount: 0,
      toolSkippedCount: 0,
      outcome
    })
    patched += 1
  }
  return patched
}
