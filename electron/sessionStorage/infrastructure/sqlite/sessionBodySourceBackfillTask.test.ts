import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendMessage, createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { projectionSourceEventDigest } from './projectionSourceDependencyReader'
import type { AppDatabase } from '../../../database/sqliteStore'
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
    const body = 'task-body-'.repeat(9_000)
    appendMessage(temp.db, { id: 'task-user', sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'task-invocation', turnId: 'task-turn', sequence: 1, schemaVersion: 1, eventId: 'task-context',
        idempotencyKey: 'task-context', kind: 'invocation-context-committed', payload: { messages: [
          { id: 'task-user', role: 'user', content: body, timestamp: 1 },
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
    const sourceEvent = conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,
      session_seq,commit_order,created_at,payload_json FROM agent_history_events WHERE event_id='task-context'`).get() as
      Parameters<typeof projectionSourceEventDigest>[0]
    expect(conn.prepare(`SELECT source_digest FROM session_message_body_source_event
      WHERE session_id=? AND message_id='task-user' AND event_id='task-context'`).get(session.id))
      .toEqual({ source_digest: projectionSourceEventDigest(sourceEvent) })
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

  it('reduces and publishes a segmented large context body through the production maintenance task', async () => {
    const temp = createTempDatabase('session-body-source-backfill-task-segmented-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'segmented source backfill' })
    const content = 'large-context-body-'.repeat(400_000)
    appendMessage(temp.db, { id: 'segmented-task-user', sessionId: session.id, role: 'user', content, timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([{ invocationId: 'segmented-task-invocation', turnId: 'segmented-task-turn', sequence: 1,
      schemaVersion: 1, eventId: 'segmented-task-context', idempotencyKey: 'segmented-task-context',
      kind: 'invocation-context-committed', payload: { messages: [
        { id: 'segmented-task-user', role: 'user', content, timestamp: 1 },
      ] } }], 0)
    const result = new Promise<{ sessionId: string; status: string; messageCount?: number; error?: string }>((resolve) => {
      const task = createSessionBodySourceBackfillTask({ db: temp.db, blobRoot: blobRoot!,
        idleDelayMs: 60_000, retryDelayMs: 60_000, onResult: resolve })
      taskStop = task.start()!.stop
    })

    await expect(result).resolves.toMatchObject({ sessionId: session.id, status: 'complete', messageCount: 1 })
    const locator = conn.prepare(`SELECT fragment_locator,byte_length,sha256 FROM session_message_body_locator
      WHERE session_id=? AND message_id='segmented-task-user'`).get(session.id) as
      { fragment_locator: string; byte_length: number; sha256: string }
    const body = JSON.parse(await createSessionProjectionBlobStore(blobRoot).readVerified({ locator: locator.fragment_locator,
      byteLength: locator.byte_length, payloadDigest: locator.sha256 })) as { message?: { content?: string } }
    expect(body.message?.content).toBe(content)
  })

  it('reports and retries a database-unavailable scan instead of losing the maintenance loop', async () => {
    const temp = createTempDatabase('session-body-source-backfill-task-closed-db-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const closedDb = { filePath: temp.dbPath, save() {}, flushSave() {}, close() {} } as AppDatabase
    const result = new Promise<{ sessionId: string; status: string; error?: string }>((resolve) => {
      const task = createSessionBodySourceBackfillTask({ db: closedDb, blobRoot: blobRoot!, idleDelayMs: 60_000,
        retryDelayMs: 60_000, onResult: resolve })
      taskStop = task.start()!.stop
    })

    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'Database connection is closed' })
  })
})
