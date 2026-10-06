import { describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession, getMessages } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection, openSqliteDatabase } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'
import { backfillLegacySessionProjectionBaseline } from './sessionProjectionLegacyBaseline'

describe('legacy session projection baseline', () => {
  it('backfills ordered canonical bodies while retaining the full SQLite message skeleton', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'legacy baseline', model: 'test' })
    appendMessage(db, { id: 'baseline-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1,
      status: 'sent', attachments: [{ id: 'attachment', stagingKey: 'chat-attachments/s/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 10 }],
      imagesDeliveredToApi: true })
    appendMessage(db, { id: 'baseline-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2,
      status: 'completed', toolCalls: [{ id: 'call-1', toolName: 'search', input: { q: 'x' }, result: { data: 'done', success: true }, status: 'completed', riskLevel: 'low' }],
      thinking: { content: 'private reasoning', isVisible: false, startTime: 2 },
      contentSegments: [{ content: 'answer segment', startTime: 2 }], skillHints: [{ id: 'skill', text: 'hint', shownAt: 2 }] })

    const result = await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 })

    expect(result).toMatchObject({ kind: 'migrated', messageCount: 2 })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1', messages: [
      { id: 'baseline-user', role: 'user', content: 'question', timestamp: 1, status: 'sent', attachments: [{ id: 'attachment' }], imagesDeliveredToApi: true },
      { id: 'baseline-assistant', role: 'assistant', content: 'answer', timestamp: 2, status: 'completed',
        toolCalls: [{ id: 'call-1', status: 'completed', result: { data: 'done', success: true } }],
        thinking: { content: 'private reasoning', isVisible: false, startTime: 2 },
        contentSegments: [{ content: 'answer segment', startTime: 2 }], skillHints: [{ id: 'skill', text: 'hint', shownAt: 2 }] }
    ] })
    expect(getMessages(db, session.id).map(({ id, content }) => ({ id, content }))).toEqual([
      { id: 'baseline-user', content: 'question' }, { id: 'baseline-assistant', content: 'answer' }
    ])
    expect(getDbConnection(db).prepare('SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
      .toEqual([{ id: 'baseline-user', sequence: 0 }, { id: 'baseline-assistant', sequence: 1 }])
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 1 })
    db.close()
  })

  it('refuses system-role rows without writing History or granting eligibility', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'system role legacy', model: 'test' })
    appendMessage(db, { id: 'baseline-system', sessionId: session.id, role: 'system', content: 'system content', timestamp: 1, status: 'sent' })

    const result = await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 })

    expect(result).toEqual({ kind: 'rejected', reason: 'unsupported-role' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    expect(getDbConnection(db).prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    db.close()
  })

  it('is idempotent across repeated calls and only seeds one canonical baseline', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'repeat baseline', model: 'test' })
    appendMessage(db, { id: 'repeat-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })

    const first = await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 })
    const second = await backfillLegacySessionProjectionBaseline(db, session.id, { now: 4 })

    expect(first.kind).toBe('migrated')
    expect(second.kind).toBe('already-migrated')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 1 })
    db.close()
  })

  it('rejects a message-skeleton change during canonical payload preparation', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'changing baseline', model: 'test' })
    appendMessage(db, { id: 'changing-user', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
    const originalAppend = SqliteAgentHistory.prototype.appendBatch
    vi.spyOn(SqliteAgentHistory.prototype, 'appendBatch').mockImplementation(async function (events, expectedVersion, transcriptCommit) {
      getDbConnection(db).prepare('UPDATE messages SET content=? WHERE id=?').run('changed concurrently', 'changing-user')
      return originalAppend.call(this, events, expectedVersion, transcriptCommit)
    })

    const result = await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 })

    expect(result).toEqual({ kind: 'rejected', reason: 'skeleton-changed' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    vi.restoreAllMocks()
    db.close()
  })

  it('leaves empty sessions outside the message baseline cohort', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'empty baseline', model: 'test' })

    expect(await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 }))
      .toEqual({ kind: 'rejected', reason: 'empty-session' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    db.close()
  })

  it('rejects an unsettled assistant message without creating canonical History', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'unsettled baseline', model: 'test' })
    appendMessage(db, { id: 'unsettled-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' })

    expect(await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 }))
      .toEqual({ kind: 'rejected', reason: 'unsupported-status' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    db.close()
  })

  it('refuses writes after the session content cleanup fence is active', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'cleanup fenced baseline', model: 'test' })
    appendMessage(db, { id: 'cleanup-fenced-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    getDbConnection(db).prepare("UPDATE session_message_content_cutover SET cleanup_state='write-stopped' WHERE session_id=?").run(session.id)

    expect(await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 }))
      .toEqual({ kind: 'rejected', reason: 'cleanup-fenced' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    db.close()
  })

  it('refuses to backfill a session whose body ownership already moved to canonical', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical owner already selected', model: 'test' })
    appendMessage(db, { id: 'already-canonical-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)

    expect(await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 }))
      .toEqual({ kind: 'rejected', reason: 'history-conflict' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    db.close()
  })

  it('does not append a second baseline when existing History conflicts with legacy bodies', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'baseline history conflict', model: 'test' })
    appendMessage(db, { id: 'conflict-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'conflict-existing-history', turnId: 'conflict-turn', sequence: 1, schemaVersion: 1,
      eventId: 'conflict-context', idempotencyKey: 'conflict-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'conflict-user', role: 'user', content: 'different body', timestamp: 1 }] }
    }], 0)
    getDbConnection(db).prepare('UPDATE messages SET content=? WHERE id=?').run('legacy body', 'conflict-user')

    expect(await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 }))
      .toEqual({ kind: 'rejected', reason: 'history-conflict' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 1 })
    expect(getDbConnection(db).prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('conflict-user')).toEqual({ content: 'legacy body' })
    db.close()
  })

  it('fences a product-to-internal scope change during canonical payload preparation', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'scope changes during baseline', model: 'test' })
    appendMessage(db, { id: 'scope-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    const originalAppend = SqliteAgentHistory.prototype.appendBatch
    vi.spyOn(SqliteAgentHistory.prototype, 'appendBatch').mockImplementation(async function (events, expectedVersion, transcriptCommit) {
      getDbConnection(db).prepare("UPDATE sessions SET ownership='internal',visibility='hidden' WHERE id=?").run(session.id)
      return originalAppend.call(this, events, expectedVersion, transcriptCommit)
    })

    const result = await backfillLegacySessionProjectionBaseline(db, session.id, { now: 3 })

    expect(result).toEqual({ kind: 'rejected', reason: 'scope-changed' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 0 })
    vi.restoreAllMocks()
    db.close()
  })

  it('reopens with canonical body authority while the legacy skeleton remains intact', async () => {
    const temp = createTempDatabase('legacy-projection-baseline-reopen-')
    const session = createSession(temp.db, { name: 'reopen baseline', model: 'test' })
    appendMessage(temp.db, { id: 'reopen-user', sessionId: session.id, role: 'user', content: 'persisted body', timestamp: 7,
      status: 'sent', attachments: [{ id: 'persisted-attachment', stagingKey: 'chat-attachments/s/file.png', fileName: 'file.png', mimeType: 'image/png', byteLength: 8 }] })
    expect(await backfillLegacySessionProjectionBaseline(temp.db, session.id, { now: 8 })).toMatchObject({ kind: 'migrated' })
    temp.db.close()

    const reopened = openSqliteDatabase(temp.dbPath)
    expect(readSessionTranscriptProjection(reopened, session.id)).toMatchObject({ source: 'canonical:L1', messages: [
      { id: 'reopen-user', role: 'user', content: 'persisted body', timestamp: 7, status: 'sent', attachments: [{ id: 'persisted-attachment' }] }
    ] })
    expect(getDbConnection(reopened).prepare('SELECT kind FROM agent_history_events WHERE session_id=?').get(session.id))
      .toMatchObject({ kind: 'invocation-context-committed' })
    reopened.close()
    temp.cleanup()
  })

  it('reopens a spilled large baseline body through the L2 fold after cache loss', async () => {
    const temp = createTempDatabase('legacy-projection-baseline-spill-')
    const session = createSession(temp.db, { name: 'large baseline spill', model: 'test' })
    const body = 'large legacy transcript body '.repeat(3_000)
    appendMessage(temp.db, { id: 'large-baseline-user', sessionId: session.id, role: 'user', content: body, timestamp: 7, status: 'sent' })
    expect(await backfillLegacySessionProjectionBaseline(temp.db, session.id, { now: 8 })).toMatchObject({ kind: 'migrated', messageCount: 1 })
    temp.db.close()

    const reopened = openSqliteDatabase(temp.dbPath)
    getDbConnection(reopened).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    const projected = readSessionTranscriptProjection(reopened, session.id)
    expect(projected).toMatchObject({ source: 'canonical:L2', messages: [{ id: 'large-baseline-user', content: body }] })
    expect(getDbConnection(reopened).prepare('SELECT content FROM messages WHERE id=?').get('large-baseline-user')).toEqual({ content: body })
    reopened.close()
    temp.cleanup()
  })
})
