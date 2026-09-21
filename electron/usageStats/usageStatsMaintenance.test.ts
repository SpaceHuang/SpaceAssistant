import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

import { cleanupUsageFactsByRetention, readUsageRetentionDays, reconcileUsageTurnFacts, writeUsageRetentionDays } from './usageStatsMaintenance'
import { createMemoryAppDb } from '../database/testHelpers'
import { getUsageStepFactsForTurn, getUsageTurnFact, insertUsageStepFact, listOrphanUsageTurns, upsertUsageTurnFact } from '../database/operations'

/** 固定「今天」：2026-09-16（本地）。 */
const NOW = new Date(2026, 8, 16, 12, 0).getTime()

function step(overrides: Partial<Parameters<typeof insertUsageStepFact>[1]> = {}) {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    stepId: 'req-1:round:1',
    createdAt: NOW,
    day: '2026-09-16',
    inputTokens: 10,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    source: 'api',
    ...overrides
  }
}

describe('保留期配置', () => {
  it('默认 365 天，写入后可读回', () => {
    const db = createMemoryAppDb()
    expect(readUsageRetentionDays(db)).toBe('365')
    writeUsageRetentionDays(db, 'forever')
    expect(readUsageRetentionDays(db)).toBe('forever')
    writeUsageRetentionDays(db, '30')
    expect(readUsageRetentionDays(db)).toBe('30')
    db.close()
  })

  it('非法配置值回退默认', () => {
    const db = createMemoryAppDb()
    writeUsageRetentionDays(db, 'banana' as never)
    expect(readUsageRetentionDays(db)).toBe('365')
    db.close()
  })
})

describe('cleanupUsageFactsByRetention（按天清理 + 留痕）', () => {
  it('保留最近 N 个自然日（含今天），删除其余并返回留痕信息', () => {
    const db = createMemoryAppDb()
    writeUsageRetentionDays(db, '30')
    // 今天 2026-09-16，保留 30 天 → 保留 [2026-08-18, 2026-09-16]
    insertUsageStepFact(db, step({ turnId: 'old', stepId: 'o1', day: '2026-08-17', createdAt: new Date(2026, 7, 17).getTime() }))
    insertUsageStepFact(db, step({ turnId: 'edge', stepId: 'e1', day: '2026-08-18', createdAt: new Date(2026, 7, 18).getTime() }))
    insertUsageStepFact(db, step({ turnId: 'new', stepId: 'n1', day: '2026-09-16' }))
    upsertUsageTurnFact(db, { turnId: 'old', sessionId: 'sess-1', createdAt: new Date(2026, 7, 17).getTime(), day: '2026-08-17', stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed' })
    upsertUsageTurnFact(db, { turnId: 'new', sessionId: 'sess-1', createdAt: NOW, day: '2026-09-16', stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed' })

    const result = cleanupUsageFactsByRetention(db, NOW)
    expect(result).toEqual({
      deletedStepRows: 1,
      deletedTurnRows: 1,
      earliestDeletedDay: '2026-08-17',
      latestDeletedDay: '2026-08-17'
    })
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'old')).toHaveLength(0)
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'edge')).toHaveLength(1) // 边界日保留
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'new')).toHaveLength(1)
    expect(getUsageTurnFact(db, 'old')).toBeUndefined()
    expect(getUsageTurnFact(db, 'new')).toBeDefined()
    db.close()
  })

  it('forever 时跳过清理', () => {
    const db = createMemoryAppDb()
    writeUsageRetentionDays(db, 'forever')
    insertUsageStepFact(db, step({ turnId: 'ancient', stepId: 'a1', day: '2000-01-01', createdAt: 946684800000 }))
    expect(cleanupUsageFactsByRetention(db, NOW)).toBeNull()
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'ancient')).toHaveLength(1)
    db.close()
  })
})

describe('reconcileUsageTurnFacts（崩溃补齐）', () => {
  it('为「有 step 无 turn」的孤儿补 interrupted 行（工具计数按 0）', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, step({ turnId: 'orphan-1', stepId: 'r1', day: '2026-09-15', createdAt: new Date(2026, 8, 15, 10).getTime() }))
    insertUsageStepFact(db, step({ turnId: 'orphan-1', stepId: 'r2', day: '2026-09-15', createdAt: new Date(2026, 8, 15, 11).getTime() }))
    insertUsageStepFact(db, step({ turnId: 'done-1', stepId: 'r3' }))
    upsertUsageTurnFact(db, { turnId: 'done-1', sessionId: 'sess-1', createdAt: NOW, day: '2026-09-16', stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed' })

    const patched = reconcileUsageTurnFacts(db, NOW)
    expect(patched).toBe(1)
    expect(getUsageTurnFact(db, 'orphan-1')).toMatchObject({
      turnId: 'orphan-1',
      sessionId: 'sess-1',
      stepCount: 2,
      toolCallCount: 0,
      toolErrorCount: 0,
      toolSkippedCount: 0,
      outcome: 'interrupted',
      day: '2026-09-15'
    })
    // 已收口的 Turn 不补
    expect(listOrphanUsageTurns(db)).toHaveLength(0)
    db.close()
  })

  it('无孤儿时返回 0，且补齐后重复执行为 0（幂等）', () => {
    const db = createMemoryAppDb()
    expect(reconcileUsageTurnFacts(db, NOW)).toBe(0)
    insertUsageStepFact(db, step({ turnId: 'orphan-2', stepId: 'r1' }))
    expect(reconcileUsageTurnFacts(db, NOW)).toBe(1)
    expect(reconcileUsageTurnFacts(db, NOW)).toBe(0)
    db.close()
  })
})
