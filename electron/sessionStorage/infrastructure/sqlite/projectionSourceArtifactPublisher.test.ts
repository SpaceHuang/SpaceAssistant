import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDatabase } from '../../../database/testHelpers'
import { createSession } from '../../../database/operations'
import { getDbConnection } from '../../../database/sqliteStore'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { publishProjectionInvocationSourceArtifacts } from './projectionSourceArtifactPublisher'
import { reduceProjectionInvocationChatBodySources } from './projectionChatBodySourceReducer'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'

describe('projection source artifact publisher', () => {
  let cleanupDb: (() => void) | undefined
  let cleanupRoot: string | undefined
  afterEach(async () => {
    cleanupDb?.(); cleanupDb = undefined
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true })
    cleanupRoot = undefined
  })

  it('publishes verified fragments and replaces a compacted message source atomically', async () => {
    const temp = createTempDatabase('projection-source-publish-')
    cleanupDb = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'source artifact publish' })
    cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-source-publish-blobs-'))
    const blobs = createSessionProjectionBlobStore(cleanupRoot)
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'source-first', turnId: 'source-first', sequence: 1, schemaVersion: 1, eventId: 'source-first-1',
        idempotencyKey: 'source-first-1', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'source-user', role: 'user', content: 'first', timestamp: 1 },
          { id: 'old-message', role: 'assistant', content: 'removed by compaction', timestamp: 2 }] } },
      { invocationId: 'source-first', turnId: 'source-first', sequence: 2, schemaVersion: 1, eventId: 'source-first-2',
        idempotencyKey: 'source-first-2', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    await history.appendBatch([
      { invocationId: 'source-later', turnId: 'source-later', sequence: 1, schemaVersion: 1, eventId: 'source-later-1',
        idempotencyKey: 'source-later-1', kind: 'transcript-compacted',
        payload: { messages: [{ id: 'source-user', role: 'user', content: 'compacted', timestamp: 1 }] } },
      { invocationId: 'source-later', turnId: 'source-later', sequence: 2, schemaVersion: 1, eventId: 'source-later-2',
        idempotencyKey: 'source-later-2', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const facts: ProjectionMessageFact[] = [
      { id: 'source-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'compacted' },
      { id: 'old-message', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'removed by compaction' },
    ]
    const readInvocation = (invocationId: string) => (conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,
      schema_version,kind,session_seq,commit_order,created_at,payload_json FROM agent_history_events
      WHERE invocation_id=? ORDER BY sequence`).all(invocationId) as Array<{ invocation_id: string; turn_id: string; sequence: number;
        event_id: string; idempotency_key: string; schema_version: number; kind: string; session_seq: number;
        commit_order: number; created_at: number; payload_json: string }>).map((row) => ({
      invocationId: row.invocation_id, turnId: row.turn_id, sequence: row.sequence, eventId: row.event_id,
      idempotencyKey: row.idempotency_key, schemaVersion: row.schema_version, kind: row.kind,
      sessionSequence: row.session_seq, commitOrder: row.commit_order, createdAt: row.created_at, payloadJson: row.payload_json,
    } as ProjectionHistoryChunkEvent))
    const firstSource = reduceProjectionInvocationChatBodySources(readInvocation('source-first'), facts)
    const source = reduceProjectionInvocationChatBodySources(readInvocation('source-later'), facts)
    expect(source.replacesPriorMessages).toBe(true)
    const identity = readProjectionSourceIdentity(conn, session.id, session.generation)!
    const sourceRevision = (conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(session.id) as { source_revision: number }).source_revision

    const publisherInput = { db: temp.db, blobs, sessionId: session.id, sessionGeneration: session.generation,
      sourceRevision, sourceIdentityJson: identity, historyWatermarkJson: JSON.stringify(JSON.parse(identity).historyWatermark), reducerSpecVersion: 1 }
    await publishProjectionInvocationSourceArtifacts({ ...publisherInput, source: firstSource })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_message_body_locator WHERE session_id=?').get(session.id))
      .toEqual({ count: 2 })
    await publishProjectionInvocationSourceArtifacts({ ...publisherInput, source })

    const locator = conn.prepare('SELECT sequence,fragment_locator,byte_length,sha256 FROM session_message_body_locator WHERE session_id=? AND message_id=?')
      .get(session.id, 'source-user') as { sequence: number; fragment_locator: string; byte_length: number; sha256: string }
    expect(JSON.parse(await blobs.readVerified({ locator: locator.fragment_locator, byteLength: locator.byte_length, payloadDigest: locator.sha256 })))
      .toMatchObject({ sequence: 0, message: { id: 'source-user', content: 'compacted' } })
    expect(conn.prepare('SELECT invocation_id FROM session_message_body_source_event WHERE session_id=? AND message_id=?')
      .all(session.id, 'source-user')).toEqual([{ invocation_id: 'source-later' }, { invocation_id: 'source-later' }])
    expect(conn.prepare('SELECT message_id FROM session_message_body_locator WHERE session_id=?').all(session.id))
      .toEqual([{ message_id: 'source-user' }])
    expect(conn.prepare('SELECT invocation_id FROM session_body_source_manifest WHERE session_id=?').all(session.id))
      .toEqual([{ invocation_id: 'source-later' }])
    await history.appendBatch([
      { invocationId: 'source-empty', turnId: 'source-empty', sequence: 1, schemaVersion: 1, eventId: 'source-empty-1',
        idempotencyKey: 'source-empty-1', kind: 'transcript-compacted', payload: { messages: [] } },
      { invocationId: 'source-empty', turnId: 'source-empty', sequence: 2, schemaVersion: 1, eventId: 'source-empty-2',
        idempotencyKey: 'source-empty-2', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const latestIdentity = readProjectionSourceIdentity(conn, session.id, session.generation)!
    const latestRevision = (conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(session.id) as { source_revision: number }).source_revision
    const emptySource = reduceProjectionInvocationChatBodySources(readInvocation('source-empty'), [])
    expect(emptySource).toMatchObject({ replacesPriorMessages: true, messages: [] })
    await publishProjectionInvocationSourceArtifacts({ ...publisherInput, sourceRevision: latestRevision, sourceIdentityJson: latestIdentity,
      historyWatermarkJson: JSON.stringify(JSON.parse(latestIdentity).historyWatermark), source: emptySource })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_message_body_locator WHERE session_id=?').get(session.id))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_body_source_manifest WHERE session_id=?').get(session.id))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT source_revision,status FROM session_body_source_state WHERE session_id=?').get(session.id))
      .toMatchObject({ source_revision: latestRevision, status: 'pending' })
  })

  it('leaves no readable locator when source revision changes before publication', async () => {
    const temp = createTempDatabase('projection-source-publish-fence-')
    cleanupDb = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'source artifact fence' })
    cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-source-publish-fence-blobs-'))
    const blobs = createSessionProjectionBlobStore(cleanupRoot)
    const identity = readProjectionSourceIdentity(conn, session.id, session.generation)!
    const source = reduceProjectionInvocationChatBodySources([{
      invocationId: 'fenced', turnId: 'fenced', sequence: 1, eventId: 'fenced-event', idempotencyKey: 'fenced-event',
      schemaVersion: 1, kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
      payloadJson: JSON.stringify({ messages: [{ id: 'fenced-message', role: 'user', content: 'body', timestamp: 1 }] }),
    }], [{ id: 'fenced-message', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy',
      writeMode: null, storedContent: 'body' }])
    const revision = (conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(session.id) as { source_revision: number }).source_revision
    conn.prepare("UPDATE session_body_source_state SET source_revision=source_revision+1 WHERE session_id=?").run(session.id)
    await expect(publishProjectionInvocationSourceArtifacts({ db: temp.db, blobs, sessionId: session.id,
      sessionGeneration: session.generation, sourceRevision: revision, sourceIdentityJson: identity,
      historyWatermarkJson: JSON.stringify(JSON.parse(identity).historyWatermark), reducerSpecVersion: 1, source }))
      .rejects.toThrow('PROJECTION_SOURCE_REVISION_CHANGED')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_message_body_locator WHERE session_id=?').get(session.id))
      .toEqual({ count: 0 })
  })
})
