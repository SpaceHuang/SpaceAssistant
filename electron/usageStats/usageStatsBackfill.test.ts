import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import type { AppDatabase } from '../database'
import { backfillUsageStats } from './usageStatsBackfill'
import { getUsageStepFactsForTurn, getUsageTurnFact, upsertUsageTurnFact } from '../database/operations'

const T_FIRST = new Date(2026, 8, 13, 9, 30).getTime()
const T_THIRD = new Date(2026, 8, 13, 9, 31).getTime()

function jsonlLine(event: Record<string, unknown>): string {
  return JSON.stringify(event)
}

/** 在临时 workDir 下构造一个会话台账目录，返回其 sessionId。 */
function seedSessionLedger(workDir: string, lines: string[], dirDate = '20260913'): string {
  const sessionId = randomUUID()
  const dir = path.join(workDir, 'sessions', `${sessionId}-${dirDate}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')
  return sessionId
}

/** 为 turns 表种一行（FK 依赖 sessions/messages），可带 execution_config_json。 */
function seedTurnRow(db: AppDatabase, input: { sessionId: string; turnId: string; executionConfigJson?: string; model?: string }): void {
  const conn = getDbConnection(db)
  conn
    .prepare(
      `INSERT INTO sessions (id, name, preview, model, llm_service_id, temperature, max_tokens, created_at, updated_at, message_count, skills_state, metadata, schema_version)
       VALUES (?, 'seed', '', ?, NULL, 0.7, 4096, ?, ?, 0, '{}', '{}', 1)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(input.sessionId, input.model ?? 'fallback-model', Date.now(), Date.now())
  conn
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, status, schema_version, timestamp, sequence)
       VALUES (?, ?, 'assistant', '', 'completed', 1, ?, 0)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(`msg-${input.turnId}`, input.sessionId, Date.now())
  conn
    .prepare(
      `INSERT INTO turns (turn_id, request_id, session_id, assistant_message_id, state, created_at, updated_at, execution_config_json)
       VALUES (?, ?, ?, ?, 'terminal', ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET execution_config_json = excluded.execution_config_json`
    )
    .run(input.turnId, `req-${input.turnId}`, input.sessionId, `msg-${input.turnId}`, Date.now(), Date.now(), input.executionConfigJson ?? null)
}

function setup(): { db: AppDatabase; workDir: string; cleanup: () => void } {
  const db = createMemoryAppDb()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-backfill-'))
  return { db, workDir, cleanup: () => {
    db.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  } }
}

describe('backfillUsageStats 历史台账回填', () => {
  it('从 events.jsonl 重建 step/turn 事实（真实样本口径、模型取冻存配置、app_version=unknown）', () => {
    const { db, workDir, cleanup } = setup()
    const sessionId = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'turn_start', payload: { turnId: 'turn-hist-1' } }),
      jsonlLine({ seq: 2, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'req-h1:round:1', turnId: 'turn-hist-1', usage: { input_tokens: 14365, output_tokens: 124 }, source: 'api' } }),
      jsonlLine({ seq: 3, time: T_THIRD, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'req-h1:round:3', turnId: 'turn-hist-1', usage: { input_tokens: 4364, cache_read_input_tokens: 46464, output_tokens: 760, cacheSemantics: 'additive' }, source: 'api' } }),
      jsonlLine({ seq: 4, time: T_THIRD, type: 'tool_call', payload: { turnId: 'turn-hist-1', stepId: 'req-h1', toolUseId: 'tu-1', name: 'read_file', args: {} } }),
      jsonlLine({ seq: 5, time: T_THIRD, type: 'tool_call', payload: { turnId: 'turn-hist-1', stepId: 'req-h1', toolUseId: 'tu-2', name: 'run_shell', args: {} } }),
      jsonlLine({ seq: 6, time: T_THIRD, type: 'tool_call', payload: { turnId: 'turn-hist-1', stepId: 'req-h1', toolUseId: 'tu-3', name: 'write_file', args: {} } }),
      // 成功
      jsonlLine({ seq: 7, time: T_THIRD, type: 'tool_result', payload: { turnId: 'turn-hist-1', stepId: 'req-h1', toolUseId: 'tu-1', result: { success: true, data: 'ok' } } }),
      // 旧数据「拒绝」：无 notExecuted 标记，回填只能归执行失败（§7.4 已声明局限）
      jsonlLine({ seq: 8, time: T_THIRD, type: 'tool_result', payload: { turnId: 'turn-hist-1', stepId: 'req-h1', toolUseId: 'tu-2', result: { success: false, error: '用户拒绝执行此工具' } } }),
      // 崩溃合成的 synthetic tool_result：无 turnId，按 toolUseId 归因，计「未执行」
      jsonlLine({ seq: 9, time: T_THIRD, type: 'tool_result', payload: { toolUseId: 'tu-3', synthetic: true, result: { success: false, error: '工具调用因应用退出中断' } } })
    ])
    seedTurnRow(db, {
      sessionId,
      turnId: 'turn-hist-1',
      executionConfigJson: JSON.stringify({ model: 'deepseek-v4-pro', llmServiceId: 'svc-a', baseUrl: 'https://api.deepseek.com/anthropic' })
    })

    const result = backfillUsageStats(db, [workDir])
    expect(result.scannedSessionDirs).toBe(1)

    const steps = getUsageStepFactsForTurn(db, sessionId, 'turn-hist-1')
    expect(steps).toHaveLength(2)
    const first = steps.find((s) => s.stepId === 'req-h1:round:1')!
    expect(first).toMatchObject({ inputTokens: 14365, outputTokens: 124, model: 'deepseek-v4-pro', llmServiceId: 'svc-a', appVersion: 'unknown', source: 'api', day: '2026-09-13' })
    const third = steps.find((s) => s.stepId === 'req-h1:round:3')!
    expect(third.inputTokens).toBe(50828)
    expect(third.cacheReadTokens).toBe(46464)

    const turnRow = getUsageTurnFact(db, 'turn-hist-1')
    expect(turnRow).toMatchObject({
      turnId: 'turn-hist-1',
      sessionId,
      stepCount: 2,
      toolCallCount: 3,
      toolErrorCount: 1,
      toolSkippedCount: 1,
      model: 'deepseek-v4-pro',
      llmServiceId: 'svc-a',
      appVersion: 'unknown'
    })
    cleanup()
  })

  it('execution_config_json 缺失时模型回退 sessions.model', () => {
    const { db, workDir, cleanup } = setup()
    const sessionId = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'req-x:round:1', turnId: 'turn-x', usage: { input_tokens: 10, output_tokens: 1 }, source: 'api' } })
    ])
    seedTurnRow(db, { sessionId, turnId: 'turn-x', model: 'kimi-k2.6' })
    backfillUsageStats(db, [workDir])
    expect(getUsageStepFactsForTurn(db, sessionId, 'turn-x')[0]).toMatchObject({ model: 'kimi-k2.6' })
    cleanup()
  })

  it('台账有 turn_end(reason=completed) 时 outcome=completed；error/interrupted/无 turn_end 均留空', () => {
    const { db, workDir, cleanup } = setup()
    const withEnd = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'r:round:1', turnId: 'turn-end', usage: { input_tokens: 5, output_tokens: 1 }, source: 'api' } }),
      jsonlLine({ seq: 2, time: T_FIRST, type: 'turn_end', payload: { turnId: 'turn-end', reason: 'completed' } })
    ], '20260914')
    seedTurnRow(db, { sessionId: withEnd, turnId: 'turn-end' })
    const withError = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 're:round:1', turnId: 'turn-err', usage: { input_tokens: 5, output_tokens: 1 }, source: 'api' } }),
      // reason='error'：含用户中止的失败 Turn，不得误标 completed（评审 P1-1）
      jsonlLine({ seq: 2, time: T_FIRST, type: 'turn_end', payload: { turnId: 'turn-err', reason: 'error', error: 'boom' } })
    ], '20260914')
    seedTurnRow(db, { sessionId: withError, turnId: 'turn-err' })
    const withInterrupted = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'ri:round:1', turnId: 'turn-int', usage: { input_tokens: 5, output_tokens: 1 }, source: 'api' } }),
      jsonlLine({ seq: 2, time: T_FIRST, type: 'turn_end', payload: { turnId: 'turn-int', reason: 'interrupted' } })
    ], '20260915')
    seedTurnRow(db, { sessionId: withInterrupted, turnId: 'turn-int' })
    const withoutEnd = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'r2:round:1', turnId: 'turn-noend', usage: { input_tokens: 5, output_tokens: 1 }, source: 'api' } })
    ], '20260915')
    seedTurnRow(db, { sessionId: withoutEnd, turnId: 'turn-noend' })
    backfillUsageStats(db, [workDir])
    expect(getUsageTurnFact(db, 'turn-end')!.outcome).toBe('completed')
    expect(getUsageTurnFact(db, 'turn-err')!.outcome).toBeNull()
    expect(getUsageTurnFact(db, 'turn-int')!.outcome).toBeNull()
    expect(getUsageTurnFact(db, 'turn-noend')!.outcome).toBeNull()
    cleanup()
  })

  it('重复执行幂等（不累加），已存在的实时 turn 行不被覆盖', () => {
    const { db, workDir, cleanup } = setup()
    const sessionId = seedSessionLedger(workDir, [
      jsonlLine({ seq: 1, time: T_FIRST, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'r:round:1', turnId: 'turn-live', usage: { input_tokens: 10, output_tokens: 1 }, source: 'api' } }),
      jsonlLine({ seq: 2, time: T_FIRST, type: 'tool_call', payload: { turnId: 'turn-live', stepId: 'r', toolUseId: 'tu-live', name: 'read_file', args: {} } })
    ])
    seedTurnRow(db, { sessionId, turnId: 'turn-live' })
    // 实时侧已收口（能区分拒绝）
    upsertUsageTurnFact(db, { turnId: 'turn-live', sessionId, createdAt: T_FIRST, day: '2026-09-13', stepCount: 1, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 1, outcome: 'completed' })

    const first = backfillUsageStats(db, [workDir])
    const second = backfillUsageStats(db, [workDir])
    expect(first.stepRowsWritten).toBe(1)
    expect(second.turnRowsWritten).toBe(0)
    const turnRow = getUsageTurnFact(db, 'turn-live')!
    // 实时行（skipped=1，拒绝可区分）优先于台账重算（会算成 error）
    expect(turnRow).toMatchObject({ toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 1 })
    expect(getUsageStepFactsForTurn(db, sessionId, 'turn-live')).toHaveLength(1)
    cleanup()
  })

  it('损坏的 events.jsonl 跳过不抛错', () => {
    const { db, workDir, cleanup } = setup()
    const dir = path.join(workDir, 'sessions', `${randomUUID()}-20260913`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'events.jsonl'), 'not-json\n{"seq":1,"time":1,"type":"bogus_type","payload":{}}\n', 'utf8')
    const result = backfillUsageStats(db, [workDir])
    expect(result.stepRowsWritten).toBe(0)
    cleanup()
  })
})
