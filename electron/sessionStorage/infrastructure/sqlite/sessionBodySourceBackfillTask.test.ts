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
import { createSqliteSessionStorageHost } from '../../sqliteSessionStorage'
import { createSessionBodySourceBackfillTask } from './sessionBodySourceBackfillTask'
import { CHAT_BODY_PROJECTION_SPEC_VERSION } from '../../domain/scopeKey'

describe('session body source backfill task', () => {
  let cleanup: (() => void) | undefined
  let taskStop: (() => void) | undefined
  let blobRoot: string | undefined
  afterEach(async () => { taskStop?.(); taskStop = undefined; cleanup?.(); cleanup = undefined
    if (blobRoot) await fs.rm(blobRoot, { recursive: true, force: true }); blobRoot = undefined })

  it('completes an empty current message set without replaying stale History snapshots', async () => {
    const temp = createTempDatabase('session-body-source-backfill-empty-current-set-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'empty current message set' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'stale-context-invocation', turnId: 'stale-context-turn', sequence: 1, schemaVersion: 1,
        eventId: 'stale-context', idempotencyKey: 'stale-context', kind: 'invocation-context-committed', payload: {
          messages: [{ id: 'already-removed-message', role: 'user', content: 'stale body', timestamp: 1 }],
        } },
      { invocationId: 'stale-context-invocation', turnId: 'stale-context-turn', sequence: 2, schemaVersion: 1,
        eventId: 'stale-context-complete', idempotencyKey: 'stale-context-complete', kind: 'invocation-completed',
        payload: { status: 'completed' } },
    ], 0)

    const result = new Promise<{ sessionId: string; status: string; messageCount?: number; error?: string }>((resolve) => {
      const task = createSessionBodySourceBackfillTask({ db: temp.db, blobRoot: blobRoot!,
        idleDelayMs: 60_000, retryDelayMs: 60_000, onResult: resolve })
      taskStop = task.start()!.stop
    })

    await expect(result).resolves.toMatchObject({ sessionId: session.id, status: 'complete', messageCount: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_message_body_locator WHERE session_id=?').get(session.id))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT status,checkpoint_json FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toEqual({ status: 'complete', checkpoint_json: null })
  })

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
    const recoverable = createSession(temp.db, { name: 'source stream without events' })
    appendMessage(temp.db, { id: 'recoverable-history-body', sessionId: recoverable.id, role: 'user', content: 'pending source', timestamp: 1, status: 'sent' })
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,?)`)
      .run('recoverable-invocation', recoverable.id)
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
      expect.objectContaining({ sessionId: recoverable.id, status: 'failed' }),
      expect.objectContaining({ sessionId: healthy.id, status: 'complete' }),
    ])), { timeout: 10_000 })
    expect(results.find(({ sessionId }) => sessionId === broken.id)?.error).toBe('PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH')
    const missingSourceState = conn.prepare(`SELECT source_revision,terminal_source_revision,terminal_reducer_spec_version
      FROM session_body_source_state WHERE session_id=?`).get(broken.id) as
      { source_revision: number; terminal_source_revision: number | null; terminal_reducer_spec_version: number | null }
    expect(missingSourceState.terminal_source_revision).toBe(missingSourceState.source_revision)
    expect(missingSourceState.terminal_reducer_spec_version).toBe(CHAT_BODY_PROJECTION_SPEC_VERSION)
    expect(conn.prepare(`SELECT terminal_source_revision,terminal_reducer_spec_version FROM session_body_source_state WHERE session_id=?`)
      .get(recoverable.id)).toEqual({ terminal_source_revision: null, terminal_reducer_spec_version: null })
    expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(healthy.id))
      .toEqual({ status: 'complete' })

    await new SqliteAgentHistory(conn, 1, () => 10, broken.id).appendBatch([{ invocationId: 'recovered-invocation',
      turnId: 'recovered-turn', sequence: 1, schemaVersion: 1, eventId: 'recovered-context', idempotencyKey: 'recovered-context',
      kind: 'invocation-context-committed', payload: { messages: [
        { id: 'missing-history-body', role: 'user', content: 'recovered source', timestamp: 1 },
      ] } }], 0)
    handle.request()
    await vi.waitFor(() => expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(broken.id))
      .toEqual({ status: 'complete' }), { timeout: 10_000 })
    const recovered = conn.prepare(`SELECT source_revision,terminal_source_revision FROM session_body_source_state WHERE session_id=?`)
      .get(broken.id) as { source_revision: number; terminal_source_revision: number | null }
    expect(recovered.source_revision).toBeGreaterThan(missingSourceState.source_revision)
    expect(recovered.terminal_source_revision).toBe(missingSourceState.source_revision)
  })

  it('persists deterministic source rejection across restart and retries after the source revision changes', async () => {
    const temp = createTempDatabase('session-body-source-backfill-terminal-rejection-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'deterministically rejected source' })
    appendMessage(temp.db, { id: 'rejected-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(conn, 1, () => 10, session.id).appendBatch([{ invocationId: 'rejected-invocation',
      turnId: 'rejected-turn', sequence: 1, schemaVersion: 1, eventId: 'rejected-context', idempotencyKey: 'rejected-context',
      kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'body', timestamp: 1 }] } } as never], 0)
    const results: Array<{ sessionId: string; status: string; error?: string }> = []
    const startTask = (reducerSpecVersion = CHAT_BODY_PROJECTION_SPEC_VERSION) => createSessionBodySourceBackfillTask({
      db: temp.db, blobRoot: blobRoot!, reducerSpecVersion, idleDelayMs: 60_000, retryDelayMs: 20,
      onResult: (result) => results.push(result) }).start()!
    let handle = startTask()
    taskStop = () => handle.stop()

    await vi.waitFor(() => expect(results.filter(({ status }) => status === 'failed')).toHaveLength(1), { timeout: 10_000 })
    const rejected = conn.prepare(`SELECT source_revision,terminal_source_revision,terminal_reducer_spec_version
      FROM session_body_source_state WHERE session_id=?`).get(session.id) as
      { source_revision: number; terminal_source_revision: number | null; terminal_reducer_spec_version: number | null }
    expect(rejected.terminal_source_revision).toBe(rejected.source_revision)
    expect(rejected.terminal_reducer_spec_version).toBe(CHAT_BODY_PROJECTION_SPEC_VERSION)

    handle.stop()
    handle = startTask()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(results.filter(({ status }) => status === 'failed')).toHaveLength(1)

    handle.stop()
    const upgradedReducerSpecVersion = CHAT_BODY_PROJECTION_SPEC_VERSION + 1
    handle = startTask(upgradedReducerSpecVersion)
    await vi.waitFor(() => expect(results.filter(({ status }) => status === 'failed')).toHaveLength(2), { timeout: 10_000 })

    conn.prepare(`UPDATE agent_history_events SET payload_json=? WHERE event_id='rejected-context'`)
      .run(JSON.stringify({ messages: [{ id: 'rejected-user', role: 'user', content: 'body', timestamp: 1 }] }))
    handle.request()
    await vi.waitFor(() => expect(results.at(-1)).toMatchObject({ sessionId: session.id, status: 'complete' }), { timeout: 10_000 })
    const recovered = conn.prepare(`SELECT source_revision,status,terminal_source_revision,terminal_reducer_spec_version
      FROM session_body_source_state WHERE session_id=?`).get(session.id) as
      { source_revision: number; status: string; terminal_source_revision: number | null; terminal_reducer_spec_version: number | null }
    expect(recovered.status).toBe('complete')
    expect(recovered.source_revision).toBeGreaterThan(rejected.source_revision)
    expect(recovered.terminal_source_revision).toBe(rejected.source_revision)
    expect(recovered.terminal_reducer_spec_version).toBe(upgradedReducerSpecVersion)
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

  it('does not turn a completed backfill into a failure when its observer throws', async () => {
    const temp = createTempDatabase('session-body-source-backfill-task-observer-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'observer isolation' })
    appendMessage(temp.db, { id: 'observer-message', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(conn, 1, () => 10, session.id).appendBatch([{ invocationId: 'observer-invocation',
      turnId: 'observer-turn', sequence: 1, schemaVersion: 1, eventId: 'observer-context', idempotencyKey: 'observer-context',
      kind: 'invocation-context-committed', payload: { messages: [{ id: 'observer-message', role: 'user', content: 'body', timestamp: 1 }] } }], 0)
    const results: Array<{ sessionId: string; status: string }> = []
    const task = createSessionBodySourceBackfillTask({ db: temp.db, blobRoot, idleDelayMs: 60_000,
      onResult: (result) => { results.push(result); throw new Error('observer failed') } })
    taskStop = task.start()!.stop

    await vi.waitFor(() => expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toEqual({ status: 'complete' }), { timeout: 10_000 })
    expect(results).toEqual([{ sessionId: session.id, status: 'complete', messageCount: 1 }])
  })

  it('wakes the registered backfill after a new History commit', async () => {
    const temp = createTempDatabase('session-body-source-backfill-task-wake-')
    cleanup = temp.cleanup
    blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const task = createSessionBodySourceBackfillTask({ db: temp.db, blobRoot, idleDelayMs: 60_000 })
    const host = createSqliteSessionStorageHost(temp.db, { storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) }, maintenanceTasks: [task] })
    taskStop = () => { void host.lifecycle.stop({ deadlineMs: 5_000 }) }
    host.lifecycle.allowBackgroundWork()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const session = createSession(temp.db, { name: 'wake source backfill' })
    appendMessage(temp.db, { id: 'wake-message', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    const history = host.storage.execution.historyFor({ sessionId: session.id })
    await history.appendBatch([{ invocationId: 'wake-invocation', turnId: 'wake-turn', sequence: 1, schemaVersion: 1,
      eventId: 'wake-context', idempotencyKey: 'wake-context', kind: 'invocation-context-committed', payload: {
        messages: [{ id: 'wake-message', role: 'user', content: 'body', timestamp: 1 }],
      } }], 0)

    await vi.waitFor(() => expect(getDbConnection(temp.db).prepare('SELECT status FROM session_body_source_state WHERE session_id=?')
      .get(session.id)).toEqual({ status: 'complete' }), { timeout: 10_000 })
  })
})
