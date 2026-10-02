import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/domainTypes'
import { appendMessage, createSession, getChatMessagePage, getMessageSkeletons, getTurnContext } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { getProjectedChatMessagePage, readSessionTranscriptProjection, refreshSessionTranscriptProjectionCache } from './sessionTranscriptProjection'

describe('session transcript projection P2 read path', () => {
  it('seeds the canonical empty-session projection at creation with the persisted generation', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'empty projection seed', model: 'test' })
    const conn = getDbConnection(db)
    const persisted = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    expect(session.generation).toBe(persisted.generation)
    expect(conn.prepare("SELECT session_generation,session_seq,commit_order,event_count,value FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toEqual({ session_generation: persisted.generation, session_seq: -1, commit_order: -1, event_count: 0, value: '[]' })
    expect(conn.prepare('SELECT session_generation FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id))
      .toEqual({ session_generation: persisted.generation })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1', messages: [] })
    db.close()
  })

  it('keeps warm L1 projection latency within the P2 database-read budget on a large transcript', async () => {
    const { db, cleanup } = createTempDatabase('session-projection-perf-')
    try {
      const session = createSession(db, { name: 'projection performance', model: 'test' })
      const count = 1200
      const batch = Array.from({ length: count }, (_, index) => ({
        id: `perf-message-${index}`, sessionId: session.id, role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
        content: `message ${index} ${'body '.repeat(24)}`, timestamp: index + 1, status: 'sent' as const
      }))
      const { appendMessagesAtomically } = await import('../database/operations')
      appendMessagesAtomically(db, batch)
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'perf-invocation', turnId: 'perf-turn', sequence: 1, schemaVersion: 1,
        eventId: 'perf-context', idempotencyKey: 'perf-context', kind: 'invocation-context-committed',
        payload: { messages: batch.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
      }], 0)
      getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
      // A full exact legacy/canonical comparison establishes the per-session fast-page eligibility marker.
      expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L2')
      expect(getDbConnection(db).prepare('SELECT session_generation FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id))
        .toEqual({ session_generation: session.generation })

      const projectedSamples: number[] = []
      const legacyPageSamples: number[] = []
      const contextSamples: number[] = []
      const samplesPerWindow = 5
      // Warm prepared statements and page caches before measuring steady-state reads.
      for (let warmup = 0; warmup < 10; warmup += 1) {
        getChatMessagePage(db, session.id, null, 60)
        getProjectedChatMessagePage(db, session.id, null, 60)
        getTurnContext(db, session.id, undefined, undefined, [])
      }
      for (let iteration = 0; iteration < 30; iteration += 1) {
        const legacyStarted = performance.now()
        for (let repeat = 0; repeat < samplesPerWindow; repeat += 1) {
          const legacyPage = getChatMessagePage(db, session.id, null, 60)
          expect(legacyPage.entries).toHaveLength(60)
        }
        legacyPageSamples.push((performance.now() - legacyStarted) / samplesPerWindow)

        const started = performance.now()
        for (let repeat = 0; repeat < samplesPerWindow; repeat += 1) {
          const result = getProjectedChatMessagePage(db, session.id, null, 60)
          expect(result.entries).toHaveLength(60)
        }
        projectedSamples.push((performance.now() - started) / samplesPerWindow)

        const contextStarted = performance.now()
        for (let repeat = 0; repeat < samplesPerWindow; repeat += 1) {
          expect(getTurnContext(db, session.id, undefined, undefined, []).length).toBe(count)
        }
        contextSamples.push((performance.now() - contextStarted) / samplesPerWindow)
      }
      const p95 = (samples: number[]) => {
        samples.sort((a, b) => a - b)
        return samples[Math.ceil(samples.length * 0.95) - 1]!
      }
      const legacyPageP95 = p95(legacyPageSamples)
      const projectedPageP95 = p95(projectedSamples)
      const apiContextP95 = p95(contextSamples)
      expect(projectedPageP95, `projected page p95 ${projectedPageP95.toFixed(2)}ms; legacy page ${legacyPageP95.toFixed(2)}ms`)
        .toBeLessThanOrEqual(legacyPageP95 * 2 + 5)
      expect(apiContextP95, `API context p95 ${apiContextP95.toFixed(2)}ms`).toBeLessThan(50)
    } finally {
      cleanup()
    }
  })

  it('refreshes the cache watermark after a terminal append without a full legacy-body read', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'turn-end projection', model: 'test' })
    appendMessage(db, { id: 'turn-end-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'turn-end-invocation', turnId: 'turn-end-turn', sequence: 1, schemaVersion: 1,
      eventId: 'turn-end-context', idempotencyKey: 'turn-end-context', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', id: 'turn-end-user', content: 'question', timestamp: 1 }] }
    }], 0)

    expect(refreshSessionTranscriptProjectionCache(db, session.id)).toBe(true)
    expect(getDbConnection(db).prepare("SELECT session_seq,commit_order FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toEqual({ session_seq: 1, commit_order: 1 })
    db.close()
  })

  it('rejects an empty cached projection after canonical history was deleted and the session ID was reused', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'stale empty projection', model: 'test' })
    const conn = getDbConnection(db)
    appendMessage(db, { id: 'old-user', sessionId: session.id, role: 'user', content: 'stale cached body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    const append = (invocationId: string, eventId: string, messageId: string, content: string) => history.appendBatch([{
      invocationId, turnId: `${invocationId}-turn`, sequence: 1, schemaVersion: 1,
      eventId, idempotencyKey: eventId, kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', id: messageId, content, timestamp: 1 }] }
    }], 0)

    return append('old-incarnation', 'old-watermark-event', 'old-user', 'stale cached body').then(async () => {
      expect(refreshSessionTranscriptProjectionCache(db, session.id)).toBe(true)
      conn.prepare('DELETE FROM agent_history_events WHERE session_id=?').run(session.id)
      conn.prepare('DELETE FROM agent_history_streams WHERE session_id=?').run(session.id)
      conn.prepare('DELETE FROM session_event_cursor WHERE session_id=?').run(session.id)
      conn.prepare("UPDATE canonical_session_projection_cache SET session_seq=-1, commit_order=-1, watermark_event_id=NULL, watermark_invocation_id=NULL, event_count=0 WHERE session_id=? AND cache_key='transcript'").run(session.id)
      conn.prepare('UPDATE sessions SET generation=? WHERE id=?').run('reused-session-generation', session.id)
      await append('new-incarnation', 'new-watermark-event', 'new-user', 'fresh canonical body')

      const read = new SqliteAgentHistory(conn).readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
      expect(read.kind).toBe('unavailable')
    }).finally(() => db.close())
  })

  it('rejects a stale cache when its watermark event is deleted and no later tail remains', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'deleted watermark event', model: 'test' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'watermark-delete-invocation', turnId: 'watermark-delete-turn', sequence: 1, schemaVersion: 1,
      eventId: 'watermark-delete-event', idempotencyKey: 'watermark-delete-event', kind: 'invocation-context-committed',
      payload: { messages: [] }
    }], 0)
    const original = history.readCanonicalSessionTranscript(session.id, [])
    expect(original.kind).toBe('matched')
    if (original.kind !== 'matched') throw new Error('expected a canonical match')
    expect(history.writeCanonicalSessionCache({ ...original, cacheKey: 'transcript', value: JSON.stringify(original.messages) })).toBe(true)
    conn.prepare("DELETE FROM agent_history_events WHERE event_id='watermark-delete-event'").run()
    conn.prepare("UPDATE session_event_cursor SET next_seq=1 WHERE session_id=?").run(session.id)

    const read = history.readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
    expect(read).toMatchObject({ kind: 'unavailable', reason: 'legacy-mismatch' })
    db.close()
  })


  it('uses canonical bodies after full identity/body/order match and validates the warm L1 path', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical projection', model: 'test' })
    appendMessage(db, { id: 'projection-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'projection-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'projection-invocation', turnId: 'projection-turn', sequence: 1, schemaVersion: 1,
      eventId: 'projection-context', idempotencyKey: 'projection-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', id: 'projection-user', content: 'question', timestamp: 1 },
        { role: 'assistant', id: 'projection-assistant', content: 'answer', timestamp: 2 }
      ] }
    }], 0)
    getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'projection-user', content: 'question', status: 'sent' },
      { id: 'projection-assistant', content: 'answer', status: 'sent' }
    ] })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1' })
    expect(getMessageSkeletons(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    getDbConnection(db).prepare("UPDATE messages SET content='stale projection copy' WHERE id='projection-user'").run()
    const authoritative = readSessionTranscriptProjection(db, session.id)
    expect(authoritative).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })
    expect(authoritative.messages[0]).toMatchObject({ id: 'projection-user', content: 'stale projection copy' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getProjectedChatMessagePage(db, session.id, undefined, 20)).toMatchObject({ entries: [
      { message: { id: 'projection-user', content: 'stale projection copy', status: 'sent' }, sequence: 0 },
      { message: { id: 'projection-assistant', content: 'answer', status: 'sent' }, sequence: 1 }
    ] })
    getDbConnection(db).prepare("UPDATE messages SET content='question' WHERE id='projection-user'").run()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L2')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')
    db.close()
  })

  it('preserves every legacy UI/control field while canonical owns only identity, role, body, and timestamp', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection field matrix', model: 'test' })
    const metadata = {
      attachments: [{ id: 'attachment-1', stagingKey: 'chat-attachments/session/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 12 }],
      imagesDeliveredToApi: true,
      toolUse: { id: 'legacy-tool-id', toolName: 'legacy-tool', toolType: 'test', parameters: { q: 1 }, result: { data: 'legacy result', success: true }, status: 'completed' as const, timestamp: 3 },
      toolCalls: [{ id: 'tool-call-1', toolName: 'search', input: { q: 'x' }, result: { data: { ok: true }, success: true }, status: 'completed' as const, riskLevel: 'low' as const }],
      thinking: { content: 'private reasoning', isVisible: true, startTime: 3 },
      contentSegments: [{ content: 'visible segment', startTime: 4 }],
      skillHints: [{ id: 'skill-id', text: 'skill hint', shownAt: 5 }]
    }
    appendMessage(db, {
      id: 'matrix-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1,
      status: 'sent', ...metadata
    })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'matrix-invocation', turnId: 'matrix-turn', sequence: 1, schemaVersion: 1,
      eventId: 'matrix-context', idempotencyKey: 'matrix-context', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', id: 'matrix-user', content: 'legacy body', timestamp: 1 }] }
    }], 0)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)

    const result = readSessionTranscriptProjection(db, session.id)
    expect(result).toMatchObject({ source: 'canonical:L2', messages: [{
      id: 'matrix-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1,
      status: 'sent', schemaVersion: 1, ...metadata
    }] })
    db.close()
  })

  it('preserves explicit absence and presence semantics for optional legacy fields', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection optional fields', model: 'test' })
    appendMessage(db, { id: 'optional-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'queued' })
    appendMessage(db, { id: 'optional-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'failed',
      thinking: { content: '', isVisible: false, startTime: 0 }, toolCalls: [], contentSegments: [], skillHints: [], attachments: [], imagesDeliveredToApi: false })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'optional-invocation', turnId: 'optional-turn', sequence: 1, schemaVersion: 1,
      eventId: 'optional-context', idempotencyKey: 'optional-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', id: 'optional-user', content: 'body', timestamp: 1 },
        { role: 'assistant', id: 'optional-assistant', content: 'answer', timestamp: 2 }
      ] }
    }], 0)
    getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)

    const result = readSessionTranscriptProjection(db, session.id)
    expect(result).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'optional-user', content: 'body', status: 'queued' },
      { id: 'optional-assistant', content: 'answer', status: 'failed', imagesDeliveredToApi: false }
    ] })
    const assistant = result.messages[1]!
    expect(assistant.thinking).toEqual({ content: '', isVisible: false, startTime: 0 })
    expect(assistant.toolCalls).toBeUndefined()
    expect(assistant.contentSegments).toBeUndefined()
    expect(assistant.skillHints).toBeUndefined()
    expect(assistant.attachments).toBeUndefined()
    db.close()
  })

  it('keeps the per-session legacy fallback when canonical history is absent or identity differs', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'legacy fallback', model: 'test' })
    appendMessage(db, { id: 'legacy-message', sessionId: session.id, role: 'user', content: 'legacy source', timestamp: 1, status: 'sent' })

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'legacy-mismatch-invocation', turnId: 'legacy-mismatch-turn', sequence: 1, schemaVersion: 1,
      eventId: 'legacy-mismatch-context', idempotencyKey: 'legacy-mismatch-context', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', id: 'different-id', content: 'legacy source', timestamp: 1 }] }
    }], 0)
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })
    db.close()
  })

  it('classifies eligible and ineligible history independently per session', async () => {
    const db = createMemoryAppDb()
    const eligible = createSession(db, { name: 'eligible session', model: 'test' })
    const legacy = createSession(db, { name: 'legacy only session', model: 'test' })
    appendMessage(db, { id: 'eligible-row', sessionId: eligible.id, role: 'user', content: 'same content', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'legacy-row', sessionId: legacy.id, role: 'user', content: 'same content', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, eligible.id)
    await history.appendBatch([{
      invocationId: 'eligible-invocation', turnId: 'eligible-turn', sequence: 1, schemaVersion: 1,
      eventId: 'eligible-context', idempotencyKey: 'eligible-context', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', id: 'eligible-row', content: 'same content', timestamp: 1 }] }
    }], 0)

    expect(readSessionTranscriptProjection(db, eligible.id).source).toBe('canonical:L2')
    expect(readSessionTranscriptProjection(db, eligible.id).source).toBe('canonical:L1')
    expect(readSessionTranscriptProjection(db, legacy.id)).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })
    expect(getProjectedChatMessagePage(db, eligible.id, null, 20).entries[0]?.message.content).toBe('same content')
    expect(getProjectedChatMessagePage(db, legacy.id, null, 20).entries[0]?.message.content).toBe('same content')
    db.close()
  })

  it('keeps legacy control fields and falls back when an unmapped role is present', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'legacy system row', model: 'test' })
    appendMessage(db, { id: 'system-message', sessionId: session.id, role: 'system', content: 'system state', timestamp: 1, status: 'sent' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'field-not-eligible' })
    db.close()
  })

  it('keeps a noncanonical pending legacy row visible when the cached snapshot does not include it yet', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'pending legacy row', model: 'test' })
    appendMessage(db, { id: 'pending-canonical-user', sessionId: session.id, role: 'user', content: 'committed question', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'pending-canonical-invocation', turnId: 'pending-canonical-turn', sequence: 1, schemaVersion: 1,
      eventId: 'pending-canonical-context', idempotencyKey: 'pending-canonical-context', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', id: 'pending-canonical-user', content: 'committed question', timestamp: 1 }] }
    }], 0)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L2')
    appendMessage(db, { id: 'pending-not-canonical-yet', sessionId: session.id, role: 'user', content: 'queued question', timestamp: 2, status: 'queued' })

    expect(getProjectedChatMessagePage(db, session.id, undefined, 20)).toMatchObject({ entries: [
      { message: { id: 'pending-canonical-user', content: 'committed question' } },
      { message: { id: 'pending-not-canonical-yet', content: 'queued question', status: 'queued' } }
    ] })
    db.close()
  })

  it('falls back to the entire legacy page when any row has UI activity outside the SQLite skeleton', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'activity legacy fallback', model: 'test' })
    appendMessage(db, { id: 'activity-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'activity-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'activity-invocation', turnId: 'activity-turn', sequence: 1, schemaVersion: 1,
      eventId: 'activity-context', idempotencyKey: 'activity-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', id: 'activity-user', content: 'question', timestamp: 1 },
        { role: 'assistant', id: 'activity-assistant', content: 'answer', timestamp: 2 }
      ] }
    }], 0)
    const conn = getDbConnection(db)
    const columns = conn.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).not.toContain('activity_json')
    const original = getProjectedChatMessagePage(db, session.id, null, 20)
    expect(original.entries[1]?.message.activity).toBeUndefined()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')
    expect(getProjectedChatMessagePage(db, session.id, null, 20)).toMatchObject({ entries: original.entries })
    db.close()
  })

  it('requires full-session identity eligibility before using canonical bodies for a cursor page', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'page-wide eligibility', model: 'test' })
    appendMessage(db, { id: 'page-known-user', sessionId: session.id, role: 'user', content: 'known', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'page-known-assistant', sessionId: session.id, role: 'assistant', content: 'known reply', timestamp: 2, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'page-invocation', turnId: 'page-turn', sequence: 1, schemaVersion: 1,
      eventId: 'page-context', idempotencyKey: 'page-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', id: 'page-known-user', content: 'known', timestamp: 1 },
        { role: 'assistant', id: 'page-known-assistant', content: 'known reply', timestamp: 2 }
      ] }
    }], 0)
    getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    const eligiblePage = getProjectedChatMessagePage(db, session.id, null, 20)
    expect(eligiblePage.entries.at(-1)?.message.content).toBe('known reply')

    for (let index = 0; index < 25; index += 1) {
      appendMessage(db, { id: `page-historyless-older-${index}`, sessionId: session.id, role: 'user', content: `older legacy ${index}`, timestamp: index, status: 'sent' })
    }
    const pageWithUnmappedHistory = getProjectedChatMessagePage(db, session.id, null, 20)
    expect(pageWithUnmappedHistory.entries[0]?.message.id).toBe('page-historyless-older-5')
    expect(pageWithUnmappedHistory.entries).toHaveLength(20)
    expect(pageWithUnmappedHistory.entries.some(({ message }) => message.id === 'page-known-assistant')).toBe(false)
    const olderPage = getProjectedChatMessagePage(db, session.id, pageWithUnmappedHistory.oldestSequence, 20)
    expect(olderPage.entries.find(({ message }) => message.id === 'page-known-assistant')?.message.content).toBe('known reply')
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })
    db.close()
  })
})
