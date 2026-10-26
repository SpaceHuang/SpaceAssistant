import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'

describe('projection source identity coverage', () => {
  let temp: ReturnType<typeof createTempDatabase> | undefined
  afterEach(() => { temp?.cleanup(); temp = undefined })

  it('changes when message revision, History watermark/cursor, or stream ownership changes', async () => {
    temp = createTempDatabase('projection-source-identity-coverage-')
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'source identity coverage' })
    const read = () => readProjectionSourceIdentity(conn, session.id, session.generation)

    const initial = JSON.parse(read()!) as Record<string, unknown>
    expect(initial).toMatchObject({ formatVersion: 1, sessionGeneration: session.generation,
      messageRevision: 0, historyWatermark: null, eventCursor: null, historyStreams: [] })

    appendMessage(temp.db, { id: 'source-message', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    const afterMessage = JSON.parse(read()!) as Record<string, unknown>
    expect(afterMessage.messageRevision).toBeGreaterThan(initial.messageRevision as number)
    expect(read()).not.toBe(JSON.stringify(initial))

    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([{ invocationId: 'source-stream', turnId: 'source-turn', sequence: 1, schemaVersion: 1,
      eventId: 'source-event', idempotencyKey: 'source-key', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'source-message', role: 'user', content: 'body', timestamp: 1 }] } }], 0)
    const afterHistory = JSON.parse(read()!) as Record<string, unknown>
    expect(afterHistory.historyWatermark).toEqual([1, 1, 'source-event', 'source-stream'])
    expect(afterHistory.eventCursor).toBe(1)
    expect(afterHistory.historyStreams).toEqual(['source-stream'])

    const other = createSession(temp.db, { name: 'new stream owner' })
    conn.prepare('UPDATE agent_history_streams SET session_id=? WHERE invocation_id=?').run(other.id, 'source-stream')
    const afterOwnershipChange = JSON.parse(read()!) as Record<string, unknown>
    expect(afterOwnershipChange.historyStreams).toEqual([])
    // The watermark is read from events.session_id; the chunk reader joins stream ownership
    // separately and rejects this now-orphaned event instead of hiding it from identity.
    expect(afterOwnershipChange.historyWatermark).toEqual(afterHistory.historyWatermark)
    expect(read()).not.toBe(JSON.stringify(afterHistory))
  })
})
