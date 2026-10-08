import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { getCanonicalSpillChangeGeneration, replaceSpillReferenceOwnerInTransaction, spillHistoryOwnerKey, type SpillReferenceOwnerTable } from './spillReferenceIndex'

const descriptor = (locator: string) => ({ version: 1, kind: 'source-of-truth', locator, byteLength: 1, sha256: 'a'.repeat(64), createdAt: 1, head: '', tail: '' })

describe('private spill reference index repository', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.close() })

  it('replaces owner rows with strict paths and revision inside the caller transaction', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const payload = JSON.stringify({ nested: [{ __spaceassistant_spill_v1: descriptor('a.spill') }] })
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES('owner',1,1,NULL)`).run()
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('owner',1,'event-1','key','turn',1,'tool-call-started','{}',1)`).run()
    conn.exec('BEGIN IMMEDIATE')
    replaceSpillReferenceOwnerInTransaction(conn, 'agent_history_events', spillHistoryOwnerKey('owner', 'event-1'), payload, 10)
    expect(conn.prepare('SELECT locator,descriptor_path FROM spill_reference_index').all()).toEqual([
      { locator: 'a.spill', descriptor_path: '/nested/0/__spaceassistant_spill_v1' }
    ])
    expect(getCanonicalSpillChangeGeneration(conn)).toBe(1)
    conn.exec('ROLLBACK')
    expect(conn.prepare('SELECT count(*) AS n FROM spill_reference_index').get()).toEqual({ n: 0 })
  })

  it('rejects malformed payloads without deleting the previous live owner rows', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at)
      VALUES('owner','turn',0,1,'completed','[]',1)`).run()
    replaceSpillReferenceOwnerInTransaction(conn, 'session_transcript_entries', '["owner",1]', JSON.stringify({ __spaceassistant_spill_v1: descriptor('a.spill') }), 10)
    expect(() => replaceSpillReferenceOwnerInTransaction(conn, 'session_transcript_entries', '["owner",1]', '{broken', 11)).toThrow()
    expect(conn.prepare('SELECT locator FROM spill_reference_index').get()).toEqual({ locator: 'a.spill' })
  })

  it('fails closed for unknown owner tables at the TypeScript boundary', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const ownerTable: SpillReferenceOwnerTable = 'agent_history_events'
    expect(ownerTable).toBe('agent_history_events')
  })
})
