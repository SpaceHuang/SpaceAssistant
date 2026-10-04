import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message } from '../../src/shared/domainTypes'
import { appendMessage, createSession, getApiContextBaseline, getChatMessagePage, getMessage, getMessageSkeletons, getMessages, getMessagesPageWithSequence, getRecentTurnRoutingMessages, getSearchCorpusPage, getTurnContext, resolveRetryContext, searchMessages } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { getProjectedApiContextBaseline, getProjectedChatMessagePage, getProjectedMessage, getProjectedMessages, getProjectedMessagesPageWithSequence, getProjectedRecentTurnRoutingMessages, getProjectedSearchCorpusPage, readSessionTranscriptProjection, refreshSessionTranscriptProjectionCache, resolveProjectedRetryContext, searchProjectedMessages } from './sessionTranscriptProjection'

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

      const conn = getDbConnection(db)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')
      const legacySearchSamples: number[] = []
      const canonicalSearchSamples: number[] = []
      for (let warmup = 0; warmup < 10; warmup += 1) {
        expect(searchMessages(db, 'query-with-no-matches', '', 50)).toEqual([])
        expect(searchProjectedMessages(db, 'query-with-no-matches', '', 50)).toEqual([])
      }
      for (let iteration = 0; iteration < 30; iteration += 1) {
        const legacyStarted = performance.now()
        expect(searchMessages(db, 'query-with-no-matches', '', 50)).toEqual([])
        legacySearchSamples.push(performance.now() - legacyStarted)

        const canonicalStarted = performance.now()
        expect(searchProjectedMessages(db, 'query-with-no-matches', '', 50)).toEqual([])
        canonicalSearchSamples.push(performance.now() - canonicalStarted)
      }
      const legacySearchP95 = p95(legacySearchSamples)
      const canonicalSearchP95 = p95(canonicalSearchSamples)
      console.info(`canonical-global-search-p95 legacy=${legacySearchP95.toFixed(2)}ms candidate=${canonicalSearchP95.toFixed(2)}ms samples=30 rows=${count} query=no-match`)
      // Canonical search must stay below 20ms p95 for the 1200-row full-scan workload;
      // the broader 50ms response budget still includes IPC and renderer work.
      expect(canonicalSearchP95, `canonical global search p95 ${canonicalSearchP95.toFixed(2)}ms; budget 20ms`)
        .toBeLessThanOrEqual(20)
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

  it('rejects canonical-only L1 when a completed terminal payload is corrupted without changing its watermark', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'malformed cached terminal', model: 'test' })
    const user = appendMessage(db, { id: 'malformed-cache-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'malformed-cache-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'malformed-cache-invocation', turnId: 'malformed-cache-turn', sequence: 1, schemaVersion: 1,
        eventId: 'malformed-cache-context', idempotencyKey: 'malformed-cache-context', kind: 'invocation-context-committed',
        payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
      { invocationId: 'malformed-cache-invocation', turnId: 'malformed-cache-turn', sequence: 2, schemaVersion: 1,
        eventId: 'malformed-cache-terminal', idempotencyKey: 'malformed-cache-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    expect(refreshSessionTranscriptProjectionCache(db, session.id)).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')

    conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?')
      .run(JSON.stringify({ status: 'failed' }), 'malformed-cache-terminal')

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it('rejects an event appended after a cached terminal instead of treating it as an ignorable delta', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'post-terminal cached delta', model: 'test' })
    const user = appendMessage(db, { id: 'post-terminal-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'post-terminal-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'post-terminal-invocation', turnId: 'post-terminal-turn', sequence: 1, schemaVersion: 1,
        eventId: 'post-terminal-context', idempotencyKey: 'post-terminal-context', kind: 'invocation-context-committed',
        payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
      { invocationId: 'post-terminal-invocation', turnId: 'post-terminal-turn', sequence: 2, schemaVersion: 1,
        eventId: 'post-terminal-terminal', idempotencyKey: 'post-terminal-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    expect(refreshSessionTranscriptProjectionCache(db, session.id)).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    const commitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'approval-updated','{}',?,?,?,3)`)
      .run('post-terminal-invocation', 3, 'post-terminal-late-event', 'post-terminal-late-event', 'post-terminal-turn', Date.now(), session.id, commitOrder)
    conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run('post-terminal-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it.each([
    ['completed', 'invocation-completed', { status: 'completed' }],
    ['failed', 'invocation-failed', { status: 'failed' }],
    ['interrupted', 'invocation-interrupted', { status: 'interrupted' }],
    ['cancelled', 'invocation-interrupted', { status: 'cancelled' }],
    ['parked', 'invocation-parked', { invocationId: 'post-parked-invocation' }]
  ] as const)('rejects an event appended after a cached %s invocation', async (label, terminalKind, terminalPayload) => {
    const db = createMemoryAppDb()
    const prefix = `post-${label}`
    const session = createSession(db, { name: `${prefix} cached delta`, model: 'test' })
    const user = appendMessage(db, { id: `${prefix}-user`, sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: `${prefix}-assistant`, sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    const invocationId = label === 'parked' ? 'post-parked-invocation' : `${prefix}-invocation`
    const turnId = `${prefix}-turn`
    await history.appendBatch([
      { invocationId, turnId, sequence: 1, schemaVersion: 1, eventId: `${prefix}-context`, idempotencyKey: `${prefix}-context`,
        kind: 'invocation-context-committed', payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
      { invocationId, turnId, sequence: 2, schemaVersion: 1, eventId: `${prefix}-terminal`, idempotencyKey: `${prefix}-terminal`,
        kind: terminalKind, payload: terminalPayload }
    ], 0)
    expect(refreshSessionTranscriptProjectionCache(db, session.id)).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')

    const commitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'approval-updated','{}',?,?,?,3)`)
      .run(invocationId, 3, `${prefix}-late-event`, `${prefix}-late-event`, turnId, Date.now(), session.id, commitOrder)
    conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run(invocationId)
    conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'unavailable' })
    db.close()
  })

  it.each([
    ['tool call', 'tool-call-started', { toolCallId: 'unresolved-call' }],
    ['approval', 'approval-waiting', { approvalId: 'unresolved-approval' }],
    ['tool proposal', 'model-response-committed', {
      message: { role: 'assistant', toolCalls: [{ id: 'unresolved-proposal', name: 'lookup', input: { query: 'q' } }] }
    }]
  ] as const)('rejects a terminal delta that leaves a partial %s unresolved', async (pendingKind, pendingEventKind, pendingPayload) => {
    const db = createMemoryAppDb()
    const prefix = pendingKind === 'tool call' ? 'partial-tool' : 'partial-approval'
    const session = createSession(db, { name: `${pendingKind} before terminal`, model: 'test' })
    appendMessage(db, { id: `${prefix}-user`, sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: `${prefix}-invocation`, turnId: `${prefix}-turn`, sequence: 1, schemaVersion: 1,
      eventId: `${prefix}-context`, idempotencyKey: `${prefix}-context`, kind: 'invocation-context-committed',
      payload: { messages: [{ id: `${prefix}-user`, role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)

    const appendRawEvent = (sequence: number, eventId: string, kind: string, payload: unknown, sessionSeq: number) => {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run(`${prefix}-invocation`, sequence, eventId, eventId, `${prefix}-turn`, kind, JSON.stringify(payload), Date.now(), session.id,
          Number(allocated.lastInsertRowid), sessionSeq)
    }
    appendRawEvent(2, `${prefix}-pending`, pendingEventKind, pendingPayload, 2)
    appendRawEvent(3, `${prefix}-terminal`, 'invocation-completed', { status: 'completed' }, 3)
    conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run(`${prefix}-invocation`)
    conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    db.close()
  })

  it.each([
    ['approved', true],
    ['denied', false],
    ['timeout', false],
    ['unavailable', false],
    ['cancelled', false]
  ] as const)('settles a pre-watermark approval after a %s resolution', async (outcome, approved) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'valid approval lifecycle', model: 'test' })
    appendMessage(db, { id: 'valid-approval-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'valid-approval-invocation', turnId: 'valid-approval-turn', sequence: 1, schemaVersion: 1,
      eventId: 'valid-approval-context', idempotencyKey: 'valid-approval-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'valid-approval-user', role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    await history.appendBatch([{
      invocationId: 'valid-approval-invocation', turnId: 'valid-approval-turn', sequence: 2, schemaVersion: 1,
      eventId: 'valid-approval-wait-before-watermark', idempotencyKey: 'valid-approval-wait-before-watermark', kind: 'approval-waiting',
      payload: { approvalId: 'valid-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 }
    }], 1)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)

    await history.appendBatch([
      { invocationId: 'valid-approval-invocation', turnId: 'valid-approval-turn', sequence: 3, schemaVersion: 1,
        eventId: 'valid-approval-resolution', idempotencyKey: 'valid-approval-resolution', kind: 'approval-resolved',
        payload: { approvalId: 'valid-approval-id', approved, outcome, settledAt: 3 } },
      { invocationId: 'valid-approval-invocation', turnId: 'valid-approval-turn', sequence: 4, schemaVersion: 1,
        eventId: 'valid-approval-terminal', idempotencyKey: 'valid-approval-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 2)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1', messages: [
      { id: 'valid-approval-user', role: 'user', content: 'question' }
    ] })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'valid-approval-user', role: 'user', content: 'question' }
    ] })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    db.close()
  })

  it('keeps an unresolved concurrent approval pending across the L1 watermark', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'concurrent approvals across watermark', model: 'test' })
    appendMessage(db, { id: 'concurrent-approval-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'concurrent-approval-invocation', turnId: 'concurrent-approval-turn', sequence: 1, schemaVersion: 1,
      eventId: 'concurrent-approval-context', idempotencyKey: 'concurrent-approval-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'concurrent-approval-user', role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    await history.appendBatch([
      { invocationId: 'concurrent-approval-invocation', turnId: 'concurrent-approval-turn', sequence: 2, schemaVersion: 1,
        eventId: 'concurrent-approval-a-wait', idempotencyKey: 'concurrent-approval-a-wait', kind: 'approval-waiting',
        payload: { approvalId: 'concurrent-approval-a', answerer: 'user', reasonCode: 'confirm-a', requestedAt: 2 } },
      { invocationId: 'concurrent-approval-invocation', turnId: 'concurrent-approval-turn', sequence: 3, schemaVersion: 1,
        eventId: 'concurrent-approval-b-wait', idempotencyKey: 'concurrent-approval-b-wait', kind: 'approval-waiting',
        payload: { approvalId: 'concurrent-approval-b', answerer: 'user', reasonCode: 'confirm-b', requestedAt: 3 } }
    ], 1)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)

    await history.appendBatch([
      { invocationId: 'concurrent-approval-invocation', turnId: 'concurrent-approval-turn', sequence: 4, schemaVersion: 1,
        eventId: 'concurrent-approval-a-resolution', idempotencyKey: 'concurrent-approval-a-resolution', kind: 'approval-resolved',
        payload: { approvalId: 'concurrent-approval-a', approved: true, outcome: 'approved', settledAt: 4 } },
      { invocationId: 'concurrent-approval-invocation', turnId: 'concurrent-approval-turn', sequence: 5, schemaVersion: 1,
        eventId: 'concurrent-approval-interrupted', idempotencyKey: 'concurrent-approval-interrupted', kind: 'invocation-interrupted',
        payload: { status: 'interrupted', reason: 'process-restart' } }
    ], 3)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1', messages: [
      { id: 'concurrent-approval-user', role: 'user', content: 'question' }
    ] })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    expect(history.readSync('concurrent-approval-invocation').events.at(-1)).toMatchObject({ kind: 'invocation-interrupted' })
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'concurrent-approval-user', role: 'user', content: 'question' }
    ] })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    db.close()
  })

  it('preserves one settled tool result beside another unresolved tool across the L1 watermark', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'partial tool settlement across watermark', model: 'test' })
    const user = appendMessage(db, { id: 'partial-tool-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'partial-tool-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'completed',
      toolCalls: [
        { id: 'partial-tool-a', toolName: 'lookup', input: { query: 'a' }, result: { data: 'denied', success: false }, status: 'rejected', riskLevel: 'high' },
        { id: 'partial-tool-b', toolName: 'lookup', input: { query: 'b' }, status: 'calling', riskLevel: 'high' }
      ] }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'partial-tool-invocation', turnId: 'partial-tool-turn', sequence: 1, schemaVersion: 1,
      eventId: 'partial-tool-context', idempotencyKey: 'partial-tool-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.id, role: user.role, content: user.content, timestamp: user.timestamp }] }
    }], 0)
    const appendRawEvent = (sequence: number, eventId: string, kind: string, payload: unknown) => {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run('partial-tool-invocation', sequence, eventId, eventId, 'partial-tool-turn', kind,
          JSON.stringify(payload), Date.now(), session.id, Number(allocated.lastInsertRowid), sequence)
    }
    appendRawEvent(2, 'partial-tool-response', 'model-response-committed', {
      message: { id: assistant.id, role: 'assistant', content: '', timestamp: assistant.timestamp, toolCalls: assistant.toolCalls?.map(({ id, toolName, input }) => ({ id, name: toolName, input })) }
    })
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('partial-tool-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [
      { id: user.id, role: user.role, content: user.content, timestamp: user.timestamp },
      { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp }
    ]
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    appendRawEvent(3, 'partial-tool-a-not-dispatched', 'tool-call-not-dispatched', { toolCallId: 'partial-tool-a', reason: 'POLICY_DENY' })
    appendRawEvent(4, 'partial-tool-interrupted', 'invocation-interrupted', { status: 'interrupted', reason: 'process-restart' })
    conn.prepare('UPDATE agent_history_streams SET version=4 WHERE invocation_id=?').run('partial-tool-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=4 WHERE session_id=?').run(session.id)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    const l1 = readSessionTranscriptProjection(db, session.id)
    expect(l1.source).toBe('canonical:L1')
    expect(l1.messages).toContainEqual(expect.objectContaining({ role: 'assistant', toolCalls: expect.arrayContaining([
      expect.objectContaining({ id: 'partial-tool-a' }), expect.objectContaining({ id: 'partial-tool-b' })
    ]) }))
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    expect(getMessages(db, session.id)[1]?.toolCalls).toMatchObject([
      { id: 'partial-tool-a', status: 'rejected', result: { data: 'denied', success: false } },
      { id: 'partial-tool-b', status: 'calling' }
    ])
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    const l2 = readSessionTranscriptProjection(db, session.id)
    expect(l2.source).toBe('canonical:L2')
    expect(l2.messages).toEqual(l1.messages)
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    expect(getMessages(db, session.id)[1]?.toolCalls).toMatchObject([
      { id: 'partial-tool-a', status: 'rejected', result: { data: 'denied', success: false } },
      { id: 'partial-tool-b', status: 'calling' }
    ])
    db.close()
  })

  it('preserves a completed tool result beside another unresolved tool across the L1 watermark', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'partial completed tool settlement across watermark', model: 'test' })
    const user = appendMessage(db, { id: 'finished-partial-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'finished-partial-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'completed',
      toolCalls: [
        { id: 'finished-partial-a', toolName: 'lookup', input: { query: 'a' }, result: { data: 'found', success: true }, status: 'completed', riskLevel: 'low' },
        { id: 'finished-partial-b', toolName: 'lookup', input: { query: 'b' }, status: 'calling', riskLevel: 'low' }
      ] }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'finished-partial-invocation', turnId: 'finished-partial-turn', sequence: 1, schemaVersion: 1,
      eventId: 'finished-partial-context', idempotencyKey: 'finished-partial-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.id, role: user.role, content: user.content, timestamp: user.timestamp }] }
    }], 0)
    const appendRawEvent = (sequence: number, eventId: string, kind: string, payload: unknown) => {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run('finished-partial-invocation', sequence, eventId, eventId, 'finished-partial-turn', kind,
          JSON.stringify(payload), Date.now(), session.id, Number(allocated.lastInsertRowid), sequence)
    }
    appendRawEvent(2, 'finished-partial-response', 'model-response-committed', {
      message: { id: assistant.id, role: 'assistant', content: '', timestamp: assistant.timestamp, toolCalls: assistant.toolCalls?.map(({ id, toolName, input }) => ({ id, name: toolName, input })) }
    })
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('finished-partial-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [
      { id: user.id, role: user.role, content: user.content, timestamp: user.timestamp },
      { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp }
    ]
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    appendRawEvent(3, 'finished-partial-a-started', 'tool-call-started', { toolCallId: 'finished-partial-a' })
    appendRawEvent(4, 'finished-partial-a-result', 'tool-call-finished', {
      toolCallId: 'finished-partial-a', success: true, result: { success: true, data: 'found' }
    })
    appendRawEvent(5, 'finished-partial-interrupted', 'invocation-interrupted', { status: 'interrupted', reason: 'process-restart' })
    conn.prepare('UPDATE agent_history_streams SET version=5 WHERE invocation_id=?').run('finished-partial-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=5 WHERE session_id=?').run(session.id)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    const l1 = readSessionTranscriptProjection(db, session.id)
    expect(l1.source).toBe('canonical:L1')
    expect(l1.messages).toContainEqual(expect.objectContaining({ role: 'assistant', toolCalls: expect.arrayContaining([
      expect.objectContaining({ id: 'finished-partial-a' }), expect.objectContaining({ id: 'finished-partial-b' })
    ]) }))
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    expect(getMessages(db, session.id)[1]?.toolCalls).toMatchObject([
      { id: 'finished-partial-a', status: 'completed', result: { data: 'found', success: true } },
      { id: 'finished-partial-b', status: 'calling' }
    ])
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    const l2 = readSessionTranscriptProjection(db, session.id)
    expect(l2.source).toBe('canonical:L2')
    expect(l2.messages).toEqual(l1.messages)
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    expect(getMessages(db, session.id)[1]?.toolCalls).toMatchObject([
      { id: 'finished-partial-a', status: 'completed', result: { data: 'found', success: true } },
      { id: 'finished-partial-b', status: 'calling' }
    ])
    db.close()
  })

  it('fails closed when a completed tool terminal contradicts its result success across the L1 watermark', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'contradictory tool result across watermark', model: 'test' })
    const user = appendMessage(db, { id: 'conflict-tool-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'conflict-tool-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'completed',
      toolCalls: [
        { id: 'conflict-tool-a', toolName: 'lookup', input: { query: 'a' }, status: 'calling', riskLevel: 'low' },
        { id: 'conflict-tool-b', toolName: 'lookup', input: { query: 'b' }, status: 'calling', riskLevel: 'low' }
      ] }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'conflict-tool-invocation', turnId: 'conflict-tool-turn', sequence: 1, schemaVersion: 1,
      eventId: 'conflict-tool-context', idempotencyKey: 'conflict-tool-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.id, role: user.role, content: user.content, timestamp: user.timestamp }] }
    }], 0)
    const appendRawEvent = (sequence: number, eventId: string, kind: string, payload: unknown) => {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run('conflict-tool-invocation', sequence, eventId, eventId, 'conflict-tool-turn', kind,
          JSON.stringify(payload), Date.now(), session.id, Number(allocated.lastInsertRowid), sequence)
    }
    appendRawEvent(2, 'conflict-tool-response', 'model-response-committed', {
      message: { id: assistant.id, role: 'assistant', content: '', timestamp: assistant.timestamp, toolCalls: assistant.toolCalls?.map(({ id, toolName, input }) => ({ id, name: toolName, input })) }
    })
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('conflict-tool-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [
      { id: user.id, role: user.role, content: user.content, timestamp: user.timestamp },
      { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp }
    ]
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    appendRawEvent(3, 'conflict-tool-started', 'tool-call-started', { toolCallId: 'conflict-tool-a' })
    appendRawEvent(4, 'conflict-tool-finished', 'tool-call-finished', {
      toolCallId: 'conflict-tool-a', success: true, result: { success: false, error: 'contradictory result' }
    })
    appendRawEvent(5, 'conflict-tool-interrupted', 'invocation-interrupted', { status: 'interrupted', reason: 'process-restart' })
    conn.prepare('UPDATE agent_history_streams SET version=5 WHERE invocation_id=?').run('conflict-tool-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=5 WHERE session_id=?').run(session.id)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'unavailable', reason: 'snapshot-invalid' })
    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'unavailable', reason: 'snapshot-invalid' })
    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it.each([
    ['approval identity mismatch', { approvalId: 'different-approval-id', approved: false, outcome: 'denied', settledAt: 3 }],
    ['approved/outcome mismatch', { approvalId: 'expected-approval-id', approved: false, outcome: 'approved', settledAt: 3 }]
  ] as const)('rejects an %s resolution across the L1 watermark in both L1 and L2', async (_label, resolutionPayload) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'mismatched approval across watermark', model: 'test' })
    appendMessage(db, { id: 'mismatched-approval-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'mismatched-approval-invocation', turnId: 'mismatched-approval-turn', sequence: 1, schemaVersion: 1,
        eventId: 'mismatched-approval-context', idempotencyKey: 'mismatched-approval-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'mismatched-approval-user', role: 'user', content: 'question', timestamp: 1 }] } },
      { invocationId: 'mismatched-approval-invocation', turnId: 'mismatched-approval-turn', sequence: 2, schemaVersion: 1,
        eventId: 'mismatched-approval-wait', idempotencyKey: 'mismatched-approval-wait', kind: 'approval-waiting',
        payload: { approvalId: 'expected-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 } }
    ], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)

    const appendRawEvent = (sequence: number, eventId: string, kind: string, payload: unknown) => {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run('mismatched-approval-invocation', sequence, eventId, eventId, 'mismatched-approval-turn', kind,
          JSON.stringify(payload), Date.now(), session.id, Number(allocated.lastInsertRowid), sequence)
    }
    appendRawEvent(3, 'mismatched-approval-resolution', 'approval-resolved', resolutionPayload)
    appendRawEvent(4, 'mismatched-approval-terminal', 'invocation-completed', { status: 'completed' })
    conn.prepare('UPDATE agent_history_streams SET version=4 WHERE invocation_id=?').run('mismatched-approval-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=4 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'unavailable' })
    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    db.close()
  })

  it.each([
    ['proposal', 'completed', 'invocation-completed', { status: 'completed' }, false],
    ['proposal', 'failed', 'invocation-failed', { status: 'failed' }, false],
    ['proposal', 'denied', 'invocation-failed', { status: 'denied' }, false],
    ['started dispatch', 'completed', 'invocation-completed', { status: 'completed' }, true],
    ['started dispatch', 'failed', 'invocation-failed', { status: 'failed' }, true],
    ['started dispatch', 'denied', 'invocation-failed', { status: 'denied' }, true]
  ] as const)('rejects a %s tail when the cached prefix contains an unresolved tool %s', async (_state, _label, terminalKind, terminalPayload, dispatchStarted) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'pending proposal before transcript watermark', model: 'test' })
    const user = appendMessage(db, { id: 'watermarked-proposal-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'watermarked-proposal-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'completed',
      toolCalls: [{ id: 'watermarked-proposal-call', name: 'lookup', input: { query: 'q' } }] }).message
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,user_message_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('watermarked-proposal-turn','watermarked-proposal-request',?,?,?,'executing',1,1,0)`)
      .run(session.id, user.id, assistant.id)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'watermarked-proposal-invocation', turnId: 'watermarked-proposal-turn', sequence: 1, schemaVersion: 1,
        eventId: 'watermarked-proposal-context', idempotencyKey: 'watermarked-proposal-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: user.id, role: user.role, content: user.content, timestamp: user.timestamp }] }
    }], 0)
    const proposalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'model-response-committed',?,?,?,?,?)`)
      .run('watermarked-proposal-invocation', 2, 'watermarked-proposal-response', 'watermarked-proposal-response', 'watermarked-proposal-turn',
        JSON.stringify({ message: { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp,
          toolCalls: [{ id: 'watermarked-proposal-call', name: 'lookup', input: { query: 'q' } }] } }), Date.now(), session.id, proposalCommitOrder, 2)
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('watermarked-proposal-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    let terminalSequence = 3
    if (dispatchStarted) {
      const startCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'tool-call-started',?,?,?,?,?)`)
        .run('watermarked-proposal-invocation', 3, 'watermarked-proposal-start', 'watermarked-proposal-start', 'watermarked-proposal-turn',
          JSON.stringify({ toolCallId: 'watermarked-proposal-call' }), Date.now(), session.id, startCommitOrder, 3)
      conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run('watermarked-proposal-invocation')
      conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)
      terminalSequence = 4
    }
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [
      { id: user.id, role: user.role, content: user.content, timestamp: user.timestamp },
      { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp }
    ]
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')

    const commitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run('watermarked-proposal-invocation', terminalSequence, 'watermarked-proposal-terminal', 'watermarked-proposal-terminal', 'watermarked-proposal-turn', terminalKind,
        JSON.stringify(terminalPayload), Date.now(), session.id, commitOrder, terminalSequence)
    conn.prepare('UPDATE agent_history_streams SET version=? WHERE invocation_id=?').run(terminalSequence, 'watermarked-proposal-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=? WHERE session_id=?').run(terminalSequence, session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it.each([
    ['completed', 'invocation-completed', { status: 'completed' }],
    ['failed', 'invocation-failed', { status: 'failed' }],
    ['denied', 'invocation-failed', { status: 'denied' }]
  ] as const)('rejects a %s tail when the cached prefix already contains an unresolved approval', async (_label, terminalKind, terminalPayload) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'pending approval before transcript watermark', model: 'test' })
    const user = appendMessage(db, { id: 'watermarked-approval-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'watermarked-approval-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'watermarked-approval-invocation', turnId: 'watermarked-approval-turn', sequence: 1, schemaVersion: 1,
      eventId: 'watermarked-approval-context', idempotencyKey: 'watermarked-approval-context', kind: 'invocation-context-committed',
      payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
    }], 0)
    const approvalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'approval-waiting',?,?,?,?,?)`)
      .run('watermarked-approval-invocation', 2, 'watermarked-approval-wait', 'watermarked-approval-wait', 'watermarked-approval-turn',
        JSON.stringify({ approvalId: 'watermarked-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 }),
        Date.now(), session.id, approvalCommitOrder, 2)
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('watermarked-approval-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp }))
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')

    const terminalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run('watermarked-approval-invocation', 3, 'watermarked-approval-terminal', 'watermarked-approval-terminal', 'watermarked-approval-turn', terminalKind,
        JSON.stringify(terminalPayload), Date.now(), session.id, terminalCommitOrder, 3)
    conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run('watermarked-approval-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it.each([
    ['approval', 'approval-waiting', { approvalId: 'watermarked-interrupted-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 }, 'interrupted'],
    ['approval', 'approval-waiting', { approvalId: 'watermarked-cancelled-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 }, 'cancelled'],
  ] as const)('accepts an interrupted tail with status %s when the cached prefix contains an unresolved %s', async (_label, pendingKind, pendingPayload, terminalStatus) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'interrupted pending approval before transcript watermark', model: 'test' })
    const user = appendMessage(db, { id: 'watermarked-interrupted-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'watermarked-interrupted-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'watermarked-interrupted-invocation', turnId: 'watermarked-interrupted-turn', sequence: 1, schemaVersion: 1,
      eventId: 'watermarked-interrupted-context', idempotencyKey: 'watermarked-interrupted-context', kind: 'invocation-context-committed',
      payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
    }], 0)
    const approvalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run('watermarked-interrupted-invocation', 2, 'watermarked-interrupted-pending', 'watermarked-interrupted-pending', 'watermarked-interrupted-turn', pendingKind,
        JSON.stringify(pendingPayload),
        Date.now(), session.id, approvalCommitOrder, 2)
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('watermarked-interrupted-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp }))
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')

    const terminalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'invocation-interrupted',?,?,?,?,?)`)
      .run('watermarked-interrupted-invocation', 3, 'watermarked-interrupted-terminal', 'watermarked-interrupted-terminal', 'watermarked-interrupted-turn',
        JSON.stringify({ status: terminalStatus, reason: 'process-restart' }), Date.now(), session.id, terminalCommitOrder, 3)
    conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run('watermarked-interrupted-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1', messages: cachedMessages })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    expect(history.readSync('watermarked-interrupted-invocation').events.at(-1)).toMatchObject({
      kind: 'invocation-interrupted', payload: { status: terminalStatus, reason: 'process-restart' }
    })
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: cachedMessages })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it.each([
    ['proposal', false, 'interrupted'],
    ['proposal', false, 'cancelled'],
    ['started dispatch', true, 'interrupted'],
    ['started dispatch', true, 'cancelled']
  ] as const)('accepts an %s tail after a cached unresolved tool with terminal status %s', async (_label, dispatchStarted, terminalStatus) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'interrupted pending proposal before transcript watermark', model: 'test' })
    const user = appendMessage(db, { id: 'interrupted-proposal-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'interrupted-proposal-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'completed',
      toolCalls: [{ id: 'interrupted-proposal-call', name: 'lookup', input: { query: 'q' } }] }).message
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,user_message_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('interrupted-proposal-turn','interrupted-proposal-request',?,?,?,'executing',1,1,0)`)
      .run(session.id, user.id, assistant.id)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'interrupted-proposal-invocation', turnId: 'interrupted-proposal-turn', sequence: 1, schemaVersion: 1,
      eventId: 'interrupted-proposal-context', idempotencyKey: 'interrupted-proposal-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.id, role: user.role, content: user.content, timestamp: user.timestamp }] }
    }], 0)
    const proposalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'model-response-committed',?,?,?,?,?)`)
      .run('interrupted-proposal-invocation', 2, 'interrupted-proposal-response', 'interrupted-proposal-response', 'interrupted-proposal-turn',
        JSON.stringify({ message: { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp,
          toolCalls: [{ id: 'interrupted-proposal-call', name: 'lookup', input: { query: 'q' } }] } }), Date.now(), session.id, proposalCommitOrder, 2)
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('interrupted-proposal-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
    let terminalSequence = 3
    if (dispatchStarted) {
      const startCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'tool-call-started',?,?,?,?,?)`)
        .run('interrupted-proposal-invocation', 3, 'interrupted-proposal-start', 'interrupted-proposal-start', 'interrupted-proposal-turn',
          JSON.stringify({ toolCallId: 'interrupted-proposal-call' }), Date.now(), session.id, startCommitOrder, 3)
      conn.prepare('UPDATE agent_history_streams SET version=3 WHERE invocation_id=?').run('interrupted-proposal-invocation')
      conn.prepare('UPDATE session_event_cursor SET next_seq=3 WHERE session_id=?').run(session.id)
      terminalSequence = 4
    }
    const watermark = conn.prepare(`SELECT events.session_seq AS sessionSeq, events.commit_order AS commitOrder,
      events.event_id AS watermarkEventId, events.invocation_id AS watermarkInvocationId, sessions.generation AS sessionGeneration,
      (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount
      FROM agent_history_events events JOIN sessions ON sessions.id=events.session_id
      WHERE events.session_id=? ORDER BY events.session_seq DESC LIMIT 1`)
      .get(session.id, session.id) as { sessionSeq: number; commitOrder: number; watermarkEventId: string; watermarkInvocationId: string; sessionGeneration: string; eventCount: number }
    const cachedMessages = [
      { id: user.id, role: user.role, content: user.content, timestamp: user.timestamp },
      { id: assistant.id, role: assistant.role, content: assistant.content, timestamp: assistant.timestamp }
    ]
    expect(history.writeCanonicalSessionCache({ kind: 'matched', sessionId: session.id, ...watermark, messages: cachedMessages,
      cacheKey: 'transcript', value: JSON.stringify(cachedMessages) })).toBe(true)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')

    const terminalCommitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'invocation-interrupted',?,?,?,?,?)`)
      .run('interrupted-proposal-invocation', terminalSequence, 'interrupted-proposal-terminal', 'interrupted-proposal-terminal', 'interrupted-proposal-turn',
        JSON.stringify({ status: terminalStatus, reason: 'process-restart' }), Date.now(), session.id, terminalCommitOrder, terminalSequence)
    conn.prepare('UPDATE agent_history_streams SET version=? WHERE invocation_id=?').run(terminalSequence, 'interrupted-proposal-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=? WHERE session_id=?').run(terminalSequence, session.id)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L1', messages: cachedMessages })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    expect(history.readSync('interrupted-proposal-invocation').events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: terminalStatus } })
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: cachedMessages })
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(['', ''])
    db.close()
  })

  it.each([
    ['orphan finish', [
      ['tool-call-finished', { toolCallId: 'orphan-call', success: true }]
    ]],
    ['proposed tool result without dispatch start', [
      ['tool-call-finished', { toolCallId: 'missing-start-tool', success: true, result: { success: true, output: 'executed' } }]
    ]],
    ['duplicate approval identity across tool calls', [
      ['approval-waiting', { toolCallId: 'duplicate-approval-tool-a', approvalId: 'reused-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-waiting', { toolCallId: 'duplicate-approval-tool-b', approvalId: 'reused-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { toolCallId: 'duplicate-approval-tool-a', approvalId: 'reused-approval-id', approved: true, outcome: 'approved', settledAt: 2 }],
      ['approval-resolved', { toolCallId: 'duplicate-approval-tool-b', approvalId: 'reused-approval-id', approved: true, outcome: 'approved', settledAt: 2 }],
      ['tool-call-started', { toolCallId: 'duplicate-approval-tool-a' }],
      ['tool-call-finished', { toolCallId: 'duplicate-approval-tool-a', success: true, result: { success: true, data: 'a' } }],
      ['tool-call-started', { toolCallId: 'duplicate-approval-tool-b' }],
      ['tool-call-finished', { toolCallId: 'duplicate-approval-tool-b', success: true, result: { success: true, data: 'b' } }]
    ]],
    ['orphan dispatch start', [
      ['tool-call-started', { toolCallId: 'orphan-start-call' }]
    ]],
    ['duplicate dispatch start', [
      ['tool-call-started', { toolCallId: 'duplicate-start-call' }],
      ['tool-call-started', { toolCallId: 'duplicate-start-call' }]
    ]],
    ['duplicate proposal identity', [
      ['model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'duplicate-proposal' }, { id: 'duplicate-proposal' }] } }]
    ]],
    ['orphan approval resolution', [
      ['approval-resolved', { approvalId: 'orphan-approval', approved: true }]
    ]],
    ['dispatch after unbound denied approval', [
      ['approval-waiting', { approvalId: 'unbound-denied-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { approvalId: 'unbound-denied-approval-id', approved: false, outcome: 'denied', settledAt: 2 }],
      ['tool-call-started', { toolCallId: 'unbound-denied-tool' }]
    ]],
    ['proposal after unbound approval', [
      ['approval-waiting', { approvalId: 'unbound-before-proposal-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { approvalId: 'unbound-before-proposal-approval-id', approved: false, outcome: 'denied', settledAt: 2 }],
      ['model-response-committed', { message: { id: 'proposal after unbound approval-assistant', role: 'assistant', content: '', timestamp: 2,
        toolCalls: [{ id: 'unbound-before-proposal-tool', name: 'write_file', input: { path: 'a.txt' } }] } }],
      ['tool-call-started', { toolCallId: 'unbound-before-proposal-tool' }]
    ]],
    ['duplicate approval wait', [
      ['approval-waiting', { toolCallId: 'approval-call', approvalId: 'approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-waiting', { toolCallId: 'approval-call', approvalId: 'approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 }]
    ]],
    ['approval identity mismatch', [
      ['approval-waiting', { toolCallId: 'approval-call', approvalId: 'approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { toolCallId: 'approval-call', approvalId: 'other-approval-id', approved: false, outcome: 'denied' }]
    ]],
    ['invalid approval waiting metadata', [
      ['approval-waiting', { approvalId: 'invalid-metadata-approval', answerer: 'unknown', reasonCode: 'confirm', requestedAt: 1 }]
    ]],
    ['approval outcome mismatch', [
      ['approval-waiting', { approvalId: 'outcome-mismatch-approval', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { approvalId: 'outcome-mismatch-approval', approved: false, outcome: 'approved', settledAt: 2 }]
    ]],
    ...(['denied', 'timeout', 'unavailable', 'cancelled'] as const).map((outcome) => [`dispatch after ${outcome} approval`, [
      ['approval-waiting', { toolCallId: `${outcome}-approval-tool`, approvalId: `${outcome}-approval-id`, answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { toolCallId: `${outcome}-approval-tool`, approvalId: `${outcome}-approval-id`, approved: false, outcome, settledAt: 2 }],
      ['tool-call-started', { toolCallId: `${outcome}-approval-tool` }]
    ] as const]),
    ...(['denied', 'timeout', 'unavailable', 'cancelled'] as const).map((outcome) => [`tool result after ${outcome} approval`, [
      ['approval-waiting', { toolCallId: `${outcome}-approval-tool`, approvalId: `${outcome}-approval-id`, answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { toolCallId: `${outcome}-approval-tool`, approvalId: `${outcome}-approval-id`, approved: false, outcome, settledAt: 2 }],
      ['tool-call-finished', { toolCallId: `${outcome}-approval-tool`, success: true, result: { success: true, output: 'executed' } }]
    ] as const]),
    ['dispatch before denied approval', [
      ['tool-call-started', { toolCallId: 'denied-approval-tool' }],
      ['approval-waiting', { toolCallId: 'denied-approval-tool', approvalId: 'denied-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { toolCallId: 'denied-approval-tool', approvalId: 'denied-approval-id', approved: false, outcome: 'denied', settledAt: 2 }],
      ['tool-call-not-dispatched', { toolCallId: 'denied-approval-tool' }]
    ]],
    ['invalid approval resolution timestamp', [
      ['approval-waiting', { approvalId: 'invalid-timestamp-approval', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }],
      ['approval-resolved', { approvalId: 'invalid-timestamp-approval', approved: false, outcome: 'denied', settledAt: 'later' }]
    ]]
  ] as const)('fails closed on canonical History %s transitions in both cache states', async (_label, transitions) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `invalid ${_label}`, model: 'test' })
    appendMessage(db, { id: `invalid-${_label}-user`, sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const unapprovedDispatch = _label.match(/^(?:dispatch (?:after|before)|tool result after) (denied|timeout|unavailable|cancelled) approval$/)?.[1]
    const proposalToolId = unapprovedDispatch ? `${unapprovedDispatch}-approval-tool`
      : _label === 'dispatch after unbound denied approval' ? 'unbound-denied-tool'
      : _label === 'duplicate approval identity across tool calls' ? 'duplicate-approval-tool-a'
      : _label === 'proposed tool result without dispatch start' ? 'missing-start-tool' : undefined
    const unapprovedApprovalAssistant = proposalToolId
      ? appendMessage(db, { id: `${_label}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming',
          toolCalls: [proposalToolId, ...(_label === 'duplicate approval identity across tool calls' ? ['duplicate-approval-tool-b'] : [])]
            .map((id) => ({ id, toolName: 'write_file', input: { path: 'a.txt' }, status: 'calling' as const, riskLevel: 'high' as const })) }).message
      : undefined
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: `invalid-${_label}-invocation`, turnId: `invalid-${_label}-turn`, sequence: 1, schemaVersion: 1,
      eventId: `invalid-${_label}-context`, idempotencyKey: `invalid-${_label}-context`, kind: 'invocation-context-committed',
      payload: { messages: [{ id: `invalid-${_label}-user`, role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    let initialEventCount = 1
    if (unapprovedApprovalAssistant) {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'model-response-committed',?,?,?,?,?)`)
        .run(`invalid-${_label}-invocation`, 2, `invalid-${_label}-proposal`, `invalid-${_label}-proposal`, `invalid-${_label}-turn`,
          JSON.stringify({ message: { id: unapprovedApprovalAssistant.id, role: 'assistant', content: '', timestamp: unapprovedApprovalAssistant.timestamp,
            toolCalls: unapprovedApprovalAssistant.toolCalls?.map(({ id, toolName, input }) => ({ id, name: toolName, input })) } }), Date.now(), session.id,
          Number(allocated.lastInsertRowid), 2)
      conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run(`invalid-${_label}-invocation`)
      conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)
      initialEventCount = 2
    }
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only',status=CASE WHEN role='assistant' THEN 'completed' ELSE status END WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)
    const invocationId = `invalid-${_label}-invocation`
    const turnId = `invalid-${_label}-turn`
    let sequence = initialEventCount + 1
    for (const [kind, payload] of transitions) {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run(invocationId, sequence, `invalid-${_label}-${sequence}`, `invalid-${_label}-${sequence}`, turnId, kind,
          JSON.stringify(payload), Date.now(), session.id, Number(allocated.lastInsertRowid), sequence)
      sequence += 1
    }
    conn.prepare('UPDATE agent_history_streams SET version=? WHERE invocation_id=?').run(sequence - 1, invocationId)
    conn.prepare('UPDATE session_event_cursor SET next_seq=? WHERE session_id=?').run(sequence - 1, session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(unapprovedApprovalAssistant ? ['', ''] : [''])
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'unavailable' })
    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual(unapprovedApprovalAssistant ? ['', ''] : [''])
    db.close()
  })

  it.each([
    ['completed', 'invocation-completed', 'failed'],
    ['failed', 'invocation-failed', 'completed'],
    ['interrupted', 'invocation-interrupted', 'failed']
  ] as const)('fails closed when cached terminal kind %s carries status %s', async (label, terminalKind, status) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `terminal ${label} status mismatch`, model: 'test' })
    appendMessage(db, { id: `terminal-${label}-user`, sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: `terminal-${label}-invocation`, turnId: `terminal-${label}-turn`, sequence: 1, schemaVersion: 1,
      eventId: `terminal-${label}-context`, idempotencyKey: `terminal-${label}-context`, kind: 'invocation-context-committed',
      payload: { messages: [{ id: `terminal-${label}-user`, role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)

    const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run(`terminal-${label}-invocation`, 2, `terminal-${label}-tail`, `terminal-${label}-tail`, `terminal-${label}-turn`, terminalKind,
        JSON.stringify({ status }), Date.now(), session.id, Number(allocated.lastInsertRowid), 2)
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run(`terminal-${label}-invocation`)
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
    db.close()
  })

  it('rebuilds canonical-only transcript when a syntactically valid cache body is tampered', async () => {
    const temp = createTempDatabase('tampered-transcript-cache-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'tampered transcript body cache', model: 'test' })
      const body = 'authoritative History body'
      appendMessage(temp.db, { id: 'tampered-cache-user', sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'tampered-cache-invocation', turnId: 'tampered-cache-turn', sequence: 1, schemaVersion: 1,
        eventId: 'tampered-cache-context', idempotencyKey: 'tampered-cache-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'tampered-cache-user', role: 'user', content: body, timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run('tampered-cache-user')
      expect(readSessionTranscriptProjection(temp.db, session.id)).toMatchObject({ messages: [
        { id: 'tampered-cache-user', role: 'user', content: body }
      ] })
      temp.db.close()

      reopened = openDatabase(temp.dbPath)
      const reopenedConn = getDbConnection(reopened)
      reopenedConn.prepare(`UPDATE canonical_session_projection_cache SET value=? WHERE session_id=? AND cache_key='transcript'`)
        .run(JSON.stringify([{ id: 'tampered-cache-user', role: 'user', content: 'forged cache body', timestamp: 1 }]), session.id)

      expect(readSessionTranscriptProjection(reopened, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
        { id: 'tampered-cache-user', role: 'user', content: body }
      ] })
      expect(getMessage(reopened, 'tampered-cache-user')?.content).toBe('')
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it.each(['generation', 'watermark-event', 'watermark-commit-order', 'watermark-session-seq', 'watermark-event-count', 'cursor-behind', 'cursor-missing'] as const)(
    'rebuilds canonical-only transcript after persisted cache %s drift', async (drift) => {
    const temp = createTempDatabase(`canonical-cache-${drift}-drift-`)
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: `canonical cache ${drift} drift`, model: 'test' })
      const body = 'fresh body after stale cache fence'
      appendMessage(temp.db, { id: `cache-${drift}-user`, sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: `cache-${drift}-invocation`, turnId: `cache-${drift}-turn`, sequence: 1, schemaVersion: 1,
        eventId: `cache-${drift}-context`, idempotencyKey: `cache-${drift}-context`, kind: 'invocation-context-committed',
        payload: { messages: [{ id: `cache-${drift}-user`, role: 'user', content: body, timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toMatch(/^canonical:/)
      temp.db.close()

      reopened = openDatabase(temp.dbPath)
      const reopenedConn = getDbConnection(reopened)
      if (drift === 'generation') {
        reopenedConn.prepare("UPDATE canonical_session_projection_cache SET session_generation='stale-generation' WHERE session_id=? AND cache_key='transcript'")
          .run(session.id)
      } else if (drift === 'watermark-event') {
        reopenedConn.prepare("UPDATE canonical_session_projection_cache SET watermark_event_id='stale-watermark' WHERE session_id=? AND cache_key='transcript'")
          .run(session.id)
      } else if (drift === 'watermark-commit-order') {
        reopenedConn.prepare('UPDATE canonical_session_projection_cache SET commit_order=commit_order+1 WHERE session_id=? AND cache_key=\'transcript\'')
          .run(session.id)
      } else if (drift === 'watermark-session-seq') {
        reopenedConn.prepare('UPDATE canonical_session_projection_cache SET session_seq=session_seq-1 WHERE session_id=? AND cache_key=\'transcript\'')
          .run(session.id)
      } else if (drift === 'watermark-event-count') {
        reopenedConn.prepare('UPDATE canonical_session_projection_cache SET event_count=event_count+1 WHERE session_id=? AND cache_key=\'transcript\'')
          .run(session.id)
      } else if (drift === 'cursor-behind') {
        reopenedConn.prepare('UPDATE session_event_cursor SET next_seq=0 WHERE session_id=?').run(session.id)
      } else {
        reopenedConn.prepare('DELETE FROM session_event_cursor WHERE session_id=?').run(session.id)
      }
      reopened.close()
      reopened = openDatabase(temp.dbPath)

      if (drift === 'cursor-behind' || drift === 'cursor-missing') {
        expect(() => readSessionTranscriptProjection(reopened, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      } else {
        expect(readSessionTranscriptProjection(reopened, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
          { id: `cache-${drift}-user`, role: 'user', content: body }
        ] })
      }
      expect(getMessage(reopened, `cache-${drift}-user`)?.content).toBe('')
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it('rejects a canonical session snapshot whose invocation sequence has a gap', async () => {
    const temp = createTempDatabase('canonical-invocation-sequence-gap-')
    try {
      const session = createSession(temp.db, { name: 'invocation sequence gap', model: 'test' })
      appendMessage(temp.db, { id: 'sequence-gap-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'sequence-gap-invocation', turnId: 'sequence-gap-turn', sequence: 1, schemaVersion: 1,
        eventId: 'sequence-gap-context', idempotencyKey: 'sequence-gap-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'sequence-gap-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toMatch(/^canonical:/)

      conn.prepare('UPDATE agent_history_events SET sequence=3 WHERE event_id=?').run('sequence-gap-context')

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('rejects a cached canonical-only transcript when a History event changes session ownership', async () => {
    const temp = createTempDatabase('canonical-history-event-session-owner-drift-')
    try {
      const session = createSession(temp.db, { name: 'history owner drift', model: 'test' })
      const otherSession = createSession(temp.db, { name: 'other history owner', model: 'test' })
      appendMessage(temp.db, { id: 'history-owner-drift-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'history-owner-drift-invocation', turnId: 'history-owner-drift-turn', sequence: 1, schemaVersion: 1,
        eventId: 'history-owner-drift-context', idempotencyKey: 'history-owner-drift-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'history-owner-drift-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L1')

      conn.prepare('UPDATE agent_history_events SET session_id=? WHERE event_id=?').run(otherSession.id, 'history-owner-drift-context')

      expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id)).toBeUndefined()
      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('rejects a cached canonical-only transcript when a History stream is rebound to another session', async () => {
    const temp = createTempDatabase('canonical-history-stream-owner-drift-')
    try {
      const session = createSession(temp.db, { name: 'history stream owner drift', model: 'test' })
      const otherSession = createSession(temp.db, { name: 'other history stream owner', model: 'test' })
      appendMessage(temp.db, { id: 'history-stream-owner-drift-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'history-stream-owner-drift-invocation', turnId: 'history-stream-owner-drift-turn', sequence: 1, schemaVersion: 1,
        eventId: 'history-stream-owner-drift-context', idempotencyKey: 'history-stream-owner-drift-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'history-stream-owner-drift-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L1')

      conn.prepare('UPDATE agent_history_streams SET session_id=? WHERE invocation_id=?')
        .run(otherSession.id, 'history-stream-owner-drift-invocation')

      expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id)).toBeUndefined()
      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('rejects a cached transcript when a tail event skips an invocation sequence', async () => {
    const temp = createTempDatabase('canonical-tail-sequence-gap-')
    try {
      const session = createSession(temp.db, { name: 'tail stream drift', model: 'test' })
      appendMessage(temp.db, { id: 'tail-drift-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'tail-gap-invocation', turnId: 'tail-gap-turn', sequence: 1, schemaVersion: 1,
        eventId: 'tail-gap-context', idempotencyKey: 'tail-gap-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'tail-drift-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toMatch(/^canonical:/)
      conn.prepare(`INSERT INTO agent_history_events
        (invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, session_seq, commit_order, session_id, created_at)
        VALUES ('tail-gap-invocation', 3, 'tail-gap-compaction', 'tail-gap-compaction', 'tail-gap-turn', 1, 'transcript-compacted', ?, 2, 2, ?, 2)`)
        .run(JSON.stringify({ messages: [{ id: 'tail-drift-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }), session.id)
      conn.prepare("UPDATE agent_history_streams SET version=2 WHERE invocation_id='tail-gap-invocation'").run()
      conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('rejects a cached transcript when a non-transcript tail event changes invocation turn identity', async () => {
    const temp = createTempDatabase('canonical-tail-turn-identity-drift-')
    try {
      const session = createSession(temp.db, { name: 'tail turn identity drift', model: 'test' })
      appendMessage(temp.db, { id: 'tail-turn-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'tail-turn-invocation', turnId: 'original-turn', sequence: 1, schemaVersion: 1,
        eventId: 'tail-turn-context', idempotencyKey: 'tail-turn-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'tail-turn-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L1')

      const commitOrder = Number((conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid)
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,'approval-updated','{}',?,?,?,2)`)
        .run('tail-turn-invocation', 2, 'tail-turn-metadata', 'tail-turn-metadata', 'different-turn', Date.now(), session.id, commitOrder)
      conn.prepare("UPDATE agent_history_streams SET version=2 WHERE invocation_id='tail-turn-invocation'").run()
      conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it.each([
    ['version', "UPDATE agent_history_streams SET version=version+1 WHERE invocation_id='stream-drift-invocation'"],
    ['schema version', "UPDATE agent_history_streams SET schema_version=schema_version+1 WHERE invocation_id='stream-drift-invocation'"],
  ])('rejects an L2 snapshot when the invocation stream %s drifts', async (_label, sql) => {
    const temp = createTempDatabase('canonical-stream-drift-')
    try {
      const session = createSession(temp.db, { name: 'stream drift', model: 'test' })
      appendMessage(temp.db, { id: 'stream-drift-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'stream-drift-invocation', turnId: 'stream-drift-turn', sequence: 1, schemaVersion: 1,
        eventId: 'stream-drift-context', idempotencyKey: 'stream-drift-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'stream-drift-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare('DELETE FROM canonical_session_projection_cache WHERE session_id=?').run(session.id)
      conn.prepare(sql).run()

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it.each([
    ['session sequence', "UPDATE agent_history_events SET session_seq=4 WHERE event_id='order-drift-context'"],
    ['session ownership', "UPDATE agent_history_events SET session_id='foreign-session' WHERE event_id='order-drift-context'"],
  ])('fails closed when canonical History %s drifts', async (_label, sql) => {
    const temp = createTempDatabase('canonical-order-drift-')
    try {
      const session = createSession(temp.db, { name: 'order drift', model: 'test' })
      appendMessage(temp.db, { id: 'order-drift-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'order-drift-invocation', turnId: 'order-drift-turn', sequence: 1, schemaVersion: 1,
        eventId: 'order-drift-context', idempotencyKey: 'order-drift-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'order-drift-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare('DELETE FROM canonical_session_projection_cache WHERE session_id=?').run(session.id)
      conn.prepare(sql).run()

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('fails closed on a warm L1 transcript when the global History allocator has an unpersisted allocation', async () => {
    const temp = createTempDatabase('canonical-warm-l1-global-commit-cursor-gap-')
    try {
      const session = createSession(temp.db, { name: 'warm L1 global cursor gap', model: 'test' })
      appendMessage(temp.db, { id: 'warm-l1-global-cursor-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'warm-l1-global-cursor-invocation', turnId: 'warm-l1-global-cursor-turn', sequence: 1, schemaVersion: 1,
        eventId: 'warm-l1-global-cursor-context', idempotencyKey: 'warm-l1-global-cursor-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'warm-l1-global-cursor-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L1')

      conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now())

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('fails closed when the global History commit cursor is ahead of persisted events', async () => {
    const temp = createTempDatabase('canonical-commit-cursor-gap-')
    try {
      const session = createSession(temp.db, { name: 'commit cursor gap', model: 'test' })
      appendMessage(temp.db, { id: 'commit-cursor-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'commit-cursor-invocation', turnId: 'commit-cursor-turn', sequence: 1, schemaVersion: 1,
        eventId: 'commit-cursor-context', idempotencyKey: 'commit-cursor-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'commit-cursor-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare('DELETE FROM canonical_session_projection_cache WHERE session_id=?').run(session.id)
      conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now())

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it('fails closed when the global History commit cursor has an interior gap', async () => {
    const temp = createTempDatabase('canonical-commit-cursor-interior-gap-')
    try {
      const session = createSession(temp.db, { name: 'commit cursor interior gap', model: 'test' })
      appendMessage(temp.db, { id: 'commit-cursor-gap-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'commit-cursor-gap-invocation', turnId: 'commit-cursor-gap-turn', sequence: 1, schemaVersion: 1,
        eventId: 'commit-cursor-gap-context', idempotencyKey: 'commit-cursor-gap-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'commit-cursor-gap-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare('DELETE FROM canonical_session_projection_cache WHERE session_id=?').run(session.id)
      conn.prepare('DELETE FROM agent_history_commit_cursor WHERE id=1').run()

      expect(() => readSessionTranscriptProjection(temp.db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(temp.db, session.id).map(({ content }) => content)).toEqual([''])
    } finally {
      temp.cleanup()
    }
  })

  it.each([
    ['unknown event kind', "kind='future-event-kind',payload_json='{}'"],
    ['invalid JSON payload', "kind='transcript-compacted',payload_json='{'"],
    ['noncanonical JSON payload', "kind='transcript-compacted',payload_json='{\\\"value\\\":1.0}'"],
    ['tool event without an identity', "kind='tool-call-finished',payload_json='{}'"],
  ])('fails closed when a canonical History stream contains an %s', async (_label, update) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'unknown History event kind', model: 'test' })
    appendMessage(db, { id: 'unknown-kind-user', sessionId: session.id, role: 'user', content: 'authoritative body', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'unknown-kind-invocation', turnId: 'unknown-kind-turn', sequence: 1, schemaVersion: 1,
      eventId: 'unknown-kind-context', idempotencyKey: 'unknown-kind-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'unknown-kind-user', role: 'user', content: 'authoritative body', timestamp: 1 }] }
    }], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)
    const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
      created_at,session_id,commit_order,session_seq) VALUES('unknown-kind-invocation',2,'unknown-kind-tail','unknown-kind-tail',
      'unknown-kind-turn',1,'transcript-compacted','{}',?,?,?,2)`)
      .run(Date.now(), session.id, Number(allocated.lastInsertRowid))
    conn.prepare(`UPDATE agent_history_events SET ${update} WHERE event_id='unknown-kind-tail'`).run()
    conn.prepare("UPDATE agent_history_streams SET version=2 WHERE invocation_id='unknown-kind-invocation'").run()
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getMessages(db, session.id).map(({ content }) => content)).toEqual([''])
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

  it('rebuilds canonical-backed-only message bodies from History after legacy content is cleared', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical-only projection', model: 'test' })
    const canonicalBody = 'canonical body 100%_token'
    appendMessage(db, { id: 'canonical-only-user', sessionId: session.id, role: 'user', content: canonicalBody, timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'canonical-only-empty-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'completed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'canonical-only-invocation', turnId: 'canonical-only-turn', sequence: 1, schemaVersion: 1,
      eventId: 'canonical-only-context', idempotencyKey: 'canonical-only-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'canonical-only-user', role: 'user', content: canonicalBody, timestamp: 1 },
        { id: 'canonical-only-empty-assistant', role: 'assistant', content: '', timestamp: 2 }
      ] }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({
      source: 'canonical:L2', messages: [
        { id: 'canonical-only-user', content: canonicalBody, role: 'user', timestamp: 1 },
        { id: 'canonical-only-empty-assistant', content: '', role: 'assistant', timestamp: 2 }
      ]
    })
    expect(getProjectedChatMessagePage(db, session.id, null, 20).entries[0]?.message.content).toBe(canonicalBody)
    expect(getApiContextBaseline(db, session.id).entries[0]?.message.content).toBe('')
    expect(getProjectedApiContextBaseline(db, session.id).entries[0]?.message.content).toBe(canonicalBody)
    expect(getMessage(db, 'canonical-only-user')?.content).toBe('')
    expect(getMessages(db, session.id)[0]?.content).toBe('')
    expect(getProjectedMessages(db, session.id)[0]?.content).toBe(canonicalBody)
    expect(getRecentTurnRoutingMessages(db, session.id)).toEqual([])
    expect(getProjectedRecentTurnRoutingMessages(db, session.id, 1)).toEqual([{ role: 'user', content: canonicalBody }])
    expect(getProjectedMessage(db, 'canonical-only-user')?.content).toBe(canonicalBody)
    const rawPage = getMessagesPageWithSequence(db, session.id, 0, 20)
    expect(rawPage.rows[0]?.message.content).toBe('')
    expect(getProjectedMessagesPageWithSequence(db, session.id, 0, 20).rows[0]?.message.content).toBe(canonicalBody)
    expect(getSearchCorpusPage(db, session.id, 0, 20).entries[0]?.message.content).toBe('')
    expect(getProjectedSearchCorpusPage(db, session.id, 0, 20).entries[0]?.message.content).toBe(canonicalBody)
    expect(searchMessages(db, 'canonical', '', 20)).toEqual([])
    expect(searchProjectedMessages(db, 'canonical', '', 20)).toMatchObject([{ messageId: 'canonical-only-user', content: canonicalBody }])
    expect(searchProjectedMessages(db, '100%_token', '', 20)).toMatchObject([{ messageId: 'canonical-only-user', content: canonicalBody }])
    db.close()
  })

  it('rejects canonical-only display when the authenticated terminal watermark event is deleted', async () => {
      const temp = createTempDatabase('canonical-terminal-watermark-deleted-')
      try {
        const session = createSession(temp.db, { name: 'corrupt terminal history', model: 'test' })
        const user = appendMessage(temp.db, { id: 'terminal-watermark-user', sessionId: session.id, role: 'user',
          content: 'canonical user', timestamp: 1, status: 'sent' }).message
        const assistant = appendMessage(temp.db, { id: 'terminal-watermark-assistant', sessionId: session.id, role: 'assistant',
          content: 'canonical answer', timestamp: 2, status: 'completed' }).message
        const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
        await history.appendBatch([
          { invocationId: 'terminal-watermark-invocation', turnId: 'terminal-watermark-turn', sequence: 1, schemaVersion: 1,
            eventId: 'terminal-watermark-context', idempotencyKey: 'terminal-watermark-context', kind: 'invocation-context-committed',
            payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
          { invocationId: 'terminal-watermark-invocation', turnId: 'terminal-watermark-turn', sequence: 2, schemaVersion: 1,
            eventId: 'terminal-watermark-terminal', idempotencyKey: 'terminal-watermark-terminal', kind: 'invocation-completed',
            payload: { status: 'completed' } }
        ], 0)
        const conn = getDbConnection(temp.db)
        conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
        conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
        expect(readSessionTranscriptProjection(temp.db, session.id).source).toMatch(/^canonical:/)
        conn.prepare('DELETE FROM agent_history_events WHERE event_id=?').run('terminal-watermark-terminal')
        temp.db.close()
        const reopened = openDatabase(temp.dbPath)
        try {
          expect(() => readSessionTranscriptProjection(reopened, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          expect(getMessages(reopened, session.id).map(({ content }) => content)).toEqual(['', ''])
        } finally {
          reopened.close()
        }
      } finally {
        temp.cleanup()
      }
  })

  it('rejects canonical-only display when terminal History is reordered before its context event', async () => {
    const temp = createTempDatabase('canonical-terminal-order-drift-')
    try {
      const session = createSession(temp.db, { name: 'terminal order drift', model: 'test' })
      appendMessage(temp.db, { id: 'terminal-order-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
      appendMessage(temp.db, { id: 'terminal-order-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([
        {
          invocationId: 'terminal-order-invocation', turnId: 'terminal-order-turn', sequence: 1, schemaVersion: 1,
          eventId: 'terminal-order-context', idempotencyKey: 'terminal-order-context', kind: 'invocation-context-committed',
          payload: { messages: [
            { id: 'terminal-order-user', role: 'user', content: 'question', timestamp: 1 },
            { id: 'terminal-order-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
          ] }
        },
        {
          invocationId: 'terminal-order-invocation', turnId: 'terminal-order-turn', sequence: 2, schemaVersion: 1,
          eventId: 'terminal-order-terminal', idempotencyKey: 'terminal-order-terminal', kind: 'invocation-completed', payload: { status: 'completed' }
        }
      ], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L1')

      // Use a free sequence temporarily to avoid the invocation/sequence primary key collision.
      conn.prepare("UPDATE agent_history_events SET sequence=3 WHERE event_id='terminal-order-terminal'").run()
      conn.prepare("UPDATE agent_history_events SET sequence=2 WHERE event_id='terminal-order-context'").run()
      conn.prepare("UPDATE agent_history_events SET sequence=1 WHERE event_id='terminal-order-terminal'").run()

      expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id)).toBeUndefined()
      temp.db.close()
      const reopened = openDatabase(temp.dbPath)
      try {
        expect(() => readSessionTranscriptProjection(reopened, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        expect(getMessages(reopened, session.id).map(({ content }) => content)).toEqual(['', ''])
      } finally {
        reopened.close()
      }
    } finally {
      temp.cleanup()
    }
  })

  it.each(['missing', 'tampered'] as const)('fails closed when canonical-only display source spill is %s', async (failure) => {
    const temp = createTempDatabase(`canonical-only-spill-${failure}-`)
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'canonical source spill', model: 'test' })
      const body = 'large canonical source body '.repeat(3_000)
      const user = appendMessage(temp.db, { id: `spill-${failure}-user`, sessionId: session.id, role: 'user',
        content: body, timestamp: 1, status: 'sent' }).message
      const assistant = appendMessage(temp.db, { id: `spill-${failure}-assistant`, sessionId: session.id, role: 'assistant',
        content: 'answer', timestamp: 2, status: 'completed' }).message
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: `spill-${failure}-invocation`, turnId: `spill-${failure}-turn`, sequence: 1, schemaVersion: 1,
          eventId: `spill-${failure}-context`, idempotencyKey: `spill-${failure}-context`, kind: 'invocation-context-committed',
          payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
        { invocationId: `spill-${failure}-invocation`, turnId: `spill-${failure}-turn`, sequence: 2, schemaVersion: 1,
          eventId: `spill-${failure}-terminal`, idempotencyKey: `spill-${failure}-terminal`, kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
      const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
        .get(`spill-${failure}-context`)!.payload_json as string) as {
          messages: Array<{ id: string; content: { __spaceassistant_spill_v1?: { locator?: string } } | string }>
        }
      const locator = stored.messages.find(({ id }) => id === user.id)?.content
      if (!locator || typeof locator === 'string' || !locator.__spaceassistant_spill_v1?.locator) {
        throw new Error('expected canonical source spill locator')
      }
      const spillPath = path.join(path.dirname(temp.dbPath), 'spill', locator.__spaceassistant_spill_v1.locator)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L2')
      const l1Samples: number[] = []
      for (let sample = 0; sample < 30; sample += 1) {
        const started = performance.now()
        const read = readSessionTranscriptProjection(temp.db, session.id)
        l1Samples.push(performance.now() - started)
        expect(read.source).toBe('canonical:L1')
        expect(read.messages.find(({ id }) => id === user.id)?.content).toBe(body)
      }
      l1Samples.sort((left, right) => left - right)
      const l1P95 = l1Samples[Math.ceil(l1Samples.length * 0.95) - 1]!
      console.info(`canonical-source-spill-l1-p95=${l1P95.toFixed(2)}ms bytes=${Buffer.byteLength(body, 'utf8')} samples=${l1Samples.length}`)
      expect(l1P95, `large source spill canonical L1 p95 ${l1P95.toFixed(2)}ms`).toBeLessThan(50)
      if (failure === 'missing') await fs.rm(spillPath)
      else await fs.writeFile(spillPath, 'tampered source bytes')
      temp.db.close()
      reopened = openDatabase(temp.dbPath)

      expect(() => readSessionTranscriptProjection(reopened, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      expect(getMessages(reopened, session.id).map(({ content }) => content)).toEqual(['', ''])
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it('keeps 20-round canonical-only multi-spill L1 and search reads within the response budget', async () => {
    const temp = createTempDatabase('canonical-multi-spill-perf-')
    try {
      const session = createSession(temp.db, { name: '20 round multi spill', model: 'test' })
      const body = `multi-spill-needle ${'large body '.repeat(7_600)}`
      const messages = Array.from({ length: 20 }, (_, index) => [
        { id: `multi-spill-user-${index}`, sessionId: session.id, role: 'user' as const, content: body, timestamp: index * 2 + 1, status: 'sent' as const },
        { id: `multi-spill-assistant-${index}`, sessionId: session.id, role: 'assistant' as const, content: body, timestamp: index * 2 + 2, status: 'completed' as const }
      ]).flat()
      const { appendMessagesAtomically } = await import('../database/operations')
      appendMessagesAtomically(temp.db, messages)
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'multi-spill-invocation', turnId: 'multi-spill-turn', sequence: 1, schemaVersion: 1,
        eventId: 'multi-spill-context', idempotencyKey: 'multi-spill-context', kind: 'invocation-context-committed',
        payload: { messages: messages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
      expect(readSessionTranscriptProjection(temp.db, session.id).source).toBe('canonical:L2')

      const measureP95 = (samples: number[]) => {
        samples.sort((left, right) => left - right)
        return samples[Math.ceil(samples.length * 0.95) - 1]!
      }
      const l1Samples: number[] = []
      const searchSamples: number[] = []
      for (let sample = 0; sample < 30; sample += 1) {
        let started = performance.now()
        const read = readSessionTranscriptProjection(temp.db, session.id)
        l1Samples.push(performance.now() - started)
        expect(read.source).toBe('canonical:L1')
        expect(read.messages).toHaveLength(40)

        started = performance.now()
        const hits = searchProjectedMessages(temp.db, 'multi-spill-needle', '', 20)
        searchSamples.push(performance.now() - started)
        expect(hits).toHaveLength(20)
      }
      const l1P95 = measureP95(l1Samples)
      const searchP95 = measureP95(searchSamples)
      console.info(`canonical-multi-spill-p95 l1=${l1P95.toFixed(2)}ms search=${searchP95.toFixed(2)}ms bytes=${Buffer.byteLength(body, 'utf8')} rounds=20 samples=30`)
      expect(l1P95, `20-round multi-spill L1 p95 ${l1P95.toFixed(2)}ms`).toBeLessThan(50)
      expect(searchP95, `20-round multi-spill search p95 ${searchP95.toFixed(2)}ms`).toBeLessThanOrEqual(20)
    } finally {
      temp.cleanup()
    }
  })

  it('measures cold-L1 canonical global search across multiple sessions and a large match set', async () => {
    const temp = createTempDatabase('canonical-global-search-multisession-perf-')
    try {
      const conn = getDbConnection(temp.db)
      const sessions = Array.from({ length: 3 }, (_, sessionIndex) => createSession(temp.db, {
        name: `global search session ${sessionIndex}`, model: 'test'
      }))
      const messages = sessions.flatMap((session, sessionIndex) => Array.from({ length: 240 }, (_, index) => ({
        id: `global-search-${sessionIndex}-${index}`,
        sessionId: session.id,
        role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
        content: `global-search-needle session-${sessionIndex} message-${index} ${'body '.repeat(24)}`,
        // Interleave sessions with unique timestamps so the first 60 ordered matches require all three L2 reads.
        timestamp: index * 3 + sessionIndex,
        status: (index % 2 ? 'completed' : 'sent') as 'completed' | 'sent'
      })))
      const { appendMessagesAtomically } = await import('../database/operations')
      appendMessagesAtomically(temp.db, messages)
      for (const session of sessions) {
        const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
        const sessionMessages = messages.filter(({ sessionId }) => sessionId === session.id)
        await history.appendBatch([{
          invocationId: `global-search-invocation-${session.id}`, turnId: `global-search-turn-${session.id}`, sequence: 1, schemaVersion: 1,
          eventId: `global-search-context-${session.id}`, idempotencyKey: `global-search-context-${session.id}`, kind: 'invocation-context-committed',
          payload: { messages: sessionMessages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
        }], 0)
        conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
        conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
        conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
      }

      const measureP95 = (samples: number[]) => {
        samples.sort((left, right) => left - right)
        return samples[Math.ceil(samples.length * 0.95) - 1]!
      }
      const samples: number[] = []
      const sampleSearch = () => {
        // Delete only the disposable transcript projections: every sample must rebuild each session from canonical L2.
        conn.prepare("DELETE FROM canonical_session_projection_cache WHERE cache_key='transcript'").run()
        const started = performance.now()
        const hits = searchProjectedMessages(temp.db, 'global-search-needle', '', 60)
        samples.push(performance.now() - started)
        expect(hits).toHaveLength(60)
        expect(new Set(hits.map(({ sessionId }) => sessionId)).size).toBe(3)
        expect(hits[0]?.messageId).toBe('global-search-2-239')
        expect(hits.every(({ content }) => content.includes('global-search-needle'))).toBe(true)
      }
      for (let warmup = 0; warmup < 10; warmup += 1) sampleSearch()
      samples.length = 0
      for (let iteration = 0; iteration < 30; iteration += 1) sampleSearch()
      const p95 = measureP95(samples)
      console.info(`canonical-global-search-cold-l1-p95=${p95.toFixed(2)}ms rows=${messages.length} sessions=${sessions.length} matches=60 samples=30`)
      expect(p95, `multi-session cold-L1 canonical global search p95 ${p95.toFixed(2)}ms; budget 20ms`).toBeLessThanOrEqual(20)
    } finally {
      temp.cleanup()
    }
  })

  it('keeps global search ordering and limits across legacy and canonical-only bodies with literal LIKE escapes', async () => {
    const db = createMemoryAppDb()
    const canonicalSession = createSession(db, { name: 'canonical search result' })
    const canonicalBody = String.raw`NEEDLE canonical literal a\b and %_ markers with Ä`
    appendMessage(db, { id: 'search-canonical-user', sessionId: canonicalSession.id, role: 'user', content: canonicalBody, timestamp: 100, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, canonicalSession.id)
    await history.appendBatch([{
      invocationId: 'search-canonical-invocation', turnId: 'search-canonical-turn', sequence: 1, schemaVersion: 1,
      eventId: 'search-canonical-context', idempotencyKey: 'search-canonical-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'search-canonical-user', role: 'user', content: canonicalBody, timestamp: 100 }] }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(canonicalSession.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run('search-canonical-user')

    const legacySession = createSession(db, { name: 'legacy search result' })
    appendMessage(db, { id: 'search-legacy-user', sessionId: legacySession.id, role: 'user', content: 'needle legacy', timestamp: 300, status: 'sent' })
    const decoySession = createSession(db, { name: 'escaped search decoy' })
    appendMessage(db, { id: 'search-escape-decoy', sessionId: decoySession.id, role: 'user', content: 'literal axxb markers', timestamp: 250, status: 'sent' })

    expect(searchProjectedMessages(db, 'needle', '', 1).map(({ messageId }) => messageId)).toEqual(['search-legacy-user'])
    expect(searchProjectedMessages(db, 'needle', '', 2).map(({ messageId, content }) => [messageId, content])).toEqual([
      ['search-legacy-user', 'needle legacy'], ['search-canonical-user', canonicalBody]
    ])
    expect(searchProjectedMessages(db, String.raw`a\b`, '', 20).map(({ messageId }) => messageId)).toEqual(['search-canonical-user'])
    expect(searchProjectedMessages(db, '%_', '', 20).map(({ messageId }) => messageId)).toEqual(['search-canonical-user'])
    expect(searchProjectedMessages(db, 'needle', '', 20).map(({ messageId }) => messageId)).toEqual(['search-legacy-user', 'search-canonical-user'])
    expect(searchProjectedMessages(db, 'Ä', '', 20).map(({ messageId }) => messageId)).toEqual(['search-canonical-user'])
    expect(searchProjectedMessages(db, 'ä', '', 20)).toEqual([])
    db.close()
  })

  it('searches a canonical-only body after database reopen and transcript cache loss', async () => {
    const temp = createTempDatabase('canonical-search-reopen-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'canonical search reopen' })
      const messages = ['search survives reopen needle-0', 'canonical page after reopen 1', 'canonical page after reopen 2']
        .map((content, index) => ({
          id: `search-reopen-user-${index}`, sessionId: session.id, role: 'user' as const, content, timestamp: index + 1, status: 'sent' as const
        }))
      const { appendMessagesAtomically } = await import('../database/operations')
      appendMessagesAtomically(temp.db, messages)
      const body = messages[0]!.content
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'search-reopen-invocation', turnId: 'search-reopen-turn', sequence: 1, schemaVersion: 1,
        eventId: 'search-reopen-context', idempotencyKey: 'search-reopen-context', kind: 'invocation-context-committed',
        payload: { messages: messages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
      }], 0)
      const conn = getDbConnection(temp.db)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
      temp.db.close()

      reopened = openDatabase(temp.dbPath)

      expect(searchProjectedMessages(reopened, 'needle-0', '', 10)).toEqual([{
        messageId: 'search-reopen-user-0', sessionId: session.id, content: body, sessionName: 'canonical search reopen'
      }])
      const page1 = getProjectedMessagesPageWithSequence(reopened, session.id, 0, 2)
      expect(page1.rows.map(({ sequence, message }) => [sequence, message.content])).toEqual([
        [0, messages[0]!.content], [1, messages[1]!.content]
      ])
      expect(page1.rows).toHaveLength(2)
      expect(page1.nextSequence).toBe(2)
      const page2 = getProjectedMessagesPageWithSequence(reopened, session.id, page1.nextSequence, 2)
      expect(page2.rows.map(({ sequence, message }) => [sequence, message.content])).toEqual([[2, messages[2]!.content]])
      expect(page2.rows).toHaveLength(1)
      expect(page2.nextSequence).toBe(3)
      expect(getDbConnection(reopened).prepare("SELECT cache_key FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
        .toEqual({ cache_key: 'transcript' })
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it('fails closed when a canonical-backed-only body has no matching canonical History entry', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'missing canonical-only body', model: 'test' })
    appendMessage(db, { id: 'missing-canonical-user', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id=?").run('missing-canonical-user')

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(() => getProjectedMessage(db, 'missing-canonical-user')).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(() => getProjectedMessagesPageWithSequence(db, session.id, 0, 20)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(() => getProjectedSearchCorpusPage(db, session.id, 0, 20)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(() => searchProjectedMessages(db, 'missing', '', 20)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    db.close()
  })

  it('resolves retry user and failed assistant bodies from canonical History after legacy bodies are cleared', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical retry bodies', model: 'test' })
    appendMessage(db, { id: 'retry-canonical-user', sessionId: session.id, role: 'user', content: 'retry input', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'retry-canonical-assistant', sessionId: session.id, role: 'assistant', content: 'failed answer', timestamp: 2, status: 'failed' })
    const { createPersistedTurn } = await import('../database/operations')
    createPersistedTurn(db, { turnId: 'retry-canonical-turn', requestId: 'retry-canonical-request', sessionId: session.id,
      assistantMessageId: 'retry-canonical-assistant', userMessageId: 'retry-canonical-user', state: 'terminal' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'retry-canonical-invocation', turnId: 'retry-canonical-turn', sequence: 1, schemaVersion: 1,
      eventId: 'retry-canonical-context', idempotencyKey: 'retry-canonical-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'retry-canonical-user', role: 'user', content: 'retry input', timestamp: 1 },
        { id: 'retry-canonical-assistant', role: 'assistant', content: 'failed answer', timestamp: 2 }
      ] }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    expect(resolveRetryContext(db, session.id, 'retry-canonical-assistant')).toBeNull()
    expect(resolveProjectedRetryContext(db, session.id, 'retry-canonical-assistant')).toMatchObject({
      failedAssistant: { message: { content: 'failed answer' } },
      currentUser: { message: { content: 'retry input' } }
    })
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
