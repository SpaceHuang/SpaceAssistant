import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { readProjectionHistoryChunk, type ProjectionHistoryChunkPermit } from './projectionHistoryChunkReader'

describe('projection read-only History chunk source', () => {
  let temp: ReturnType<typeof createTempDatabase> | undefined
  afterEach(() => { temp?.cleanup(); temp = undefined })

  it('reads keyset pages under a stable read-only source fence and rejects stale or invalid cursors', async () => {
    temp = createTempDatabase('projection-history-chunk-')
    const session = createSession(temp.db, { name: 'projection history chunk' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([{
      invocationId: 'chunk-invocation', turnId: 'chunk-turn', sequence: 1, schemaVersion: 1,
      eventId: 'chunk-event-1', idempotencyKey: 'chunk-key-1', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', content: 'chunk source' }] },
    }], 0)
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const permit: ProjectionHistoryChunkPermit = { dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 3, processGeneration: 2, rebuildToken: 'token-a' }

    const page = readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 32 * 1024 })
    expect(page).toMatchObject({ kind: 'chunk', afterSessionSequence: 0, nextSessionSequence: 1, hasMore: false })
    if (page.kind !== 'chunk') throw new Error('expected a bounded event chunk')
    expect(page.events[0]).toMatchObject({ invocationId: 'chunk-invocation', eventId: 'chunk-event-1', sessionSequence: 1 })
    expect(page.byteLength).toBeLessThanOrEqual(32 * 1024)
    expect(readProjectionHistoryChunk(permit, { afterSessionSequence: page.nextSessionSequence, maxRows: 1, maxBytes: 32 * 1024 }))
      .toMatchObject({ kind: 'complete', afterSessionSequence: 1 })
    expect(readProjectionHistoryChunk(permit, { afterSessionSequence: 2, maxRows: 1, maxBytes: 32 * 1024 }))
      .toMatchObject({ kind: 'cursor-invalid' })

    const otherSession = createSession(temp.db, { name: 'projection new stream owner' })
    getDbConnection(temp.db).prepare('UPDATE agent_history_streams SET session_id=? WHERE invocation_id=?').run(otherSession.id, 'chunk-invocation')
    expect(readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 32 * 1024 }))
      .toMatchObject({ kind: 'source-drift' })
    const reassignedPermit = { ...permit, sourceIdentityJson: readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)! }
    expect(readProjectionHistoryChunk(reassignedPermit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 32 * 1024 }))
      .toMatchObject({ kind: 'unavailable', reason: 'history-order-invalid' })
  })

  it('returns same-snapshot message authority and queue facts for bodies referenced by the History page', async () => {
    temp = createTempDatabase('projection-history-message-facts-')
    const session = createSession(temp.db, { name: 'projection history message facts' })
    appendMessage(temp.db, { id: 'message-fact-1', sessionId: session.id, role: 'user', content: 'authoritative body',
      timestamp: 123, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([{
      invocationId: 'facts-invocation', turnId: 'facts-turn', sequence: 1, schemaVersion: 1,
      eventId: 'facts-event-1', idempotencyKey: 'facts-key-1', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'message-fact-1', role: 'user', content: 'authoritative body', timestamp: 123 }] },
    }], 0)
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const permit = { dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 3, processGeneration: 2, rebuildToken: 'token-facts' }
    const page = readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 2, maxBytes: 32 * 1024 })
    expect(page).toMatchObject({ kind: 'chunk', messageFacts: [{ id: 'message-fact-1', role: 'user', timestamp: 123,
      sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', storedContent: 'authoritative body' }] })
  })

  it('defers an event larger than the slice budget without returning a partial event', async () => {
    temp = createTempDatabase('projection-history-oversize-')
    const session = createSession(temp.db, { name: 'projection large history event' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([{
      invocationId: 'large-invocation', turnId: 'large-turn', sequence: 1, schemaVersion: 1,
      eventId: 'large-event', idempotencyKey: 'large-key', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', content: 'x'.repeat(4096) }] },
    }], 0)
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const result = readProjectionHistoryChunk({ dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-large' },
    { afterSessionSequence: 0, maxRows: 1, maxBytes: 512 })
    expect(result).toMatchObject({ kind: 'deferred-large', afterSessionSequence: 0, eventSequence: 1 })
  })
})
