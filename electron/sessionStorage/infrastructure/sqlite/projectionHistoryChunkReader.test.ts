import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(page.snapshotDurationMs).toEqual(expect.any(Number))
    expect(page.snapshotDurationMs).toBeGreaterThanOrEqual(0)
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
    expect(result).toMatchObject({ kind: 'deferred-large', afterSessionSequence: 0, eventSequence: 1,
      observedEventRows: 1, observedByteLength: expect.any(Number), snapshotDurationMs: expect.any(Number) })
    if (result.kind !== 'deferred-large') throw new Error('expected oversized event to defer')
    expect(result.observedByteLength).toBeGreaterThan(512)
    const stagedCandidate = readProjectionHistoryChunk({ dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-large' },
    { afterSessionSequence: 0, maxRows: 1, maxBytes: 512, allowOversizedChunk: true })
    expect(stagedCandidate).toMatchObject({ kind: 'chunk', afterSessionSequence: 0, nextSessionSequence: 1, byteLength: expect.any(Number) })
    if (stagedCandidate.kind !== 'chunk') throw new Error('expected staged oversized candidate')
    expect(stagedCandidate.byteLength).toBeGreaterThan(512)
  })

  it('defers an event over the staging cap before parsing its full payload', async () => {
    temp = createTempDatabase('projection-history-staging-cap-')
    const session = createSession(temp.db, { name: 'projection history staging cap' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([{
      invocationId: 'staging-cap-invocation', turnId: 'staging-cap-turn', sequence: 1, schemaVersion: 1,
      eventId: 'staging-cap-event', idempotencyKey: 'staging-cap-key', kind: 'invocation-context-committed',
      payload: { messages: [] },
    }], 0)
    const oversizedPayload = JSON.stringify({ messages: [], extra: 'x'.repeat(32 * 1024 * 1024 + 1) })
    getDbConnection(temp.db).prepare('UPDATE agent_history_events SET payload_json=? WHERE invocation_id=?')
      .run(oversizedPayload, 'staging-cap-invocation')
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const permit = { dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-large' }
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const result = readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 256 * 1024,
        allowOversizedChunk: true })
      expect(result).toMatchObject({ kind: 'deferred-large', eventSequence: 1, reason: 'oversized-event-exceeds-staging-budget' })
      expect(parseSpy.mock.calls.some(([value]) => typeof value === 'string' && value.length > 1024 * 1024)).toBe(false)
    } finally {
      parseSpy.mockRestore()
    }
  })

  it('defers a source spill whose escaped payload exceeds the staging cap without opening the spill file', async () => {
    temp = createTempDatabase('projection-history-spill-staging-cap-')
    const session = createSession(temp.db, { name: 'projection history spill staging cap' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([{
      invocationId: 'spill-staging-cap-invocation', turnId: 'spill-staging-cap-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-staging-cap-event', idempotencyKey: 'spill-staging-cap-key', kind: 'invocation-context-committed',
      payload: { messages: [] },
    }], 0)
    const oversizedDescriptor = { __spaceassistant_spill_v1: {
      version: 1, kind: 'source-of-truth', locator: '11111111-1111-4111-8111-111111111111.spill',
      byteLength: 5.5 * 1024 * 1024, sha256: 'a'.repeat(64), createdAt: 1, head: '', tail: ''
    } }
    getDbConnection(temp.db).prepare('UPDATE agent_history_events SET payload_json=? WHERE invocation_id=?')
      .run(JSON.stringify({ messages: [], body: oversizedDescriptor }), 'spill-staging-cap-invocation')
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const permit = { dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-spill-large' }

    expect(readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 256 * 1024,
      allowOversizedChunk: true })).toMatchObject({ kind: 'deferred-large', eventSequence: 1,
      reason: 'oversized-event-exceeds-staging-budget' })
  })

  it('returns a full page before deferring an oversized next-page event', async () => {
    temp = createTempDatabase('projection-history-staging-page-boundary-')
    const session = createSession(temp.db, { name: 'projection history staging page boundary' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'staging-page-invocation', turnId: 'staging-page-turn', sequence: 1, schemaVersion: 1,
        eventId: 'staging-page-event-1', idempotencyKey: 'staging-page-key-1', kind: 'invocation-context-committed', payload: { messages: [] } },
      { invocationId: 'staging-page-invocation', turnId: 'staging-page-turn', sequence: 2, schemaVersion: 1,
        eventId: 'staging-page-event-2', idempotencyKey: 'staging-page-key-2', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const oversizedPayload = JSON.stringify({ extra: 'x'.repeat(32 * 1024 * 1024 + 1) })
    getDbConnection(temp.db).prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?')
      .run(oversizedPayload, 'staging-page-event-2')
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const permit = { dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-page' }
    const parseSpy = vi.spyOn(JSON, 'parse')
    let firstPage: ReturnType<typeof readProjectionHistoryChunk>
    try {
      firstPage = readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 256 * 1024,
        allowOversizedChunk: true })
      expect(firstPage).toMatchObject({ kind: 'chunk', afterSessionSequence: 0, nextSessionSequence: 1, hasMore: true })
      expect(parseSpy.mock.calls.some(([value]) => typeof value === 'string' && value.length > 1024 * 1024)).toBe(false)
    } finally {
      parseSpy.mockRestore()
    }
    if (firstPage.kind !== 'chunk') throw new Error('expected first full page before oversized event')
    expect(readProjectionHistoryChunk(permit, { afterSessionSequence: firstPage.nextSessionSequence, maxRows: 1,
      maxBytes: 256 * 1024, allowOversizedChunk: true }))
      .toMatchObject({ kind: 'deferred-large', eventSequence: 2, reason: 'oversized-event-exceeds-staging-budget' })
  })

  it('defers a large message fact before materializing its body into the worker chunk', async () => {
    temp = createTempDatabase('projection-history-fact-staging-cap-')
    const session = createSession(temp.db, { name: 'projection message fact staging cap' })
    const oversizedBody = '\u0001'.repeat(5.5 * 1024 * 1024)
    appendMessage(temp.db, { id: 'staging-cap-message', sessionId: session.id, role: 'user', content: oversizedBody,
      timestamp: 10, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
    await history.appendBatch([{
      invocationId: 'staging-cap-facts-invocation', turnId: 'staging-cap-facts-turn', sequence: 1, schemaVersion: 1,
      eventId: 'staging-cap-facts-event', idempotencyKey: 'staging-cap-facts-key', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'staging-cap-message', role: 'user', content: 'canonical' }] },
    }], 0)
    getDbConnection(temp.db).prepare('UPDATE messages SET content=? WHERE id=?').run(oversizedBody, 'staging-cap-message')
    expect((getDbConnection(temp.db).prepare('SELECT length(content) AS length FROM messages WHERE id=?')
      .get('staging-cap-message') as { length: number }).length).toBe(oversizedBody.length)
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    const permit = { dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-large-fact' }
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    try {
      const result = readProjectionHistoryChunk(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 256 * 1024,
        allowOversizedChunk: true })
      const resultSummary = result.kind === 'chunk' ? { kind: result.kind, byteLength: result.byteLength,
        facts: result.messageFacts.map(({ id, storedContent }) => [id, storedContent.length]) } : result
      expect(result.kind, JSON.stringify(resultSummary)).toBe('deferred-large')
      expect(result).toMatchObject({ kind: 'deferred-large', eventSequence: 1,
        reason: 'oversized-source-chunk-exceeds-staging-budget' })
      expect(stringifySpy.mock.calls.some(([value]) => Array.isArray(value) && value.some((item) =>
        item && typeof item === 'object' && 'storedContent' in item && (item as { storedContent?: unknown }).storedContent === oversizedBody))).toBe(false)
    } finally {
      stringifySpy.mockRestore()
    }
  })
})
