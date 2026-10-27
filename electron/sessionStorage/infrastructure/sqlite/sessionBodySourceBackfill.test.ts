import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../../../database/testHelpers'
import { appendMessage, createSession, deleteSession } from '../../../database/operations'
import { getDbConnection, reopenDatabaseConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { runSessionBodySourceBackfill } from './sessionBodySourceBackfill'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { createSqliteSessionStorage } from '../../sqliteSessionStorage'
import { readChatPageAfterPreparation } from '../../public/readMessages'
import { createSessionQueries } from '../../queries'

describe('session body source backfill', () => {
  let cleanup: (() => void) | undefined
  let blobRoot: string | undefined
  afterEach(async () => {
    cleanup?.(); cleanup = undefined
    if (blobRoot) await fs.rm(blobRoot, { recursive: true, force: true })
    blobRoot = undefined
  })

  it('publishes complete only after all canonical messages and locator sequences match', async () => {
    const temp = createTempDatabase('session-body-source-backfill-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'source backfill' })
    appendMessage(temp.db, { id: 'backfill-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'backfill-invocation', turnId: 'backfill-turn', sequence: 1, schemaVersion: 1, eventId: 'backfill-1',
        idempotencyKey: 'backfill-1', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'backfill-user', role: 'user', content: 'body', timestamp: 1 }] } },
      { invocationId: 'backfill-invocation', turnId: 'backfill-turn', sequence: 2, schemaVersion: 1, eventId: 'backfill-2',
        idempotencyKey: 'backfill-2', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const rows = conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,
      commit_order,created_at,payload_json FROM agent_history_events WHERE invocation_id='backfill-invocation' ORDER BY sequence`)
      .all() as Array<{ invocation_id: string; turn_id: string; sequence: number; event_id: string; idempotency_key: string;
        schema_version: number; kind: string; session_seq: number; commit_order: number; created_at: number; payload_json: string }>
    const events: ProjectionHistoryChunkEvent[] = rows.map((row) => ({ invocationId: row.invocation_id, turnId: row.turn_id,
      sequence: row.sequence, eventId: row.event_id, idempotencyKey: row.idempotency_key, schemaVersion: row.schema_version,
      kind: row.kind, sessionSequence: row.session_seq, commitOrder: row.commit_order, createdAt: row.created_at, payloadJson: row.payload_json }))
    const facts: ProjectionMessageFact[] = [{ id: 'backfill-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop',
      contentStorageState: 'legacy', writeMode: null, storedContent: 'body' }]
    blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-body-source-backfill-blobs-'))
    const blobs = createSessionProjectionBlobStore(blobRoot)
    const result = await runSessionBodySourceBackfill({ db: temp.db, sessionId: session.id, reducerSpecVersion: 1,
      blobs, invocations: (async function* () { yield { events, messageFacts: facts } })() })

    expect(result).toMatchObject({ kind: 'complete', invocationCount: 1, messageCount: 1 })
    expect(readProjectionSourceIdentity(conn, session.id, session.generation)).toBeTruthy()
    const locator = conn.prepare('SELECT fragment_locator,byte_length,sha256 FROM session_message_body_locator WHERE session_id=? AND message_id=?')
      .get(session.id, 'backfill-user') as { fragment_locator: string; byte_length: number; sha256: string }
    expect(JSON.parse(await blobs.readVerified({ locator: locator.fragment_locator, byteLength: locator.byte_length, payloadDigest: locator.sha256 })))
      .toMatchObject({ sequence: 0, message: { id: 'backfill-user', content: 'body' } })
    expect(conn.prepare('SELECT status,checkpoint_json FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toEqual({ status: 'complete', checkpoint_json: null })
  })

  it('waits asynchronously for complete locators and serves a cold canonical page without preparing the projection', async () => {
    const temp = createTempDatabase('session-source-page-cold-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'cold source page' })
    const body = 'body restored from the source locator'
    appendMessage(temp.db, { id: 'cold-source-user', sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([{ invocationId: 'cold-source-invocation', turnId: 'cold-source-turn', sequence: 1,
      schemaVersion: 1, eventId: 'cold-source-context', idempotencyKey: 'cold-source-context',
      kind: 'invocation-context-committed', payload: { messages: [{ id: 'cold-source-user', role: 'user', content: body, timestamp: 1 }] } }], 0)
    conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value
      FROM spill_reference_meta WHERE meta_key='canonical_change_generation') WHERE owner_table='agent_history_events'`).run()
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const rows = conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,
      commit_order,created_at,payload_json FROM agent_history_events WHERE session_id=? ORDER BY session_seq`).all(session.id) as
      Array<{ invocation_id: string; turn_id: string; sequence: number; event_id: string; idempotency_key: string;
        schema_version: number; kind: string; session_seq: number; commit_order: number; created_at: number; payload_json: string }>
    const events: ProjectionHistoryChunkEvent[] = rows.map((row) => ({ invocationId: row.invocation_id, turnId: row.turn_id,
      sequence: row.sequence, eventId: row.event_id, idempotencyKey: row.idempotency_key, schemaVersion: row.schema_version,
      kind: row.kind, sessionSequence: row.session_seq, commitOrder: row.commit_order, createdAt: row.created_at, payloadJson: row.payload_json }))
    const facts: ProjectionMessageFact[] = [{ id: 'cold-source-user', role: 'user', timestamp: 1, sequence: 0,
      queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' }]
    blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-source-page-cold-blobs-'))
    const requestBackfill = vi.fn()
    const storage = createSqliteSessionStorage(temp.db, { projectionBlobRoot: blobRoot, requestBodySourceBackfill: requestBackfill,
      sourceBackfillWaitMs: 10_000 })
    let releaseBackfill!: () => void
    const backfillGate = new Promise<void>((resolve) => { releaseBackfill = resolve })
    const backfill = runSessionBodySourceBackfill({ db: temp.db, sessionId: session.id, reducerSpecVersion: 1,
      blobs: createSessionProjectionBlobStore(blobRoot), invocations: (async function* () {
        await backfillGate
        yield { events, messageFacts: facts }
      })() })
    let eventLoopTicks = 0
    const ticker = setInterval(() => { eventLoopTicks += 1 }, 5)
    const pageRead = readChatPageAfterPreparation(storage, { sessionId: session.id, limit: 10 })
    let page: Awaited<typeof pageRead>
    try {
      await vi.waitFor(() => expect(requestBackfill).toHaveBeenCalledTimes(1))
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      expect(eventLoopTicks).toBeGreaterThan(0)
      releaseBackfill()
      const [, resolvedPage] = await Promise.all([backfill, pageRead])
      page = resolvedPage
    } finally {
      clearInterval(ticker)
      releaseBackfill()
    }

    expect(page.entries.map(({ message }) => ({ id: message.id, content: message.content })))
      .toEqual([{ id: 'cold-source-user', content: body }])
    expect(requestBackfill).toHaveBeenCalledTimes(1)

    const locator = conn.prepare(`SELECT fragment_locator,byte_length,sha256 FROM session_message_body_locator
      WHERE session_id=? AND message_id=?`).get(session.id, 'cold-source-user') as
      { fragment_locator: string; byte_length: number; sha256: string }
    const fragmentPath = path.join(blobRoot, locator.fragment_locator)
    await fs.writeFile(fragmentPath, Buffer.from('corrupt source fragment'))
    await expect(readChatPageAfterPreparation(storage, { sessionId: session.id, limit: 10 }))
      .rejects.toThrow('PROJECTION_BLOB_CORRUPT')
  })

  it('keeps source-locator pages session-scoped across an A-to-B-to-A switch sequence', async () => {
    const temp = createTempDatabase('session-source-page-switch-sequence-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const first = createSession(temp.db, { name: 'source page session A' })
    const second = createSession(temp.db, { name: 'source page session B' })
    const rows = [
      { session: first, id: 'switch-a-message', invocationId: 'switch-a-invocation', turnId: 'switch-a-turn',
        eventId: 'switch-a-context', body: 'private body for session A', timestamp: 1 },
      { session: second, id: 'switch-b-message', invocationId: 'switch-b-invocation', turnId: 'switch-b-turn',
        eventId: 'switch-b-context', body: 'private body for session B', timestamp: 2 },
    ]
    for (const item of rows) {
      appendMessage(temp.db, { id: item.id, sessionId: item.session.id, role: 'user', content: item.body,
        timestamp: item.timestamp, status: 'sent' })
      await new SqliteAgentHistory(conn, 1, () => 10, item.session.id).appendBatch([{ invocationId: item.invocationId,
        turnId: item.turnId, sequence: 1, schemaVersion: 1, eventId: item.eventId, idempotencyKey: item.eventId,
        kind: 'invocation-context-committed', payload: { messages: [
          { id: item.id, role: 'user', content: item.body, timestamp: item.timestamp },
        ] } }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(item.session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run(item.id)
    }
    conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value
      FROM spill_reference_meta WHERE meta_key='canonical_change_generation') WHERE owner_table='agent_history_events'`).run()
    blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-source-page-switch-blobs-'))
    const blobs = createSessionProjectionBlobStore(blobRoot)
    for (const item of rows) {
      const sourceIdentityJson = readProjectionSourceIdentity(conn, item.session.id, item.session.generation)!
      const historyRows = conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,
        commit_order,created_at,payload_json FROM agent_history_events WHERE session_id=? ORDER BY session_seq`).all(item.session.id) as
        Array<{ invocation_id: string; turn_id: string; sequence: number; event_id: string; idempotency_key: string;
          schema_version: number; kind: string; session_seq: number; commit_order: number; created_at: number; payload_json: string }>
      const events: ProjectionHistoryChunkEvent[] = historyRows.map((row) => ({ invocationId: row.invocation_id, turnId: row.turn_id,
        sequence: row.sequence, eventId: row.event_id, idempotencyKey: row.idempotency_key, schemaVersion: row.schema_version,
        kind: row.kind, sessionSequence: row.session_seq, commitOrder: row.commit_order, createdAt: row.created_at, payloadJson: row.payload_json }))
      const facts: ProjectionMessageFact[] = [{ id: item.id, role: 'user', timestamp: item.timestamp, sequence: 0,
        queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' }]
      await runSessionBodySourceBackfill({ db: temp.db, blobs, sessionId: item.session.id, reducerSpecVersion: 1,
        invocations: (async function* () { yield { events, messageFacts: facts } })() })
      expect(sourceIdentityJson).toBeTruthy()
    }

    const storage = createSqliteSessionStorage(temp.db, { projectionBlobRoot: blobRoot, requestBodySourceBackfill: () => undefined })
    const reads = [first.id, second.id, first.id]
    for (const sessionId of reads) {
      const page = await readChatPageAfterPreparation(storage, { sessionId, limit: 10 })
      const expected = rows.find((item) => item.session.id === sessionId)!
      expect(page.entries.map(({ message }) => ({ id: message.id, content: message.content })))
        .toEqual([{ id: expected.id, content: expected.body }])
    }
  })

  it('does not mark complete when a canonical message is missing from the locator output', async () => {
    const temp = createTempDatabase('session-body-source-incomplete-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'source backfill incomplete' })
    appendMessage(temp.db, { id: 'unlocated-message', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-body-source-incomplete-blobs-'))
    await expect(runSessionBodySourceBackfill({ db: temp.db, sessionId: session.id, reducerSpecVersion: 1,
      blobs: createSessionProjectionBlobStore(blobRoot), invocations: (async function* () {})() }))
      .rejects.toThrow('PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH')
    expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toEqual({ status: 'backfilling' })
  })

  it('discards a locator page if the selected message window changes during body materialization', async () => {
    const temp = createTempDatabase('session-source-page-drift-')
    cleanup = temp.cleanup
    const session = createSession(temp.db, { name: 'source page drift' })
    appendMessage(temp.db, { id: 'source-page-drift-user', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(temp.db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const sourceIdentityJson = 'fixed-source-identity'
    const queries = createSessionQueries(temp.db, {
      currentSourceIdentity: () => sourceIdentityJson,
      currentAuthoritySourceIdentity: () => sourceIdentityJson,
      readSourceBodies: async ({ messageIds }) => {
        appendMessage(temp.db!, { id: 'concurrent-legacy-user', sessionId: session.id, role: 'user', content: 'new', timestamp: 2, status: 'sent' })
        return { messages: messageIds.map((id) => ({ id, role: 'user' as const, timestamp: 1, content: 'stale page body' })), workerThreadId: 1 }
      },
      readBodies: async () => ({ messages: [], workerThreadId: 1 }),
      searchBodies: async () => ({ messages: [], workerThreadId: 1 }),
      invalidate: () => undefined
    })

    await expect(queries.readSourceChatPage?.({ sessionId: session.id, limit: 20 })).rejects.toThrow('PROJECTION_SOURCE_PAGE_CHANGED')
  })

  it('does not return a selected page after its session is deleted during body materialization', async () => {
    const temp = createTempDatabase('session-source-page-delete-inflight-')
    cleanup = temp.cleanup
    const session = createSession(temp.db, { name: 'source page delete in flight' })
    appendMessage(temp.db, { id: 'delete-inflight-user', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(temp.db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id=?").run('delete-inflight-user')
    const currentIdentity = () => readProjectionSourceIdentity(conn, session.id, session.generation) ?? undefined
    const readSourceBodies = vi.fn(async ({ messageIds }: { messageIds: readonly string[] }) => {
      deleteSession(temp.db!, session.id, { flush: false })
      return { messages: messageIds.map((id) => ({ id, role: 'user' as const, timestamp: 1, content: 'must not escape' })), workerThreadId: 1 }
    })
    const queries = createSessionQueries(temp.db, { currentSourceIdentity: currentIdentity,
      currentAuthoritySourceIdentity: currentIdentity, readSourceBodies,
      readBodies: async () => ({ messages: [], workerThreadId: 1 }), searchBodies: async () => ({ messages: [], workerThreadId: 1 }),
      invalidate: () => undefined })

    await expect(readChatPageAfterPreparation({ ensureChatBodyV1: async () => { throw new Error('SESSION_NOT_FOUND') }, queries },
      { sessionId: session.id, limit: 10 })).rejects.toThrow('SESSION_NOT_FOUND')
    expect(readSourceBodies).toHaveBeenCalledOnce()
  })

  it('rejects instead of returning a page when the database closes before final source validation', async () => {
    const temp = createTempDatabase('session-source-page-close-inflight-')
    cleanup = temp.cleanup
    const session = createSession(temp.db, { name: 'source page close in flight' })
    appendMessage(temp.db, { id: 'close-inflight-user', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(temp.db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id=?").run('close-inflight-user')
    const currentIdentity = () => readProjectionSourceIdentity(getDbConnection(temp.db!), session.id, session.generation) ?? undefined
    const readSourceBodies = vi.fn(async ({ messageIds }: { messageIds: readonly string[] }) => {
      temp.db.close()
      return { messages: messageIds.map((id) => ({ id, role: 'user' as const, timestamp: 1, content: 'must not escape' })), workerThreadId: 1 }
    })
    const queries = createSessionQueries(temp.db, { currentSourceIdentity: currentIdentity,
      currentAuthoritySourceIdentity: currentIdentity, readSourceBodies,
      readBodies: async () => ({ messages: [], workerThreadId: 1 }), searchBodies: async () => ({ messages: [], workerThreadId: 1 }),
      invalidate: () => undefined })

    try {
      await expect(readChatPageAfterPreparation({ ensureChatBodyV1: async () => { throw new Error('projection fallback must not run') }, queries },
        { sessionId: session.id, limit: 10 })).rejects.toThrow('Database connection is closed')
      expect(readSourceBodies).toHaveBeenCalledOnce()
    } finally { reopenDatabaseConnection(temp.db) }
  })

  it('passes cancellation into the worker before processing a backfill invocation', async () => {
    const temp = createTempDatabase('session-body-source-backfill-cancel-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'source backfill cancelled' })
    blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-body-source-backfill-cancel-blobs-'))
    const controller = new AbortController()
    const reason = new Error('maintenance stopped')
    controller.abort(reason)

    await expect(runSessionBodySourceBackfill({ db: temp.db, sessionId: session.id, reducerSpecVersion: 1,
      blobs: createSessionProjectionBlobStore(blobRoot), signal: controller.signal,
      invocations: (async function* () { throw new Error('invocation source must not be consumed after cancellation') })() }))
      .rejects.toBe(reason)
    expect(conn.prepare('SELECT status FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toEqual({ status: 'pending' })
  })
})
