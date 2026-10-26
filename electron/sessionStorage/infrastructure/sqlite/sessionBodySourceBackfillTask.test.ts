import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendMessage, createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { createSessionBodySourceBackfillTask } from './sessionBodySourceBackfillTask'

describe('session body source backfill task', () => {
  let cleanup: (() => void) | undefined
  let taskStop: (() => void) | undefined
  let blobRoot: string | undefined
  afterEach(async () => { taskStop?.(); taskStop = undefined; cleanup?.(); cleanup = undefined
    if (blobRoot) await fs.rm(blobRoot, { recursive: true, force: true }); blobRoot = undefined })

  it('backfills an old pending session from worker-read History and publishes complete locators', async () => {
    const temp = createTempDatabase('session-body-source-backfill-task-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'background source backfill' })
    appendMessage(temp.db, { id: 'task-user', sessionId: session.id, role: 'user', content: 'task body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'task-invocation', turnId: 'task-turn', sequence: 1, schemaVersion: 1, eventId: 'task-context',
        idempotencyKey: 'task-context', kind: 'invocation-context-committed', payload: { messages: [
          { id: 'task-user', role: 'user', content: 'task body', timestamp: 1 },
        ] } },
      { invocationId: 'task-invocation', turnId: 'task-turn', sequence: 2, schemaVersion: 1, eventId: 'task-complete',
        idempotencyKey: 'task-complete', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const result = new Promise<{ sessionId: string; status: string; messageCount?: number }>((resolve) => {
      const task = createSessionBodySourceBackfillTask({ db: temp.db, blobRoot: blobRoot!,
        idleDelayMs: 60_000, retryDelayMs: 60_000, onResult: resolve })
      const handle = task.start()!
      taskStop = handle.stop
    })

    await expect(result).resolves.toMatchObject({ sessionId: session.id, status: 'complete', messageCount: 1 })
    expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toEqual({ status: 'complete' })
    expect(conn.prepare('SELECT message_id FROM session_message_body_locator WHERE session_id=?').all(session.id))
      .toEqual([{ message_id: 'task-user' }])
  })

  it('continues to the next pending session when one session fails and is delayed for retry', async () => {
    const temp = createTempDatabase('session-body-source-backfill-task-failure-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const conn = getDbConnection(temp.db)
    const broken = createSession(temp.db, { name: 'broken source session' })
    appendMessage(temp.db, { id: 'missing-history-body', sessionId: broken.id, role: 'user', content: 'no source', timestamp: 1, status: 'sent' })
    const healthy = createSession(temp.db, { name: 'healthy source session' })
    appendMessage(temp.db, { id: 'healthy-body', sessionId: healthy.id, role: 'user', content: 'healthy', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, healthy.id)
    await history.appendBatch([
      { invocationId: 'healthy-invocation', turnId: 'healthy-turn', sequence: 1, schemaVersion: 1, eventId: 'healthy-context',
        idempotencyKey: 'healthy-context', kind: 'invocation-context-committed', payload: { messages: [
          { id: 'healthy-body', role: 'user', content: 'healthy', timestamp: 1 },
        ] } },
      { invocationId: 'healthy-invocation', turnId: 'healthy-turn', sequence: 2, schemaVersion: 1, eventId: 'healthy-complete',
        idempotencyKey: 'healthy-complete', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const results: Array<{ sessionId: string; status: string }> = []
    const task = createSessionBodySourceBackfillTask({ db: temp.db, blobRoot,
      idleDelayMs: 60_000, retryDelayMs: 60_000, onResult: (result) => results.push(result) })
    const handle = task.start()!
    taskStop = handle.stop

    await vi.waitFor(() => expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: broken.id, status: 'failed' }),
      expect.objectContaining({ sessionId: healthy.id, status: 'complete' }),
    ])), { timeout: 10_000 })
    expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(healthy.id))
      .toEqual({ status: 'complete' })
  })
})
