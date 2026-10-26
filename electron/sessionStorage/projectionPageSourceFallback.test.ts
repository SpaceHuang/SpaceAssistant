import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { appendMessage, createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { advanceProcessGeneration } from '../database/processGeneration'
import { createSqliteProjectionBuildTask, createSqliteSessionStorageHost } from './sqliteSessionStorage'

describe('prepared page source fallback', () => {
  let cleanup: (() => void) | undefined
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => { await stop?.(); stop = undefined; cleanup?.(); cleanup = undefined })

  it('does not enumerate whole-session History spills when page locators are still pending', async () => {
    const temp = createTempDatabase('projection-page-source-pending-')
    cleanup = temp.cleanup
    const db = temp.db
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'pending page source' })
    const body = 'canonical page body '.repeat(4_000)
    appendMessage(db, { id: 'pending-page-message', sessionId: session.id, role: 'user', content: body,
      timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(conn, 1, () => 10, session.id).appendBatch([{ invocationId: 'pending-page-invocation',
      turnId: 'pending-page-turn', sequence: 1, schemaVersion: 1, eventId: 'pending-page-context',
      idempotencyKey: 'pending-page-context', kind: 'invocation-context-committed', payload: { messages: [
        { id: 'pending-page-message', role: 'user', content: body, timestamp: 1 },
      ] } }], 0)
    conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value
      FROM spill_reference_meta WHERE meta_key='canonical_change_generation') WHERE owner_table='agent_history_events'`).run()
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    const generation = advanceProcessGeneration(conn)
    const blobRoot = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot,
      processGeneration: () => generation, connectionEpoch: () => generation, now: Date.now })
    const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) }, maintenanceTasks: [task] })
    stop = () => host.lifecycle.stop({ deadlineMs: 5_000 })
    await host.storage.ensureChatBodyV1!({ sessionId: session.id })
    const prepared = host.storage.readPreparedChatBodyV1!({ sessionId: session.id })!

    const prepare = conn.prepare.bind(conn)
    const sql: string[] = []
    vi.spyOn(conn, 'prepare').mockImplementation((query) => { sql.push(query); return prepare(query) })
    await expect(host.storage.queries.readPreparedChatPage?.({ sessionId: session.id, prepared })).resolves.toBeUndefined()

    expect(sql.some((query) => query.includes('WHERE events.session_id=? AND refs.kind=\'source-of-truth\''))).toBe(false)
    expect(host.storage.readPreparedChatBodyV1!({ sessionId: session.id })).toBeDefined()
  })
})
