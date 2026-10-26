import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDatabase } from '../../../database/testHelpers'
import { appendMessage, createSession } from '../../../database/operations'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { runSessionBodySourceBackfill } from './sessionBodySourceBackfill'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'

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
})
