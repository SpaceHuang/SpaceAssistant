import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { openDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { SessionProjectionMigrationCoordinator } from './sessionProjectionMigrationCoordinator'
import * as projectionModule from './sessionTranscriptProjection'

async function addEligibleSession(db: ReturnType<typeof createTempDatabase>['db'], name: string) {
  const session = createSession(db, { name, model: 'test' })
  const message = { id: `user-${name}`, role: 'user' as const, content: `body-${name}`, timestamp: 1 }
  appendMessage(db, { ...message, sessionId: session.id, status: 'sent' })
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
    invocationId: `inv-${name}`, turnId: `turn-${name}`, sequence: 1, schemaVersion: 1,
    eventId: `ctx-${name}`, idempotencyKey: `ctx-${name}`, kind: 'invocation-context-committed', payload: { messages: [message] }
  }], 0)
  getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
  return session
}

describe('session projection migration application coordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('默认关闭时不创建 run 或修改 session eligibility', async () => {
    const temp = createTempDatabase('projection-coordinator-disabled-')
    try {
      const session = await addEligibleSession(temp.db, 'disabled')
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db)

      await expect(coordinator.start()).rejects.toThrow('execution is disabled')
      expect(getDbConnection(temp.db).prepare('SELECT COUNT(*) AS count FROM session_projection_migration_runs').get())
        .toEqual({ count: 0 })
      expect(getDbConnection(temp.db).prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id))
        .toBeUndefined()
    } finally {
      temp.cleanup()
    }
  })

  it('显式启动固定 inventory、有限批次执行并在重复启动时复用同一个 run', async () => {
    const temp = createTempDatabase('projection-coordinator-resume-')
    try {
      const first = await addEligibleSession(temp.db, 'first')
      const second = await addEligibleSession(temp.db, 'second')
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => true })

      const started = await coordinator.start({ runId: 'coordinator-run', batchSize: 1, maxBatches: 1 })
      expect(started.run).toMatchObject({ runId: 'coordinator-run', inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/), status: 'running', totalCount: 2 })
      expect(started.batchCount).toBe(1)
      expect(started.processedCount).toBe(1)
      expect(started.outcomes).toHaveLength(1)
      expect(getDbConnection(temp.db).prepare('SELECT inventory_sha256,status FROM session_projection_migration_runs WHERE run_id=?')
        .get('coordinator-run')).toMatchObject({ inventory_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), status: 'running' })

      const repeated = await coordinator.start({ batchSize: 1, maxBatches: 1 })
      expect(repeated.run.runId).toBe('coordinator-run')
      expect(repeated.processedCount).toBe(1)
      expect(repeated.run.status).toBe('completed')
      expect([first.id, second.id].every((sessionId) => getDbConnection(temp.db)
        .prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(sessionId))).toBe(true)
    } finally {
      temp.cleanup()
    }
  })

  it('重建 coordinator 后按持久 active run 的原 inventory 续跑，不另建 census', async () => {
    const temp = createTempDatabase('projection-coordinator-reopen-')
    let db = temp.db
    try {
      await addEligibleSession(db, 'reopen-a')
      await addEligibleSession(db, 'reopen-b')
      const firstCoordinator = new SessionProjectionMigrationCoordinator(db, { executionEnabled: () => true })
      const first = await firstCoordinator.start({ runId: 'reopen-run', batchSize: 1 })
      expect(first.run.status).toBe('running')
      const originalHash = first.run.inventorySha256

      db.close()
      db = openDatabase(temp.dbPath)
      const resumed = await new SessionProjectionMigrationCoordinator(db, { executionEnabled: () => true })
        .start({ batchSize: 1 })

      expect(resumed.run.runId).toBe('reopen-run')
      expect(resumed.run.inventorySha256).toBe(originalHash)
      expect(resumed.run.status).toBe('completed')
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM session_projection_migration_runs').get())
        .toEqual({ count: 1 })
    } finally {
      try { db.close() } catch { /* already closed */ }
      temp.cleanup()
    }
  })

  it('从应用入口执行时延后活跃 turn，同时推进同批次的健康会话', async () => {
    const temp = createTempDatabase('projection-coordinator-active-turn-')
    try {
      const active = await addEligibleSession(temp.db, 'active-turn')
      const healthy = await addEligibleSession(temp.db, 'healthy-turn')
      const assistant = createSession(temp.db, { name: 'active-turn-assistant', model: 'test' })
      appendMessage(temp.db, { id: 'active-turn-assistant-message', sessionId: assistant.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
      getDbConnection(temp.db).prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
        VALUES('active-turn-id','active-turn-request',?,'active-turn-assistant-message','running',1,1)`).run(active.id)
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => true })

      const report = await coordinator.start({ runId: 'active-turn-run', batchSize: 10, rateLimitMs: 0 })

      expect(report.run.status).toBe('needs_retry')
      expect(report.outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: active.id, outcome: 'skipped', reason: 'active-turn-or-queue' }),
        expect.objectContaining({ sessionId: healthy.id, outcome: 'success' }),
      ]))
      expect(getDbConnection(temp.db).prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
        .get(active.id)).toBeUndefined()
      expect(getDbConnection(temp.db).prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
        .get(healthy.id)).toBeDefined()
    } finally {
      temp.cleanup()
    }
  })

  it('执行入口遇到固定 cohort 的 scope 漂移时 fail closed 并报告 attention', async () => {
    const temp = createTempDatabase('projection-coordinator-scope-drift-')
    try {
      const session = await addEligibleSession(temp.db, 'scope-drift')
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => true })
      const run = coordinator.createRun({ runId: 'scope-drift-run' })
      getDbConnection(temp.db).prepare("UPDATE sessions SET ownership='internal',visibility='hidden' WHERE id=?").run(session.id)

      const report = await coordinator.run(run.runId, { batchSize: 1 })

      expect(report).toMatchObject({ processedCount: 0, failureCount: 0, run: { status: 'needs_attention' } })
      expect(getDbConnection(temp.db).prepare('SELECT status,error,attempts FROM session_projection_migration_items WHERE run_id=? AND session_id=?')
        .get(run.runId, session.id)).toMatchObject({ status: 'pending', error: 'session-scope-changed:internal/hidden', attempts: 0 })
      expect(getDbConnection(temp.db).prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
        .get(session.id)).toBeUndefined()
    } finally {
      temp.cleanup()
    }
  })

  it('执行失败后重复 start 复用原 run 并重试失败 session', async () => {
    const temp = createTempDatabase('projection-coordinator-retry-')
    try {
      const session = await addEligibleSession(temp.db, 'retry-once')
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => true })
      const originalRead = projectionModule.readSessionTranscriptProjection
      let failOnce = true
      const reader = vi.spyOn(projectionModule, 'readSessionTranscriptProjection').mockImplementation((db, sessionId) => {
        if (sessionId === session.id && failOnce) {
          failOnce = false
          throw new Error('injected coordinator retry failure')
        }
        return originalRead(db, sessionId)
      })
      try {
        const failed = await coordinator.start({ runId: 'coordinator-retry-run', batchSize: 1 })
        expect(failed.run.status).toBe('needs_retry')
        expect(failed.failureCount).toBe(1)

        const recovered = await coordinator.start({ batchSize: 1 })
        expect(recovered.run.runId).toBe('coordinator-retry-run')
        expect(recovered.run.status).toBe('completed')
        expect(recovered.successCount).toBe(1)
        expect(getDbConnection(temp.db).prepare('SELECT COUNT(*) AS count FROM session_projection_migration_runs').get())
          .toEqual({ count: 1 })
      } finally {
        reader.mockRestore()
      }
    } finally {
      temp.cleanup()
    }
  })

  it('批次之间让出主循环，允许普通 session 工作先执行', async () => {
    const temp = createTempDatabase('projection-coordinator-yield-')
    try {
      await addEligibleSession(temp.db, 'yield-a')
      await addEligibleSession(temp.db, 'yield-b')
      await addEligibleSession(temp.db, 'yield-c')
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => true })
      const run = coordinator.createRun({ runId: 'yield-run' })
      let ordinaryWorkRan = false
      setImmediate(() => {
        createSession(temp.db, { name: 'ordinary-session-work', model: 'test' })
        ordinaryWorkRan = true
      })

      const report = await coordinator.run(run.runId, { batchSize: 1, maxBatches: 3, rateLimitMs: 0 })
      expect(ordinaryWorkRan).toBe(true)
      expect(report.batchCount).toBe(3)
      expect(report.processedCount).toBe(3)
      expect(report.run.status).toBe('completed')
    } finally {
      temp.cleanup()
    }
  })

  it('后台调度每轮只跑有限批次，完成后停止；手动 stop 保留 run 供续跑', async () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('projection-coordinator-schedule-')
    try {
      await addEligibleSession(temp.db, 'schedule-a')
      await addEligibleSession(temp.db, 'schedule-b')
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => true, now: () => 100 })
      const run = coordinator.createRun({ runId: 'scheduled-run', now: 100 })
      const reports: string[] = []
      const stop = coordinator.schedule(run.runId, {
        batchSize: 1, initialDelayMs: 0, intervalMs: 100, rateLimitMs: 0,
        onReport: (report) => reports.push(report.run.status),
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(reports).toEqual(['running'])
      await vi.advanceTimersByTimeAsync(100)
      expect(reports).toEqual(['running', 'completed'])
      await vi.advanceTimersByTimeAsync(100)
      expect(reports).toHaveLength(2)
      stop()

      await addEligibleSession(temp.db, 'schedule-late-a')
      await addEligibleSession(temp.db, 'schedule-late-b')
      const partial = coordinator.createRun({ runId: 'stoppable-run', now: 200 })
      const stopEarly = coordinator.schedule(partial.runId, {
        batchSize: 1, initialDelayMs: 0, intervalMs: 100, rateLimitMs: 0,
      })
      await vi.advanceTimersByTimeAsync(0)
      stopEarly()
      const pausedWork = getDbConnection(temp.db).prepare('SELECT status FROM session_projection_migration_runs WHERE run_id=?')
        .get('stoppable-run') as { status: string }
      expect(pausedWork.status).toBe('running')
      await vi.advanceTimersByTimeAsync(100)
      expect(getDbConnection(temp.db).prepare('SELECT COUNT(*) AS count FROM session_projection_migration_items WHERE run_id=? AND status=\'migrated\'')
        .get('stoppable-run')).toEqual({ count: 3 })
    } finally {
      temp.cleanup()
    }
  })

  it('execution gate 在调度期间关闭后不再推进 run', async () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('projection-coordinator-gate-close-')
    try {
      await addEligibleSession(temp.db, 'gate-close-a')
      await addEligibleSession(temp.db, 'gate-close-b')
      let enabled = true
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => enabled, now: () => 100 })
      const run = coordinator.createRun({ runId: 'gate-close-run', now: 100 })
      coordinator.schedule(run.runId, { batchSize: 1, initialDelayMs: 0, intervalMs: 100, rateLimitMs: 0 })
      await vi.advanceTimersByTimeAsync(0)
      expect(getDbConnection(temp.db).prepare('SELECT migrated_count FROM session_projection_migration_runs WHERE run_id=?')
        .get(run.runId)).toEqual({ migrated_count: 1 })

      enabled = false
      await vi.advanceTimersByTimeAsync(100)
      expect(getDbConnection(temp.db).prepare('SELECT migrated_count FROM session_projection_migration_runs WHERE run_id=?')
        .get(run.runId)).toEqual({ migrated_count: 1 })
      expect(getDbConnection(temp.db).prepare("SELECT COUNT(*) AS count FROM session_projection_migration_items WHERE run_id=? AND status='migrated'")
        .get(run.runId)).toEqual({ count: 1 })
    } finally {
      temp.cleanup()
    }
  })

  it('多批次调用在批次间 gate 关闭后不再领取下一批', async () => {
    const temp = createTempDatabase('projection-coordinator-gate-between-batches-')
    try {
      await addEligibleSession(temp.db, 'gate-between-a')
      await addEligibleSession(temp.db, 'gate-between-b')
      await addEligibleSession(temp.db, 'gate-between-c')
      let enabled = true
      const coordinator = new SessionProjectionMigrationCoordinator(temp.db, { executionEnabled: () => enabled })
      const run = coordinator.createRun({ runId: 'gate-between-run' })
      setImmediate(() => { enabled = false })

      const report = await coordinator.run(run.runId, { batchSize: 1, maxBatches: 3, rateLimitMs: 0 })

      expect(report.batchCount).toBe(1)
      expect(report.processedCount).toBe(1)
      expect(report.run.status).toBe('running')
      expect(getDbConnection(temp.db).prepare("SELECT COUNT(*) AS count FROM session_projection_migration_items WHERE run_id=? AND status='migrated'")
        .get(run.runId)).toEqual({ count: 1 })
    } finally {
      temp.cleanup()
    }
  })

  it('取消状态持久化，重开后不能恢复执行', async () => {
    const temp = createTempDatabase('projection-coordinator-cancel-')
    let db = temp.db
    try {
      await addEligibleSession(db, 'cancel')
      const coordinator = new SessionProjectionMigrationCoordinator(db, { executionEnabled: () => true })
      const started = coordinator.createRun({ runId: 'cancel-run' })
      expect(started.status).toBe('running')

      const cancelled = coordinator.cancel('cancel-run', 50)
      expect(cancelled.status).toBe('cancelled')

      db.close()
      db = openDatabase(temp.dbPath)
      const reopenedCoordinator = new SessionProjectionMigrationCoordinator(db, { executionEnabled: () => true })
      const resumed = await reopenedCoordinator.run('cancel-run', { batchSize: 1 })
      expect(resumed.run.status).toBe('cancelled')
      expect(resumed.processedCount).toBe(0)
      expect(getDbConnection(db).prepare('SELECT cancelled_at FROM session_projection_migration_runs WHERE run_id=?')
        .get('cancel-run')).toEqual({ cancelled_at: 50 })
    } finally {
      try { db.close() } catch { /* already closed */ }
      temp.cleanup()
    }
  })
})
