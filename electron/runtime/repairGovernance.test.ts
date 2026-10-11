import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory, projectionRepairRetryDelayMs } from './sqliteAgentHistory'

function insertPendingRepair(db: ReturnType<typeof createMemoryAppDb>, repairId: string, invocationId = 'gov-invocation'): void {
  getDbConnection(db).prepare(`INSERT INTO canonical_projection_repairs(
    repair_id, session_id, invocation_id, repair_kind, target_key, status, attempts, idempotency_key, updated_at
  ) VALUES(?, 'gov-session', ?, 'invocation-projections', ?, 'pending', 0, ?, ?)`)
    .run(repairId, invocationId, `target-${repairId}`, `${invocationId}:key:${repairId}`, Date.now())
}

describe('projection repair governance (P3-②)', () => {
  it('marks a deterministically unrecoverable failure terminal instead of retrying forever', () => {
    const db = createMemoryAppDb()
    const history = new SqliteAgentHistory(getDbConnection(db))
    insertPendingRepair(db, 'gov-workspace-root')

    history.recordProjectionRepairResult('gov-workspace-root', {
      success: false,
      error: new Error('ledger path is outside the configured workspace root')
    })

    // P3-②: the terminal verdict rides in the additive terminal_failed column (the legacy
    // status CHECK domain is untouched); retry queries exclude the row permanently.
    const row = getDbConnection(db).prepare('SELECT status, attempts, terminal_failed FROM canonical_projection_repairs WHERE repair_id=?')
      .get('gov-workspace-root') as { status: string; attempts: number; terminal_failed: number }
    expect(row.status).toBe('pending')
    expect(row.terminal_failed).toBe(1)
    expect(row.attempts).toBe(1)
    db.close()
  })

  it('keeps transient failures pending for the normal backoff path', () => {
    const db = createMemoryAppDb()
    const history = new SqliteAgentHistory(getDbConnection(db))
    insertPendingRepair(db, 'gov-transient')

    // 分类器读 error.code：用真实 code 形态构造，证明瞬态错误不被误判为 terminal。
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    history.recordProjectionRepairResult('gov-transient', { success: false, error: busy })

    expect(getDbConnection(db).prepare('SELECT status FROM canonical_projection_repairs WHERE repair_id=?')
      .get('gov-transient')).toEqual({ status: 'pending' })
    db.close()
  })

  it('excludes terminal-failed rows from the startup recovery work summary and retries', () => {
    const db = createMemoryAppDb()
    const history = new SqliteAgentHistory(getDbConnection(db))
    insertPendingRepair(db, 'gov-summary-terminal')
    history.recordProjectionRepairResult('gov-summary-terminal', {
      success: false,
      error: new Error('configured workspace root rejected the ledger location')
    })

    const summary = history.getStartupRecoveryWorkSummary()
    expect(summary.dueProjectionRepairCount).toBe(0)

    const retryable = getDbConnection(db).prepare(
      "SELECT COUNT(*) AS n FROM canonical_projection_repairs WHERE status='pending' AND terminal_failed=0"
    ).get() as { n: number }
    expect(retryable.n).toBe(0)
    db.close()
  })

  it('applies a minimum retry interval to retries while first attempts stay immediate', () => {
    // 计划 §5 P3 ②：单流 pending <10 条的立即「重试」改为带最小间隔；首次执行（attempts=0）
    // 保持立即，新义务仍在分类它们的启动轮次内结清。
    expect(projectionRepairRetryDelayMs(0, 5)).toBe(0)
    expect(projectionRepairRetryDelayMs(1, 5)).toBeGreaterThanOrEqual(60_000)
    // 多条 pending 时保持既有指数退避上限。
    expect(projectionRepairRetryDelayMs(1, 20)).toBeGreaterThanOrEqual(projectionRepairRetryDelayMs(1, 5))
  })

  it('still completes a repair on success', () => {
    const db = createMemoryAppDb()
    const history = new SqliteAgentHistory(getDbConnection(db))
    insertPendingRepair(db, 'gov-success')

    history.recordProjectionRepairResult('gov-success', { success: true })

    expect(getDbConnection(db).prepare('SELECT status FROM canonical_projection_repairs WHERE repair_id=?')
      .get('gov-success')).toEqual({ status: 'completed' })
    db.close()
  })
})
