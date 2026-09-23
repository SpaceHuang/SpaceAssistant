import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'
import {
  deleteUsageFactsBeforeDay,
  getUsageStepFactsForTurn,
  getUsageTurnFact,
  insertUsageStepFact,
  listOrphanUsageTurns,
  upsertUsageTurnFact
} from './operations'
import type { UsageStepFactInput, UsageTurnFactInput } from './operations'
import { getDbConnection } from './sqliteStore'
import { createMemoryAppDb } from './testHelpers'
import type { AppDatabase } from './index'

/** 最小 v15 库：仅 schema_meta（version=15 时 v4–v15 的 DDL 全部跳过，直接落到 v16）。 */
function createV15Database(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '15');
  `)
  return conn
}

function stepFact(overrides: Partial<UsageStepFactInput> = {}): UsageStepFactInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    stepId: 'req-1:round:1',
    createdAt: 1758000000000,
    day: '2026-09-16',
    model: 'deepseek-v4-pro',
    llmServiceId: 'svc-a',
    appVersion: '0.1.5',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheCreationTokens: 0,
    cacheSemantics: 'additive',
    source: 'api',
    ...overrides
  }
}

function turnFact(overrides: Partial<UsageTurnFactInput> = {}): UsageTurnFactInput {
  return {
    turnId: 'turn-1',
    sessionId: 'sess-1',
    createdAt: 1758000000000,
    day: '2026-09-16',
    model: 'deepseek-v4-pro',
    llmServiceId: 'svc-a',
    appVersion: '0.1.5',
    stepCount: 3,
    toolCallCount: 2,
    toolErrorCount: 1,
    toolSkippedCount: 0,
    outcome: 'completed',
    ...overrides
  }
}

describe('v16 用量统计表迁移', () => {
  it('当前 schema version 为 16', () => {
    expect(DB_SCHEMA_VERSION).toBe(18)
  })

  it('v15 库升级到 v16 后两张统计表与索引存在，且重复迁移幂等', () => {
    const conn = createV15Database()
    runMigrations(conn)

    expect(conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion)).toMatchObject({ value: '18' })
    const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(tables).toContain('usage_step_facts')
    expect(tables).toContain('usage_turn_facts')

    const stepIndexes = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_step_facts'").all() as Array<{ name: string }>).map((i) => i.name)
    expect(stepIndexes).toContain('idx_usage_step_day')
    const turnIndexes = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_turn_facts'").all() as Array<{ name: string }>).map((i) => i.name)
    expect(turnIndexes).toContain('idx_usage_turn_day')

    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })
})

describe('usage_step_facts / usage_turn_facts 读写', () => {
  it('唯一约束 (session_id, turn_id, step_id)：重复写覆盖不累加', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, stepFact())
    insertUsageStepFact(db, stepFact({ inputTokens: 999 }))
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].inputTokens).toBe(999)
    db.close()
  })

  it('插入 step 事实并完整读回', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, stepFact())
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows).toEqual([
      expect.objectContaining({
        sessionId: 'sess-1',
        turnId: 'turn-1',
        stepId: 'req-1:round:1',
        day: '2026-09-16',
        model: 'deepseek-v4-pro',
        llmServiceId: 'svc-a',
        appVersion: '0.1.5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheCreationTokens: 0,
        cacheSemantics: 'additive',
        source: 'api'
      })
    ])
    expect(typeof rows[0].id).toBe('number')
    expect(typeof rows[0].createdAt).toBe('number')
    db.close()
  })

  it('可选维度字段允许缺省（读回为 null）', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, stepFact({ model: undefined, llmServiceId: undefined, appVersion: undefined, cacheSemantics: undefined }))
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows[0].model).toBeNull()
    expect(rows[0].llmServiceId).toBeNull()
    expect(rows[0].appVersion).toBeNull()
    expect(rows[0].cacheSemantics).toBeNull()
    db.close()
  })

  it('upsert turn 事实：首插与覆盖均生效', () => {
    const db = createMemoryAppDb()
    upsertUsageTurnFact(db, turnFact())
    upsertUsageTurnFact(db, turnFact({ stepCount: 5, toolErrorCount: 1, toolSkippedCount: 1, outcome: 'cancelled' }))
    const row = getUsageTurnFact(db, 'turn-1')
    expect(row).toMatchObject({
      turnId: 'turn-1',
      sessionId: 'sess-1',
      stepCount: 5,
      toolCallCount: 2,
      toolErrorCount: 1,
      toolSkippedCount: 1,
      outcome: 'cancelled'
    })
    db.close()
  })

  it('两张统计表均不对 sessions 建外键（会话删除后统计行保留）', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    expect(conn.prepare('PRAGMA foreign_key_list(usage_step_facts)').all()).toHaveLength(0)
    expect(conn.prepare('PRAGMA foreign_key_list(usage_turn_facts)').all()).toHaveLength(0)
    db.close()
  })
})

describe('崩溃补齐：孤儿 Turn 查询', () => {
  it('找出有 usage_step_facts 行但缺 usage_turn_facts 行的 Turn', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, stepFact())
    insertUsageStepFact(db, stepFact({ stepId: 'req-1:round:2', createdAt: 1758000001000 }))
    insertUsageStepFact(db, stepFact({ sessionId: 'sess-2', turnId: 'turn-2', stepId: 'req-2:round:1' }))
    upsertUsageTurnFact(db, turnFact()) // turn-1 已收口

    const orphans = listOrphanUsageTurns(db)
    expect(orphans).toEqual([
      expect.objectContaining({
        sessionId: 'sess-2',
        turnId: 'turn-2',
        stepCount: 1
      })
    ])
    db.close()
  })

  it('无孤儿时返回空数组', () => {
    const db = createMemoryAppDb()
    expect(listOrphanUsageTurns(db)).toEqual([])
    db.close()
  })
})

describe('保留期清理（按天、返回留痕信息）', () => {
  it('删除 cutoff 之前的行并返回删除行数与日期区间', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, stepFact({ turnId: 'turn-old', stepId: 'req-old:round:1', day: '2026-01-01', createdAt: 1767225600000 }))
    insertUsageStepFact(db, stepFact({ turnId: 'turn-new', stepId: 'req-new:round:1', day: '2026-09-16' }))
    upsertUsageTurnFact(db, turnFact({ turnId: 'turn-old', day: '2026-01-01', createdAt: 1767225600000 }))
    upsertUsageTurnFact(db, turnFact({ turnId: 'turn-new' }))

    const result = deleteUsageFactsBeforeDay(db, '2026-06-01')
    expect(result).toEqual({ deletedStepRows: 1, deletedTurnRows: 1, earliestDeletedDay: '2026-01-01', latestDeletedDay: '2026-01-01' })
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'turn-old')).toHaveLength(0)
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'turn-new')).toHaveLength(1)
    expect(getUsageTurnFact(db, 'turn-old')).toBeUndefined()
    expect(getUsageTurnFact(db, 'turn-new')).toBeDefined()
    db.close()
  })

  it('cutoff 边界：当天数据保留（day < cutoff 才删）', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, stepFact({ day: '2026-06-01' }))
    const result = deleteUsageFactsBeforeDay(db, '2026-06-01')
    expect(result.deletedStepRows).toBe(0)
    expect(getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')).toHaveLength(1)
    db.close()
  })

  it('无数据可删时行数为 0、区间为 null', () => {
    const db = createMemoryAppDb()
    expect(deleteUsageFactsBeforeDay(db, '2026-06-01')).toEqual({
      deletedStepRows: 0,
      deletedTurnRows: 0,
      earliestDeletedDay: null,
      latestDeletedDay: null
    })
    db.close()
  })
})
