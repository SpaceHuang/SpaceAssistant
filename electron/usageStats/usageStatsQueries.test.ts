import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, insertUsageStepFact, upsertUsageTurnFact } from '../database/operations'
import type { AppDatabase } from '../database'
import { queryUsageDaily, queryUsageDimensions, queryUsageSummary } from './usageStatsQueries'

function step(overrides: Parameters<typeof insertUsageStepFact>[1] extends never ? never : Partial<Parameters<typeof insertUsageStepFact>[1]> & { sessionId?: string }) {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    stepId: 'req-1:round:1',
    createdAt: 0,
    day: '2026-09-15',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    source: 'api',
    ...overrides
  }
}

function turn(overrides: Partial<Parameters<typeof upsertUsageTurnFact>[1]> = {}) {
  return {
    turnId: 'turn-1',
    sessionId: 'sess-1',
    createdAt: 0,
    day: '2026-09-15',
    stepCount: 1,
    toolCallCount: 0,
    toolErrorCount: 0,
    toolSkippedCount: 0,
    outcome: 'completed',
    ...overrides
  }
}

describe('queryUsageDaily 每日序列', () => {
  let db: AppDatabase
  beforeEach(() => {
    db = createMemoryAppDb()
  })

  it('按天聚合 token 与命中率（方案 B：分母扣除缓存写入）', () => {
    insertUsageStepFact(db, step({
      turnId: 't1', stepId: 'r1', day: '2026-09-15',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 100
    }))
    insertUsageStepFact(db, step({
      turnId: 't1', stepId: 'r2', day: '2026-09-15',
      inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, cacheCreationTokens: 0
    }))
    const points = queryUsageDaily(db, { from: '2026-09-15', to: '2026-09-15' })
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      day: '2026-09-15',
      inputTokens: 1500,
      outputTokens: 150,
      cacheReadTokens: 1200,
      cacheCreationTokens: 100,
      turnCount: 0
    })
    // 方案 B：1200 / (1500 − 100)
    expect(points[0].hitRate).toBeCloseTo(1200 / 1400, 6)
    db.close()
  })

  it('区间内无数据的日子补 0，命中率断线（null）', () => {
    insertUsageStepFact(db, step({ day: '2026-09-15', inputTokens: 10, outputTokens: 1 }))
    const points = queryUsageDaily(db, { from: '2026-09-14', to: '2026-09-16' })
    expect(points.map((p) => p.day)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16'])
    expect(points[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, toolCallCount: 0, hitRate: null, avgStepsPerTurn: null })
    expect(points[1]!.inputTokens).toBe(10)
    expect(points[2]).toMatchObject({ inputTokens: 0, hitRate: null })
    db.close()
  })

  it('Turn / 工具指标与 Token 指标按 day 对齐合并，avgStepsPerTurn 正确', () => {
    insertUsageStepFact(db, step({ day: '2026-09-15', turnId: 'ta', inputTokens: 10, outputTokens: 1 }))
    upsertUsageTurnFact(db, turn({ turnId: 'ta', day: '2026-09-15', stepCount: 2, toolCallCount: 3, toolErrorCount: 1, toolSkippedCount: 1 }))
    upsertUsageTurnFact(db, turn({ turnId: 'tb', sessionId: 'sess-1', day: '2026-09-15', stepCount: 4, toolCallCount: 2, toolErrorCount: 0, toolSkippedCount: 0 }))
    const points = queryUsageDaily(db, { from: '2026-09-15', to: '2026-09-15' })
    expect(points[0]).toMatchObject({
      toolCallCount: 5,
      toolErrorCount: 1,
      toolSkippedCount: 1,
      turnCount: 2,
      stepCount: 6
    })
    expect(points[0]!.avgStepsPerTurn).toBeCloseTo(3, 6)
    db.close()
  })

  it('模型筛选按「服务 + 模型」组合（同模型跨服务分开）', () => {
    insertUsageStepFact(db, step({ day: '2026-09-15', inputTokens: 100, model: 'm1', llmServiceId: 'svc-a' }))
    insertUsageStepFact(db, step({ day: '2026-09-15', turnId: 't2', stepId: 'r2', inputTokens: 200, model: 'm1', llmServiceId: 'svc-b' }))
    insertUsageStepFact(db, step({ day: '2026-09-15', turnId: 't3', stepId: 'r3', inputTokens: 400, model: 'm2', llmServiceId: 'svc-a' }))
    const filtered = queryUsageDaily(db, {
      from: '2026-09-15', to: '2026-09-15',
      dimensions: { models: [{ model: 'm1', llmServiceId: 'svc-b' }] }
    })
    expect(filtered[0]!.inputTokens).toBe(200)
    const anyService = queryUsageDaily(db, {
      from: '2026-09-15', to: '2026-09-15',
      dimensions: { models: [{ model: 'm1' }] }
    })
    expect(anyService[0]!.inputTokens).toBe(300)
    db.close()
  })

  it('会话 / 版本筛选生效', () => {
    insertUsageStepFact(db, step({ day: '2026-09-15', inputTokens: 100, appVersion: '0.1.5' }))
    insertUsageStepFact(db, step({ day: '2026-09-15', turnId: 't2', stepId: 'r2', sessionId: 'sess-2', inputTokens: 200, appVersion: 'unknown' }))
    upsertUsageTurnFact(db, turn({ turnId: 't2', sessionId: 'sess-2', appVersion: 'unknown' }))
    const bySession = queryUsageDaily(db, { from: '2026-09-15', to: '2026-09-15', dimensions: { sessionIds: ['sess-2'] } })
    expect(bySession[0]).toMatchObject({ inputTokens: 200, turnCount: 1 })
    const byVersion = queryUsageDaily(db, { from: '2026-09-15', to: '2026-09-15', dimensions: { appVersions: ['0.1.5'] } })
    expect(byVersion[0]).toMatchObject({ inputTokens: 100, turnCount: 0 })
    db.close()
  })

  it('跨度超过 366 天时截断（数据量保护）', () => {
    const points = queryUsageDaily(db, { from: '2020-01-01', to: '2026-09-16' })
    expect(points).toHaveLength(366)
    db.close()
  })
})

describe('queryUsageSummary 区间汇总', () => {
  let db: AppDatabase
  beforeEach(() => {
    db = createMemoryAppDb()
  })

  it('汇总 6 项核心指标 + 佐证指标与出错率', () => {
    insertUsageStepFact(db, step({ day: '2026-09-15', turnId: 'ta', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0 }))
    insertUsageStepFact(db, step({ day: '2026-09-16', turnId: 'tb', stepId: 'rb', inputTokens: 500, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 0 }))
    upsertUsageTurnFact(db, turn({ turnId: 'ta', day: '2026-09-15', stepCount: 2, toolCallCount: 4, toolErrorCount: 1, toolSkippedCount: 1 }))
    upsertUsageTurnFact(db, turn({ turnId: 'tb', day: '2026-09-16', stepCount: 3, toolCallCount: 2, toolErrorCount: 0, toolSkippedCount: 0 }))
    const summary = queryUsageSummary(db, { from: '2026-09-15', to: '2026-09-16' })
    expect(summary).toMatchObject({
      totalTokens: 1650,
      inputTokens: 1500,
      outputTokens: 150,
      cacheReadTokens: 1000,
      cacheCreationTokens: 0,
      toolCallCount: 6,
      toolErrorCount: 1,
      toolSkippedCount: 1,
      turnCount: 2,
      stepCount: 5
    })
    expect(summary.hitRate).toBeCloseTo(1000 / 1500, 6)
    expect(summary.toolErrorRate).toBeCloseTo(1 / 6, 6)
    expect(summary.avgStepsPerTurn).toBeCloseTo(2.5, 6)
    db.close()
  })

  it('空区间：全 0，比率为 null（不显示 0%）', () => {
    const summary = queryUsageSummary(db, { from: '2026-09-15', to: '2026-09-16' })
    expect(summary).toMatchObject({
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      hitRate: null, toolCallCount: 0, toolErrorRate: null, turnCount: 0, stepCount: 0, avgStepsPerTurn: null
    })
    db.close()
  })
})

describe('queryUsageDimensions 筛选值枚举', () => {
  let db: AppDatabase
  beforeEach(() => {
    db = createMemoryAppDb()
  })

  it('枚举模型组合、会话（含已删除）、版本', () => {
    const live = createSession(db, { name: '我的会话' })
    insertUsageStepFact(db, step({ sessionId: live.id, turnId: 't1', inputTokens: 10, model: 'm1', llmServiceId: 'svc-a', appVersion: '0.1.5' }))
    insertUsageStepFact(db, step({ sessionId: 'sess-gone', turnId: 't2', stepId: 'r2', inputTokens: 10, model: 'm2', llmServiceId: 'svc-b', appVersion: 'unknown' }))
    upsertUsageTurnFact(db, turn({ sessionId: live.id, turnId: 't1', model: 'm1', llmServiceId: 'svc-a', appVersion: '0.1.5' }))

    const dims = queryUsageDimensions(db)
    expect(dims.models).toEqual([
      { model: 'm1', llmServiceId: 'svc-a' },
      { model: 'm2', llmServiceId: 'svc-b' }
    ])
    expect(dims.appVersions).toEqual(['0.1.5', 'unknown'])
    expect(dims.sessions).toEqual(expect.arrayContaining([
      { sessionId: live.id, name: '我的会话' },
      { sessionId: 'sess-gone', name: null }
    ]))
    expect(dims.sessions).toHaveLength(2)
    db.close()
  })
})
