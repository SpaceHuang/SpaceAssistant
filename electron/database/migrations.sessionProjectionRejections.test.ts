import { describe, expect, it } from 'vitest'
import { appendMessage, createSession } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'

const REJECTION_COLUMNS = [
  'session_id', 'session_generation', 'fingerprint', 'watermark_event_id', 'watermark_invocation_id',
  'event_count', 'legacy_message_count', 'legacy_max_rowid', 'legacy_digest', 'attempts', 'retry_after',
  'last_reason', 'permanent', 'stale_metadata', 'updated_at'
]

function insertRejectionRow(db: Parameters<typeof createMemoryAppDb> extends never ? never : ReturnType<typeof createMemoryAppDb>, sessionId: string, generation: string): void {
  getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_rejections(
    session_id, session_generation, fingerprint, watermark_event_id, watermark_invocation_id,
    event_count, legacy_message_count, legacy_max_rowid, legacy_digest, attempts, retry_after, last_reason, permanent, stale_metadata, updated_at
  ) VALUES(?, ?, 'fp', 'evt-1', 'inv-1', 3, 2, 12, 'digest', 1, 0, 'legacy-mismatch', 0, 0, 1)`).run(sessionId, generation)
}

describe('canonical session projection rejection negative cache (P0-①)', () => {
  it('creates the rejection table with the planned negative-cache columns', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'rejection schema', model: 'test' })
    insertRejectionRow(db, session.id, session.generation)
    const columns = (conn.prepare('PRAGMA table_info(canonical_session_projection_rejections)').all() as Array<{ name: string }>).map(({ name }) => name)
    expect(columns).toEqual(REJECTION_COLUMNS)
    db.close()
  })

  it('keeps rejection rows when the v46 history-cursor invalidation trigger fires', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'cursor-trigger exemption', model: 'test' })
    insertRejectionRow(db, session.id, session.generation)

    conn.prepare("INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(1)").run()
    conn.prepare('UPDATE agent_history_commit_cursor SET allocated_at=2 WHERE id=1').run()

    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_rejections WHERE session_id=?').get(session.id))
      .toEqual({ session_id: session.id })
    // 对照组：同一次 cursor 维护会清空投影缓存与 eligibility，rejection 表必须被显式豁免。
    expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toBeUndefined()
    expect(conn.prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id))
      .toBeUndefined()
    db.close()
  })

  it('keeps rejection rows when legacy message rows are written', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'message-trigger exemption', model: 'test' })
    insertRejectionRow(db, session.id, session.generation)

    appendMessage(db, { id: 'rejection-keep-user', sessionId: session.id, role: 'user', content: 'next input', timestamp: 1, status: 'sent' })

    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_rejections WHERE session_id=?').get(session.id))
      .toEqual({ session_id: session.id })
    expect(conn.prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id))
      .toBeUndefined()
    db.close()
  })

  it('cascades rejection rows when their session is deleted', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'rejection cascade', model: 'test' })
    insertRejectionRow(db, session.id, session.generation)

    conn.prepare('DELETE FROM sessions WHERE id=?').run(session.id)

    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_rejections WHERE session_id=?').get(session.id))
      .toBeUndefined()
    db.close()
  })
})
