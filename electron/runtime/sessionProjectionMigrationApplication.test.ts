import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { SessionProjectionMigrationApplication } from './sessionProjectionMigrationApplication'

describe('session projection migration main-process application entry', () => {
  afterEach(() => vi.useRealTimers())

  it('initialization and shutdown do not start a cohort or create migration records', () => {
    const temp = createTempDatabase('projection-application-entry-disabled-')
    try {
      const application = new SessionProjectionMigrationApplication(temp.db)
      application.initialize()
      application.shutdown()
      expect(getDbConnection(temp.db).prepare('SELECT COUNT(*) AS count FROM session_projection_migration_runs').get())
        .toEqual({ count: 0 })
    } finally {
      temp.cleanup()
    }
  })

  it('requires the explicit application gate and can stop a scheduled run for process shutdown', async () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('projection-application-entry-gated-')
    try {
      const session = createSession(temp.db, { name: 'eligible', model: 'test' })
      const message = { id: 'eligible-user', role: 'user' as const, content: 'body', timestamp: 1 }
      appendMessage(temp.db, { ...message, sessionId: session.id, status: 'sent' })
      await new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id).appendBatch([{
        invocationId: 'eligible-invocation', turnId: 'eligible-turn', sequence: 1, schemaVersion: 1,
        eventId: 'eligible-context', idempotencyKey: 'eligible-context', kind: 'invocation-context-committed', payload: { messages: [message] }
      }], 0)
      getDbConnection(temp.db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
        .run(session.id)
      let enabled = false
      const application = new SessionProjectionMigrationApplication(temp.db, { executionEnabled: () => enabled })
      application.initialize()
      await expect(application.start({ runId: 'main-entry-run' })).rejects.toThrow('execution is disabled')
      expect(getDbConnection(temp.db).prepare('SELECT COUNT(*) AS count FROM session_projection_migration_runs').get())
        .toEqual({ count: 0 })

      enabled = true
      const report = await application.start({ runId: 'main-entry-run', batchSize: 1 })
      expect(report.run.runId).toBe('main-entry-run')
      expect(report.run.status).toBe('completed')

      const session2 = createSession(temp.db, { name: 'scheduled', model: 'test' })
      const message2 = { id: 'scheduled-user', role: 'user' as const, content: 'body', timestamp: 2 }
      appendMessage(temp.db, { ...message2, sessionId: session2.id, status: 'sent' })
      await new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session2.id).appendBatch([{
        invocationId: 'scheduled-invocation', turnId: 'scheduled-turn', sequence: 1, schemaVersion: 1,
        eventId: 'scheduled-context', idempotencyKey: 'scheduled-context', kind: 'invocation-context-committed', payload: { messages: [message2] }
      }], 0)
      getDbConnection(temp.db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
        .run(session2.id)
      const session3 = createSession(temp.db, { name: 'scheduled-2', model: 'test' })
      const message3 = { id: 'scheduled-user-2', role: 'user' as const, content: 'body', timestamp: 3 }
      appendMessage(temp.db, { ...message3, sessionId: session3.id, status: 'sent' })
      await new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session3.id).appendBatch([{
        invocationId: 'scheduled-invocation-2', turnId: 'scheduled-turn-2', sequence: 1, schemaVersion: 1,
        eventId: 'scheduled-context-2', idempotencyKey: 'scheduled-context-2', kind: 'invocation-context-committed', payload: { messages: [message3] }
      }], 0)
      getDbConnection(temp.db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
        .run(session3.id)
      const partial = await application.start({ runId: 'shutdown-run', batchSize: 1, maxBatches: 1 })
      expect(partial.run.status).toBe('running')
      const beforeShutdown = getDbConnection(temp.db).prepare('SELECT migrated_count FROM session_projection_migration_runs WHERE run_id=?')
        .get('shutdown-run')
      application.schedule(partial.run.runId, { batchSize: 1, initialDelayMs: 100, intervalMs: 100 })
      application.shutdown()
      await vi.advanceTimersByTimeAsync(100)
      expect(getDbConnection(temp.db).prepare('SELECT migrated_count,status FROM session_projection_migration_runs WHERE run_id=?')
        .get('shutdown-run')).toEqual({ ...beforeShutdown, status: 'running' })
    } finally {
      temp.cleanup()
    }
  })

  it('shutdown 等待已启动的有界批次结束后才返回', async () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('projection-application-entry-drain-')
    try {
      for (const [index, name] of (['drain-a', 'drain-b'] as const).entries()) {
        const session = createSession(temp.db, { name, model: 'test' })
        const message = { id: `${name}-user`, role: 'user' as const, content: 'body', timestamp: index + 1 }
        appendMessage(temp.db, { ...message, sessionId: session.id, status: 'sent' })
        await new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id).appendBatch([{
          invocationId: `${name}-invocation`, turnId: `${name}-turn`, sequence: 1, schemaVersion: 1,
          eventId: `${name}-context`, idempotencyKey: `${name}-context`, kind: 'invocation-context-committed', payload: { messages: [message] }
        }], 0)
        getDbConnection(temp.db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
          .run(session.id)
      }

      const application = new SessionProjectionMigrationApplication(temp.db, { executionEnabled: () => true })
      application.initialize()
      const run = application.createRun({ runId: 'drain-run' })
      application.schedule(run.runId, { batchSize: 2, rateLimitMs: 100, initialDelayMs: 0, intervalMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      expect(getDbConnection(temp.db).prepare("SELECT COUNT(*) AS count FROM session_projection_migration_items WHERE run_id=? AND status='migrated'")
        .get(run.runId)).toEqual({ count: 1 })

      let shutdownResolved = false
      const shutdown = application.shutdown().then(() => { shutdownResolved = true })
      await expect(application.start({ runId: 'must-not-start-during-shutdown' })).rejects.toThrow('not initialized')
      await Promise.resolve()
      expect(shutdownResolved).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
      await shutdown
      expect(getDbConnection(temp.db).prepare('SELECT migrated_count,status FROM session_projection_migration_runs WHERE run_id=?')
        .get(run.runId)).toEqual({ migrated_count: 2, status: 'completed' })
    } finally {
      temp.cleanup()
    }
  })
})
