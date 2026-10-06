import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendMessage, createPersistedTurn, createSession, enqueueQueuedUserMessage, getMessage, getRecentTurnRoutingMessages, getSession, getTurnContext, updateMessageContent } from '../database/operations'
import { openDatabase } from '../database'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { fieldDifferences, readCanonicalTurnContextCandidate, shadowAcceptedTurnContext, shadowTurnRoutingInput } from './sessionStorageShadow'
import { projectAgentLogFields } from '../agentLogger/agentLogProjection'
import * as agentLogger from '../agentLogger/agentLogger'
import { createSpillStore } from '../storage/spillStore'
import { queueInputFingerprint } from '../queueInputFingerprint'

const runStoragePerf = process.env.SPACEASSISTANT_RUN_STORAGE_PERF === '1'

describe('Phase 5.2 canonical shadow reads', () => {
  it('keeps canonical API fold, watermark and cache validation in one SQLite snapshot', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'api shadow snapshot', model: 'test' })
    const user = appendMessage(db, { id: 'api-snapshot-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'api-snapshot-invocation', turnId: 'api-snapshot-turn', sequence: 1, schemaVersion: 1,
      eventId: 'api-snapshot-context', idempotencyKey: 'api-snapshot-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    const conn = getDbConnection(db)
    let diagnosticObservedSnapshot = false
    const logSpy = vi.spyOn(agentLogger, 'logAgentEvent').mockImplementation(() => {
      diagnosticObservedSnapshot = conn.isTransaction
    })

    const report = shadowAcceptedTurnContext(db, session.id, getTurnContext(db, session.id, undefined, user.message.id, []))

    expect(report).toMatchObject({ status: 'matched', differenceCount: 0 })
    expect(diagnosticObservedSnapshot).toBe(true)
    logSpy.mockRestore()
    db.close()
  })

  it('keeps Phase 5.2 mirrors shadow-only and preserves session, queue and FK invariants', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: '5.2 invariant audit', model: 'test' })
    const accepted = appendMessage(db, { id: '5-2-invariant-user', sessionId: session.id, role: 'user', content: 'legacy accepted', timestamp: 1, status: 'sent' })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: '5-2-invariant-queued', content: 'queued remains queued' })
    const before = getSession(db, session.id)!
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)

    await history.appendBatch([{
      invocationId: '5-2-invariant-invocation', turnId: '5-2-invariant-turn', sequence: 1, schemaVersion: 1,
      eventId: '5-2-invariant-context', idempotencyKey: '5-2-invariant-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: accepted.message.id, role: 'user', content: 'canonical accepted', timestamp: 1 }],
        requiredUserMessage: { id: accepted.message.id, message: { role: 'user', content: 'canonical accepted' } } }
    }], 0)

    const legacy = getTurnContext(db, session.id, undefined, accepted.message.id, [])
    const report = shadowAcceptedTurnContext(db, session.id, legacy)
    const after = getSession(db, session.id)!
    expect(report).toMatchObject({ status: 'matched', differenceCount: 0, fields: [] })
    expect(getMessage(db, accepted.message.id)?.content).toBe('canonical accepted')
    expect(after.messageCount).toBe(before.messageCount)
    expect(after.preview).toBe(before.preview)
    expect(getMessage(db, queued.persisted.message.id)?.status).toBe('queued')
    expect(conn.prepare('SELECT queued_message_id,state FROM queue_input_requests WHERE session_id=?').get(session.id))
      .toEqual({ queued_message_id: queued.persisted.message.id, state: 'queued' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare("SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?").get(session.id))
      .toEqual({ api_read_mode: 'legacy' })
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('keeps the canonical transcript and routing skeleton comparison in one SQLite snapshot', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'route shadow snapshot', model: 'test' })
    const user = appendMessage(db, { id: 'route-snapshot-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'route-snapshot-invocation', turnId: 'route-snapshot-turn', sequence: 1, schemaVersion: 1,
      eventId: 'route-snapshot-context', idempotencyKey: 'route-snapshot-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    const conn = getDbConnection(db)
    let diagnosticObservedSnapshot = false
    const logSpy = vi.spyOn(agentLogger, 'logAgentEvent').mockImplementation(() => {
      diagnosticObservedSnapshot = conn.isTransaction
    })

    const report = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'create-user',
      routeInput: { userInput: 'current prompt', recentMessages: getRecentTurnRoutingMessages(db, session.id), sessionId: session.id },
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })

    expect(report).toMatchObject({ status: 'matched', differenceCount: 0 })
    expect(diagnosticObservedSnapshot).toBe(true)
    logSpy.mockRestore()
    db.close()
  })

  it('reports every changed enumerable field even when it was not in the old comparison list', () => {
    const legacy = [{ id: 'message-1', activity: [{ kind: 'tool', toolCallId: 'legacy' }] }]
    const candidate = [{ id: 'message-1', activity: [{ kind: 'tool', toolCallId: 'canonical' }] }]

    expect(fieldDifferences(legacy, candidate)).toEqual(['activity'])
  })

  it('never reports matched when array items differ but expose no enumerable fields', () => {
    expect(fieldDifferences(['legacy'], ['canonical'])).toEqual(['[0]'])
    expect(fieldDifferences([,], [undefined])).toEqual(['[0]'])
    expect(fieldDifferences([new Date(1)], [new Date(2)])).toEqual(['[0]'])
    const symbolField = Symbol('runtime-field')
    expect(fieldDifferences({ [symbolField]: 'legacy' }, { [symbolField]: 'canonical' })).toEqual(['$value'])
  })

  it('compares accepted API context by stable ID and retains the complete legacy result', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'api shadow', model: 'test' })
    appendMessage(db, {
      id: 'api-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent',
      attachments: [{ id: 'api-image', stagingKey: 'chat-attachments/api/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 4 }]
    })
    const assistant = appendMessage(db, { id: 'api-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'api-shadow-invocation', turnId: 'api-shadow-turn', sequence: 1, schemaVersion: 1,
      eventId: 'api-shadow-context', idempotencyKey: 'api-shadow-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'api-user', role: 'user', content: 'question', timestamp: 1 },
        { id: 'api-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
      ] }
    }], 0)
    const legacy = getTurnContext(db, session.id, assistant.sequence, 'api-user', [])
    const acceptedInputFingerprint = queueInputFingerprint({ text: 'question', attachments: legacy.find(({ id }) => id === 'api-user')?.attachments })
    const logSpy = vi.spyOn(agentLogger, 'logAgentEvent')

    const report = shadowAcceptedTurnContext(db, session.id, legacy, { messageId: 'api-user', fingerprint: acceptedInputFingerprint })

    expect(report).toMatchObject({ consumer: 'api-context', status: 'matched', source: 'canonical:L2', differenceCount: 0, acceptedInputFingerprint: 'matched' })
    expect(report.fields).not.toContain('accepted-input-fingerprint')
    expect(report.candidate).toEqual(legacy)
    expect(report.legacyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.canonicalHash).toBe(report.legacyHash)
    expect(logSpy).toHaveBeenCalledWith('info', 'session.storage.shadow', expect.objectContaining({ acceptedInputFingerprint: 'matched' }))
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(acceptedInputFingerprint)
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])

    getDbConnection(db).prepare("UPDATE canonical_session_projection_cache SET value='not-json' WHERE session_id=? AND cache_key='transcript'").run(session.id)
    const noCache = shadowAcceptedTurnContext(db, session.id, legacy)
    expect(noCache).toMatchObject({ status: 'matched', differenceCount: 0, source: 'canonical:L2' })
    expect(noCache.candidate).toEqual(legacy)
    expect(noCache.legacyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(noCache.canonicalHash).toBe(noCache.legacyHash)
    expect(getDbConnection(db).prepare("SELECT value FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toEqual({ value: 'not-json' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    const safeLog = projectAgentLogFields('session.storage.shadow', {
      sessionId: session.id, consumer: 'api-context', status: noCache.status, differenceCount: noCache.differenceCount,
      fieldNames: noCache.fields, legacyHash: noCache.legacyHash, canonicalHash: noCache.canonicalHash,
      content: 'canonical-side mismatch secret'
    })
    expect(JSON.stringify(safeLog)).not.toContain('canonical-side mismatch secret')
    getDbConnection(db).prepare("UPDATE agent_history_events SET payload_json=replace(payload_json, 'question', 'canonical changed') WHERE event_id='api-shadow-context'").run()
    const differingCanonical = shadowAcceptedTurnContext(db, session.id, legacy, { messageId: 'api-user', fingerprint: acceptedInputFingerprint })
    expect(differingCanonical).toMatchObject({ status: 'mismatched', differenceCount: 2, fields: ['content', 'accepted-input-fingerprint'], acceptedInputFingerprint: 'mismatched' })
    expect(differingCanonical.candidate?.[0]).toMatchObject({ id: 'api-user', content: 'canonical changed' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    db.close()
    logSpy.mockRestore()
  })

  it('keeps UI bodies legacy after a provider compaction snapshot and reports the candidate mismatch', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'compacted provider context', model: 'test' })
    const user = appendMessage(db, { id: 'compaction-stable-user', sessionId: session.id, role: 'user', content: 'full UI body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      {
        invocationId: 'compaction-shadow-invocation', turnId: 'compaction-shadow-turn', sequence: 1, schemaVersion: 1,
        eventId: 'compaction-shadow-context', idempotencyKey: 'compaction-shadow-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: user.message.id, role: 'user', content: 'full UI body', timestamp: 1 }] }
      },
      {
        invocationId: 'compaction-shadow-invocation', turnId: 'compaction-shadow-turn', sequence: 2, schemaVersion: 1,
        eventId: 'compaction-shadow-snapshot', idempotencyKey: 'compaction-shadow-snapshot', kind: 'transcript-compacted',
        payload: { messages: [{ id: user.message.id, role: 'user', content: 'provider summary', timestamp: 1 }] }
      }
    ], 0)

    const legacy = getTurnContext(db, session.id, undefined, user.message.id, [])
    const candidate = readCanonicalTurnContextCandidate(db, session.id, undefined, user.message.id, [])
    const shadow = shadowAcceptedTurnContext(db, session.id, legacy)

    expect(getMessage(db, user.message.id)?.content).toBe('full UI body')
    expect(candidate).toMatchObject({ status: 'available', messages: [{ id: user.message.id, content: 'provider summary' }] })
    expect(shadow).toMatchObject({ status: 'mismatched', differenceCount: 1, fields: ['content'] })
    expect(shadow.candidate).toEqual([{ ...legacy[0], content: 'provider summary' }])
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').all(session.id)).toEqual([])
    expect(getDbConnection(db).prepare("SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?").get(session.id))
      .toEqual({ api_read_mode: 'legacy' })
    db.close()
  })

  it('does not reuse an API shadow L1 seed after a watermark-only compaction append', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'shadow stale API cache', model: 'test' })
    const user = appendMessage(db, { id: 'shadow-stale-cache-user', sessionId: session.id, role: 'user', content: 'full UI body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'shadow-stale-cache-invocation', turnId: 'shadow-stale-cache-turn', sequence: 1, schemaVersion: 1,
      eventId: 'shadow-stale-cache-context', idempotencyKey: 'shadow-stale-cache-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'full UI body', timestamp: 1 }] }
    }], 0)
    const firstWatermark = history.readCanonicalSessionTranscriptForShadow(session.id)
    expect(firstWatermark.kind).toBe('matched')
    if (firstWatermark.kind !== 'matched') throw new Error('expected initial canonical transcript')
    expect(history.writeCanonicalSessionCache({ ...firstWatermark, cacheKey: 'transcript', value: JSON.stringify(firstWatermark.messages) })).toBe(true)
    const legacy = getTurnContext(db, session.id, undefined, user.message.id, [])
    expect(shadowAcceptedTurnContext(db, session.id, legacy)).toMatchObject({ status: 'matched', source: 'canonical:L1' })

    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,1)`)
      .run(session.id, firstWatermark.sessionGeneration, 0, firstWatermark.sessionSeq, firstWatermark.commitOrder,
        firstWatermark.watermarkEventId, firstWatermark.watermarkInvocationId, 1)
    const skeletonRevision = (conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(session.id) as
      { message_revision: number }).message_revision

    await history.appendBatch([{
      invocationId: 'shadow-stale-cache-invocation', turnId: 'shadow-stale-cache-turn', sequence: 2, schemaVersion: 1,
      eventId: 'shadow-stale-cache-compaction', idempotencyKey: 'shadow-stale-cache-compaction', kind: 'transcript-compacted',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'provider summary', timestamp: 1 }] }
    }], 1)

    const afterAppend = history.readCanonicalSessionTranscriptForShadow(session.id)
    expect(afterAppend.kind).toBe('matched')
    if (afterAppend.kind !== 'matched') throw new Error('expected compacted canonical transcript')
    expect(conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ message_revision: skeletonRevision })
    expect(history.readCanonicalSessionCache({ ...afterAppend, cacheKey: 'transcript' })).toMatchObject({ kind: 'miss' })
    const report = shadowAcceptedTurnContext(db, session.id, legacy)
    expect(report).toMatchObject({ status: 'mismatched', source: 'canonical:L2', fields: ['content'], candidate: [{ content: 'provider summary' }] })
    expect(getMessage(db, user.message.id)?.content).toBe('full UI body')
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
    db.close()
  })

  it('revalidates a persisted API L1 watermark after DB reopen before accepting a later compaction', async () => {
    const temp = createTempDatabase('session-shadow-reopen-watermark-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'reopen watermark fence', model: 'test' })
      const user = appendMessage(temp.db, { id: 'reopen-watermark-user', sessionId: session.id, role: 'user', content: 'full UI body', timestamp: 1, status: 'sent' })
      const conn = getDbConnection(temp.db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'reopen-watermark-invocation', turnId: 'reopen-watermark-turn', sequence: 1, schemaVersion: 1,
        eventId: 'reopen-watermark-context', idempotencyKey: 'reopen-watermark-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: user.message.id, role: 'user', content: 'full UI body', timestamp: 1 }] }
      }], 0)
      const beforeClose = history.readCanonicalSessionTranscriptForShadow(session.id)
      expect(beforeClose.kind).toBe('matched')
      if (beforeClose.kind !== 'matched') throw new Error('expected initial canonical transcript')
      expect(history.writeCanonicalSessionCache({ ...beforeClose, cacheKey: 'transcript', value: JSON.stringify(beforeClose.messages) })).toBe(true)
      conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
        canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,1)`)
        .run(session.id, beforeClose.sessionGeneration, 0, beforeClose.sessionSeq, beforeClose.commitOrder,
          beforeClose.watermarkEventId, beforeClose.watermarkInvocationId, 1)
      const legacyBeforeClose = getTurnContext(temp.db, session.id, undefined, user.message.id, [])
      expect(shadowAcceptedTurnContext(temp.db, session.id, legacyBeforeClose)).toMatchObject({ status: 'matched', source: 'canonical:L1' })
      temp.db.close()

      reopened = openDatabase(temp.dbPath)
      const reopenedConn = getDbConnection(reopened)
      const reopenedHistory = new SqliteAgentHistory(reopenedConn, 1, Date.now, session.id)
      const beforeAppend = reopenedHistory.readCanonicalSessionTranscriptForShadow(session.id)
      expect(beforeAppend.kind).toBe('matched')
      if (beforeAppend.kind !== 'matched') throw new Error('expected reopened canonical transcript')
      expect(reopenedHistory.readCanonicalSessionCache({ ...beforeAppend, cacheKey: 'transcript' })).toMatchObject({ kind: 'hit' })
      const legacyAfterReopen = getTurnContext(reopened, session.id, undefined, user.message.id, [])
      expect(shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)).toMatchObject({ status: 'matched', source: 'canonical:L1' })

      await reopenedHistory.appendBatch([{
        invocationId: 'reopen-watermark-invocation', turnId: 'reopen-watermark-turn', sequence: 2, schemaVersion: 1,
        eventId: 'reopen-watermark-compaction', idempotencyKey: 'reopen-watermark-compaction', kind: 'transcript-compacted',
        payload: { messages: [{ id: user.message.id, role: 'user', content: 'provider summary', timestamp: 1 }] }
      }], 1)

      const afterAppend = reopenedHistory.readCanonicalSessionTranscriptForShadow(session.id)
      expect(afterAppend.kind).toBe('matched')
      if (afterAppend.kind !== 'matched') throw new Error('expected compacted canonical transcript')
      expect(reopenedHistory.readCanonicalSessionCache({ ...afterAppend, cacheKey: 'transcript' })).toMatchObject({ kind: 'miss' })
      const report = shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)
      expect(report).toMatchObject({ status: 'mismatched', source: 'canonical:L2', fields: ['content'], candidate: [{ content: 'provider summary' }] })
      expect(getMessage(reopened, user.message.id)?.content).toBe('full UI body')
      expect(reopenedConn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
      expect(reopenedConn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ api_read_mode: 'revalidation-required' })
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it('selected API context shadow match does not certify the session when an excluded legacy row lacks canonical identity', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'scoped API shadow match', model: 'test' })
    const excluded = appendMessage(db, { id: 'scoped-unmapped-legacy-user', sessionId: session.id, role: 'user', content: 'older legacy body', timestamp: 1, status: 'sent' })
    const required = appendMessage(db, { id: 'scoped-mapped-user', sessionId: session.id, role: 'user', content: 'current body', timestamp: 2, status: 'sent' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'scoped-api-shadow-invocation', turnId: 'scoped-api-shadow-turn', sequence: 1, schemaVersion: 1,
      eventId: 'scoped-api-shadow-context', idempotencyKey: 'scoped-api-shadow-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: required.message.id, role: 'user', content: 'current body', timestamp: 2 }] }
    }], 0)

    const selectedLegacyContext = getTurnContext(db, session.id, required.sequence, required.message.id, [excluded.message.id])
    const report = shadowAcceptedTurnContext(db, session.id, selectedLegacyContext)

    expect(selectedLegacyContext.map(({ id }) => id)).toEqual([required.message.id])
    expect(report).toMatchObject({ status: 'matched', differenceCount: 0, candidate: selectedLegacyContext })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'legacy' })
    db.close()
  })

  it('preserves the UI body and reports compacted context mismatch across a database reopen', async () => {
    const temp = createTempDatabase('session-shadow-compaction-reopen-')
    try {
      const session = createSession(temp.db, { name: 'compaction reopen', model: 'test' })
      const user = appendMessage(temp.db, { id: 'compaction-reopen-user', sessionId: session.id, role: 'user', content: 'full UI body', timestamp: 1, status: 'sent' })
      await new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id).appendBatch([{
        invocationId: 'compaction-reopen-invocation', turnId: 'compaction-reopen-turn', sequence: 1, schemaVersion: 1,
        eventId: 'compaction-reopen-context', idempotencyKey: 'compaction-reopen-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: user.message.id, role: 'user', content: 'full UI body', timestamp: 1 }] }
      }], 0)
      temp.db.close()

      const reopened = openDatabase(temp.dbPath)
      try {
        await new SqliteAgentHistory(getDbConnection(reopened), 1, Date.now, session.id).appendBatch([{
          invocationId: 'compaction-reopen-invocation', turnId: 'compaction-reopen-turn', sequence: 2, schemaVersion: 1,
          eventId: 'compaction-reopen-snapshot', idempotencyKey: 'compaction-reopen-snapshot', kind: 'transcript-compacted',
          payload: { messages: [{ id: user.message.id, role: 'user', content: 'provider summary', timestamp: 1 }] }
        }], 1)

        const legacy = getTurnContext(reopened, session.id, undefined, user.message.id, [])
        const candidate = readCanonicalTurnContextCandidate(reopened, session.id, undefined, user.message.id, [])
        const shadow = shadowAcceptedTurnContext(reopened, session.id, legacy)
        const conn = getDbConnection(reopened)
        expect(getMessage(reopened, user.message.id)?.content).toBe('full UI body')
        expect(candidate).toMatchObject({ status: 'available', messages: [{ id: user.message.id, content: 'provider summary' }] })
        expect(shadow).toMatchObject({ status: 'mismatched', differenceCount: 1, fields: ['content'] })
        expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').all(session.id)).toEqual([])
        expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
          .toEqual({ api_read_mode: 'legacy' })
      } finally {
        reopened.close()
      }
    } finally {
      temp.cleanup()
    }
  })

  it('canonical API candidate preserves skeleton selection, required-user errors and all Message fields', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical API candidate', model: 'test' })
    appendMessage(db, { id: 'candidate-sequence-hole', sessionId: session.id, role: 'user', content: 'deleted', timestamp: 1, status: 'sent' })
    const oldUser = appendMessage(db, { id: 'candidate-old-user', sessionId: session.id, role: 'user', content: 'old', timestamp: 20, status: 'sent', attachments: [{ id: 'old-attachment', fileName: 'old.png' }] })
    const assistant = appendMessage(db, { id: 'candidate-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 10, status: 'completed' })
    const required = appendMessage(db, { id: 'candidate-required-user', sessionId: session.id, role: 'user', content: 'accepted', timestamp: 5, status: 'sent',
      attachments: [{ id: 'accepted-attachment', fileName: 'accepted.png', mimeType: 'image/png', byteLength: 10 }],
      skillHints: [{ id: 'hint', shownAt: 3, name: 'skill' }] })
    const pendingAssistant = appendMessage(db, { id: 'candidate-pending-assistant', sessionId: session.id, role: 'assistant', content: 'not terminal', timestamp: 30, status: 'completed' })
    const excludedUser = appendMessage(db, { id: 'candidate-excluded-user', sessionId: session.id, role: 'user', content: 'exclude', timestamp: 40, status: 'sent' })
    getDbConnection(db).prepare('DELETE FROM messages WHERE id=?').run('candidate-sequence-hole')
    createPersistedTurn(db, { turnId: 'candidate-terminal-turn', requestId: 'candidate-terminal-request', sessionId: session.id,
      userMessageId: required.message.id, assistantMessageId: assistant.message.id, state: 'terminal', outcome: 'completed' })
    createPersistedTurn(db, { turnId: 'candidate-open-turn', requestId: 'candidate-open-request', sessionId: session.id,
      userMessageId: oldUser.message.id, assistantMessageId: pendingAssistant.message.id, state: 'executing' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'canonical-api-candidate-invocation', turnId: 'canonical-api-candidate-turn', sequence: 1, schemaVersion: 1,
      eventId: 'canonical-api-candidate-context', idempotencyKey: 'canonical-api-candidate-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: oldUser.message.id, role: 'user', content: 'old', timestamp: 20 },
        { id: assistant.message.id, role: 'assistant', content: 'canonical answer', timestamp: 10 },
        { id: required.message.id, role: 'user', content: 'canonical accepted', timestamp: 5 },
        { id: pendingAssistant.message.id, role: 'assistant', content: 'not terminal', timestamp: 30 },
        { id: excludedUser.message.id, role: 'user', content: 'exclude', timestamp: 40 }
      ] }
    }], 0)

    const legacy = getTurnContext(db, session.id, oldUser.sequence, required.message.id, [excludedUser.message.id])
    const candidate = readCanonicalTurnContextCandidate(db, session.id, oldUser.sequence, required.message.id, [excludedUser.message.id])
    expect(candidate).toMatchObject({ status: 'available', messages: expect.any(Array) })
    expect(candidate.messages?.map(({ id, content, timestamp }) => ({ id, content, timestamp }))).toEqual([
      { id: required.message.id, content: 'canonical accepted', timestamp: 5 },
      { id: oldUser.message.id, content: 'old', timestamp: 20 }
    ])
    expect(queueInputFingerprint({ text: candidate.messages?.[0]?.content ?? '', attachments: candidate.messages?.[0]?.attachments }))
      .toBe(queueInputFingerprint({ text: 'canonical accepted', attachments: required.message.attachments }))
    expect(candidate.messages?.map((message) => message.id)).toEqual([required.message.id, oldUser.message.id])
    for (const input of [
      { requiredUserMessageId: required.message.id, excludeMessageIds: [required.message.id], expected: 'TURN_REQUIRED_USER_EXCLUDED' },
      { requiredUserMessageId: 'missing-required-user', excludeMessageIds: [], expected: 'TURN_REQUIRED_USER_INVALID' }
    ] as const) {
      let legacyErrorCode: string | undefined
      try {
        getTurnContext(db, session.id, undefined, input.requiredUserMessageId, [...input.excludeMessageIds])
      } catch (error) {
        legacyErrorCode = error instanceof Error ? error.message : String(error)
      }
      const unavailable = readCanonicalTurnContextCandidate(db, session.id, undefined, input.requiredUserMessageId, [...input.excludeMessageIds])
      expect(legacyErrorCode).toBe(input.expected)
      expect(unavailable).toMatchObject({ status: 'unavailable', errorCode: input.expected })
      expect(unavailable.errorCode).toBe(legacyErrorCode)
    }
    db.close()
  })

  it('compares the complete persisted Message metadata matrix on the canonical API candidate', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical API full metadata matrix', model: 'test' })
    const metadata = {
      attachments: [{ id: 'matrix-attachment', stagingKey: 'chat-attachments/matrix/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 12 }],
      imagesDeliveredToApi: true,
      toolUse: { id: 'matrix-tool-use', toolName: 'legacy-tool', toolType: 'test', parameters: { query: 1 }, result: { data: 'result', success: true }, status: 'completed' as const, timestamp: 3 },
      toolCalls: [{ id: 'matrix-tool-call', toolName: 'search', input: { query: 'x' }, result: { data: { ok: true }, success: true }, status: 'completed' as const, riskLevel: 'low' as const }],
      thinking: { content: 'private reasoning', isVisible: true, startTime: 3, segments: [{ content: 'private reasoning', startTime: 3, endTime: 4 }] },
      contentSegments: [{ content: 'visible segment', startTime: 4 }],
      skillHints: [{ id: 'matrix-skill', text: 'skill hint', shownAt: 5 }]
    }
    const user = appendMessage(db, { id: 'matrix-user', sessionId: session.id, role: 'user', content: 'accepted', timestamp: 1, status: 'sent', ...metadata })
    const assistant = appendMessage(db, { id: 'matrix-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed',
      thinking: { content: '', isVisible: false, startTime: 0 }, toolCalls: [], contentSegments: [], skillHints: [], attachments: [], imagesDeliveredToApi: false })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'matrix-invocation', turnId: 'matrix-turn', sequence: 1, schemaVersion: 1,
      eventId: 'matrix-context', idempotencyKey: 'matrix-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: user.message.id, role: 'user', content: 'accepted', timestamp: 1 },
        { id: assistant.message.id, role: 'assistant', content: 'answer', timestamp: 2 }
      ] }
    }], 0)
    const legacy = getTurnContext(db, session.id, assistant.sequence, user.message.id, [])
    const candidate = readCanonicalTurnContextCandidate(db, session.id, assistant.sequence, user.message.id, [])
    const shadow = shadowAcceptedTurnContext(db, session.id, legacy)

    expect(candidate).toMatchObject({ status: 'available', messages: expect.any(Array) })
    expect(candidate.messages).toEqual(legacy)
    expect(shadow).toMatchObject({ status: 'matched', differenceCount: 0, fields: [] })
    expect(shadow.candidate).toEqual(legacy)
    expect(legacy[0]).toMatchObject(metadata)
    expect(legacy[1]).toMatchObject({ imagesDeliveredToApi: false, thinking: { content: '', isVisible: false, startTime: 0 } })
    expect(legacy[1]?.attachments).toBeUndefined()
    expect(legacy[1]?.toolCalls).toBeUndefined()
    expect(legacy[1]?.contentSegments).toBeUndefined()
    expect(legacy[1]?.skillHints).toBeUndefined()
    db.close()
  })

  it('keeps canonical API reads exact when source spill preparation falls back to inline content', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'inline canonical API fallback', model: 'test' })
    const user = appendMessage(db, { id: 'inline-canonical-api-user', sessionId: session.id, role: 'user', content: 'old body',
      timestamp: 10, status: 'sent', attachments: [{ id: 'inline-canonical-api-image', fileName: 'image.png', mimeType: 'image/png' }] })
    const body = 'large canonical body '.repeat(4000)
    const spillStore = { commitSourceTruthUnderFence: vi.fn(async () => { throw new Error('injected spill preparation failure') }) } as never
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id, spillStore)
    await history.appendBatch([{
      invocationId: 'inline-canonical-api-invocation', turnId: 'inline-canonical-api-turn', sequence: 1, schemaVersion: 1,
      eventId: 'inline-canonical-api-context', idempotencyKey: 'inline-canonical-api-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: body, timestamp: 10 }],
        requiredUserMessage: { id: user.message.id, message: { role: 'user', content: body } } }
    }], 0)

    const legacy = getTurnContext(db, session.id, undefined, user.message.id, [])
    const candidate = readCanonicalTurnContextCandidate(db, session.id, undefined, user.message.id, [])
    expect(candidate.status).toBe('available')
    expect(candidate.messages).toEqual(legacy)
    expect(candidate.messages?.[0]).toMatchObject({ content: body, attachments: user.message.attachments })
    expect(spillStore.commitSourceTruthUnderFence).toHaveBeenCalledOnce()
    db.close()
  })

  it('compares canonical turn route input independently and selects non-empty canonical bodies before limit', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'route shadow', model: 'test' })
    for (let index = 0; index < 52; index += 1) {
      appendMessage(db, { id: `route-${index}`, sessionId: session.id, role: 'user', content: `route body ${index}`, timestamp: index + 1, status: 'sent' })
    }
    const conn = getDbConnection(db)
    conn.prepare("UPDATE messages SET content='   ' WHERE id IN ('route-50','route-51')").run()
    conn.prepare("UPDATE messages SET content=char(9) WHERE id='route-49'").run()
    const messages = Array.from({ length: 52 }, (_, index) => ({
      id: `route-${index}`, role: 'user', content: index >= 50 ? '   ' : index === 49 ? '\t' : `route body ${index}`, timestamp: index + 1
    }))
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'route-shadow-invocation', turnId: 'route-shadow-turn', sequence: 1, schemaVersion: 1,
      eventId: 'route-shadow-context', idempotencyKey: 'route-shadow-context', kind: 'invocation-context-committed',
      payload: { messages }
    }], 0)
    const legacyRecentMessages = getRecentTurnRoutingMessages(db, session.id)
    const abortController = new AbortController()
    const getApiKey = vi.fn(async () => 'test-secret')
    const routeInput = {
      userInput: 'current input', sessionState: { enabled: ['memory'] }, sessionMetadata: { workspace: 'project-a' },
      recentMessages: legacyRecentMessages, model: 'test-model', baseUrl: 'https://provider.example', getApiKey,
      sessionId: session.id, signal: abortController.signal
    }

    const report = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'create-user', routeInput,
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })

    expect(report).toMatchObject({ consumer: 'turn-routing', status: 'matched', source: 'canonical:L2', differenceCount: 0 })
    expect(report.candidate).toEqual(routeInput)
    expect(report.fields).toEqual([])
    expect(report.candidate?.recentMessages).toEqual(Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: index === 49 ? '\t' : `route body ${index}` })))

    const reusedRouteInput = { ...routeInput, userInput: 'route body 0' }
    const reuseReport = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: 'route-0', routeInput: reusedRouteInput,
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })
    expect(reuseReport).toMatchObject({ consumer: 'turn-routing', status: 'matched', differenceCount: 0 })
    expect(reuseReport.candidate).toEqual(reusedRouteInput)
    const staleLegacyInput = { ...routeInput, recentMessages: legacyRecentMessages.slice(1) }
    const staleReport = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'create-user', routeInput: staleLegacyInput,
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })
    expect(staleReport).toMatchObject({ status: 'mismatched', differenceCount: 1, fields: ['recentMessages'] })
    expect(staleReport.candidate?.recentMessages).toEqual(legacyRecentMessages)
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    db.close()
  })

  it('does not produce a canonical candidate when full-session canonical identity or body disagrees', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'mismatch shadow', model: 'test' })
    appendMessage(db, { id: 'legacy-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'mismatch-shadow-invocation', turnId: 'mismatch-shadow-turn', sequence: 1, schemaVersion: 1,
      eventId: 'mismatch-shadow-context', idempotencyKey: 'mismatch-shadow-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'different-id', role: 'user', content: 'canonical body', timestamp: 1 }] }
    }], 0)

    const report = shadowAcceptedTurnContext(db, session.id, getTurnContext(db, session.id, undefined, undefined, []), {
      messageId: 'legacy-user', fingerprint: queueInputFingerprint({ text: 'legacy body' })
    })

    expect(report).toMatchObject({ consumer: 'api-context', status: 'unavailable', acceptedInputFingerprint: 'unavailable' })
    expect(report.candidate).toBeUndefined()
    expect(report.legacyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.canonicalHash).toBeUndefined()
    db.close()
  })

  it('reports a body mismatch after a legacy message edit and never leaves API eligibility granted', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'edited legacy body shadow', model: 'test' })
    const user = appendMessage(db, { id: 'edited-legacy-user', sessionId: session.id, role: 'user', content: 'before edit', timestamp: 1, status: 'sent' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'edited-legacy-invocation', turnId: 'edited-legacy-turn', sequence: 1, schemaVersion: 1,
      eventId: 'edited-legacy-context', idempotencyKey: 'edited-legacy-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'before edit', timestamp: 1 }] }
    }], 0)
    expect(updateMessageContent(db, user.message.id, { content: 'after edit' })?.message.content).toBe('after edit')

    const freshLegacy = getTurnContext(db, session.id, undefined, user.message.id, [])
    const report = shadowAcceptedTurnContext(db, session.id, freshLegacy, {
      messageId: user.message.id, fingerprint: queueInputFingerprint({ text: 'after edit' })
    })
    expect(report).toMatchObject({ status: 'mismatched', differenceCount: 2,
      fields: ['content', 'accepted-input-fingerprint'], acceptedInputFingerprint: 'mismatched' })
    expect(report.candidate?.[0]?.content).toBe('before edit')
    expect(freshLegacy[0]?.content).toBe('after edit')
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    db.close()
  })

  it('keeps legacy-only sessions unavailable to the canonical shadow reader', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'legacy only', model: 'test' })
    appendMessage(db, { id: 'legacy-only-user', sessionId: session.id, role: 'user', content: 'old body', timestamp: 1, status: 'sent' })
    const report = shadowAcceptedTurnContext(db, session.id, getTurnContext(db, session.id, undefined, undefined, []))
    expect(report).toMatchObject({ status: 'unavailable', source: 'canonical:unavailable' })
    expect(report.candidate).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    db.close()
  })

  it('keeps mixed canonical, legacy, queued, streaming and unsealed failed rows on the unchanged legacy path', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'mixed shadow', model: 'test' })
    appendMessage(db, { id: 'mixed-canonical-user', sessionId: session.id, role: 'user', content: 'canonical user', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'mixed-legacy-user', sessionId: session.id, role: 'user', content: 'legacy user', timestamp: 2, status: 'sent' })
    appendMessage(db, { id: 'mixed-queued-user', sessionId: session.id, role: 'user', content: 'queued user', timestamp: 3, status: 'queued' })
    appendMessage(db, { id: 'mixed-streaming-assistant', sessionId: session.id, role: 'assistant', content: 'partial answer', timestamp: 4, status: 'streaming' })
    const failed = appendMessage(db, { id: 'mixed-failed-assistant', sessionId: session.id, role: 'assistant', content: 'failed answer', timestamp: 5, status: 'failed' })
    getDbConnection(db).prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
      VALUES('mixed-open-turn','mixed-open-request',?,?, 'executing',1,1)`).run(session.id, failed.message.id)
    appendMessage(db, { id: 'mixed-canonical-assistant', sessionId: session.id, role: 'assistant', content: 'sealed answer', timestamp: 6, status: 'completed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'mixed-shadow-invocation', turnId: 'mixed-shadow-turn', sequence: 1, schemaVersion: 1,
      eventId: 'mixed-shadow-context', idempotencyKey: 'mixed-shadow-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'mixed-canonical-user', role: 'user', content: 'canonical user', timestamp: 1 },
        { id: 'mixed-canonical-assistant', role: 'assistant', content: 'sealed answer', timestamp: 6 }
      ] }
    }], 0)

    const beforeApi = getTurnContext(db, session.id, undefined, undefined, [])
    const beforeRoute = getRecentTurnRoutingMessages(db, session.id)
    const apiReport = shadowAcceptedTurnContext(db, session.id, beforeApi)
    const routeReport = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'create-user',
      routeInput: { userInput: 'current prompt', recentMessages: beforeRoute, sessionId: session.id },
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })

    expect(beforeApi.map(({ id }) => id)).toEqual(['mixed-canonical-user', 'mixed-legacy-user', 'mixed-canonical-assistant'])
    expect(beforeRoute).toEqual([
      { role: 'user', content: 'canonical user' },
      { role: 'user', content: 'legacy user' },
      { role: 'assistant', content: 'sealed answer' }
    ])
    expect(apiReport.status).toBe('unavailable')
    expect(apiReport.candidate).toBeUndefined()
    expect(routeReport.status).toBe('unavailable')
    expect(routeReport.candidate).toBeUndefined()
    expect(getTurnContext(db, session.id, undefined, undefined, [])).toEqual(beforeApi)
    expect(getRecentTurnRoutingMessages(db, session.id)).toEqual(beforeRoute)
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(getDbConnection(db).prepare("SELECT id,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence").all(session.id))
      .toEqual([
        { id: 'mixed-canonical-user', content_storage_state: 'legacy' },
        { id: 'mixed-legacy-user', content_storage_state: 'legacy' },
        { id: 'mixed-queued-user', content_storage_state: 'legacy' },
        { id: 'mixed-streaming-assistant', content_storage_state: 'legacy' },
        { id: 'mixed-failed-assistant', content_storage_state: 'legacy' },
        { id: 'mixed-canonical-assistant', content_storage_state: 'legacy' }
      ])
    db.close()
  })

  it('fails closed on missing source spill and cache storage errors without changing the legacy API or route', async () => {
    const temp = createTempDatabase('session-shadow-spill-failure-')
    const { db, dbPath } = temp
    const session = createSession(db, { name: 'spill failure shadow', model: 'test' })
    const body = `large canonical body:${'x'.repeat(70 * 1024)}`
    const user = appendMessage(db, { id: 'spill-shadow-user', sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
    const legacyApi = getTurnContext(db, session.id, undefined, user.message.id, [])
    const legacyRoute = getRecentTurnRoutingMessages(db, session.id)
    const root = path.join(path.dirname(dbPath), 'spill')
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id, createSpillStore(root))
    await history.appendBatch([{
      invocationId: 'spill-shadow-invocation', turnId: 'spill-shadow-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-shadow-context', idempotencyKey: 'spill-shadow-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: body, timestamp: 1 }] }
    }], 0)
    const stored = getDbConnection(db).prepare("SELECT payload_json FROM agent_history_events WHERE event_id='spill-shadow-context'").get() as { payload_json: string }
    const payload = JSON.parse(stored.payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    const spillLocator = path.join(root, payload.messages[0]!.content.__spaceassistant_spill_v1.locator)
    await fs.rm(spillLocator)

    const spillApi = shadowAcceptedTurnContext(db, session.id, legacyApi)
    const spillRoute = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: body, recentMessages: legacyRoute, sessionId: session.id },
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })
    expect(spillApi.status).toBe('unavailable')
    expect(spillApi.candidate).toBeUndefined()
    expect(spillRoute.status).toBe('unavailable')
    expect(spillRoute.candidate).toBeUndefined()
    expect(getTurnContext(db, session.id, undefined, user.message.id, [])).toEqual(legacyApi)
    expect(getRecentTurnRoutingMessages(db, session.id)).toEqual(legacyRoute)

    await fs.writeFile(spillLocator, body)
    await fs.writeFile(spillLocator, `${body.slice(0, -1)}y`)
    const corruptSpillApi = shadowAcceptedTurnContext(db, session.id, legacyApi)
    expect(corruptSpillApi.status).toBe('unavailable')
    expect(corruptSpillApi.candidate).toBeUndefined()
    expect(getTurnContext(db, session.id, undefined, user.message.id, [])).toEqual(legacyApi)
    await fs.writeFile(spillLocator, body)
    getDbConnection(db).exec('DROP TABLE canonical_session_projection_cache')
    const cacheFailureApi = shadowAcceptedTurnContext(db, session.id, legacyApi)
    const cacheFailureRoute = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'create-user',
      routeInput: { userInput: 'new prompt', recentMessages: legacyRoute, sessionId: session.id },
      boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })
    expect(cacheFailureApi.status).toBe('unavailable')
    expect(cacheFailureRoute.status).toBe('unavailable')
    expect(getTurnContext(db, session.id, undefined, user.message.id, [])).toEqual(legacyApi)
    expect(getRecentTurnRoutingMessages(db, session.id)).toEqual(legacyRoute)
    temp.cleanup()
  })

  it.skipIf(!runStoragePerf)('keeps paired warm API shadow p95 within the Phase 2 regression ceiling', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'shadow performance', model: 'test' })
    const canonicalMessages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = []
    let requiredUserId = ''
    let boundarySequence = -1
    for (let index = 0; index < 1200; index += 1) {
      const role = index % 2 === 0 ? 'user' as const : 'assistant' as const
      const message = appendMessage(db, {
        id: `shadow-perf-${index}`, sessionId: session.id, role, content: `perf body ${index}`,
        timestamp: index + 1, status: role === 'user' ? 'sent' : 'completed'
      })
      if (role === 'user') requiredUserId = message.message.id
      boundarySequence = message.sequence
      canonicalMessages.push({ id: message.message.id, role, content: message.message.content, timestamp: message.message.timestamp })
    }
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'shadow-perf-invocation', turnId: 'shadow-perf-turn', sequence: 1, schemaVersion: 1,
      eventId: 'shadow-perf-context', idempotencyKey: 'shadow-perf-context', kind: 'invocation-context-committed',
      payload: { messages: canonicalMessages }
    }], 0)
    const legacyRead = () => getTurnContext(db, session.id, boundarySequence, requiredUserId, [])
    const pairedLegacyMs: number[] = []
    const pairedShadowMs: number[] = []
    for (let sample = 0; sample < 35; sample += 1) {
      const legacyStart = performance.now()
      const legacy = legacyRead()
      const legacyElapsed = performance.now() - legacyStart
      const shadowStart = performance.now()
      const report = shadowAcceptedTurnContext(db, session.id, legacy)
      const shadowElapsed = performance.now() - shadowStart
      expect(report.status).toBe('matched')
      if (sample >= 5) {
        pairedLegacyMs.push(legacyElapsed)
        pairedShadowMs.push(shadowElapsed)
      }
    }
    const p95 = (values: number[]) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!
    const legacyP95 = p95(pairedLegacyMs)
    const shadowP95 = p95(pairedShadowMs)
    process.stdout.write(`shadow-p95 legacy=${legacyP95.toFixed(2)}ms candidate=${shadowP95.toFixed(2)}ms samples=${pairedLegacyMs.length}\n`)
    expect(shadowP95).toBeLessThanOrEqual(legacyP95 * 2 + 5)
    expect(shadowP95).toBeLessThanOrEqual(50)
    db.close()
  })

  it.skipIf(!runStoragePerf)('measures the canonical API selector and ID-body candidate against getTurnContext', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical API candidate performance', model: 'test' })
    const canonicalMessages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = []
    let requiredUserId = ''
    let boundarySequence = -1
    for (let index = 0; index < 1200; index += 1) {
      const role = index % 2 === 0 ? 'user' as const : 'assistant' as const
      const result = appendMessage(db, { id: `canonical-api-perf-${index}`, sessionId: session.id, role, content: `api perf ${index}`,
        timestamp: index + 1, status: role === 'user' ? 'sent' : 'completed' })
      if (role === 'user') requiredUserId = result.message.id
      boundarySequence = result.sequence
      canonicalMessages.push({ id: result.message.id, role, content: result.message.content, timestamp: result.message.timestamp })
    }
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'canonical-api-perf-invocation', turnId: 'canonical-api-perf-turn', sequence: 1, schemaVersion: 1,
      eventId: 'canonical-api-perf-context', idempotencyKey: 'canonical-api-perf-context', kind: 'invocation-context-committed',
      payload: { messages: canonicalMessages }
    }], 0)
    const legacyRead = () => getTurnContext(db, session.id, boundarySequence, requiredUserId, [])
    const canonicalRead = () => readCanonicalTurnContextCandidate(db, session.id, boundarySequence, requiredUserId, [])
    for (let warm = 0; warm < 10; warm += 1) {
      const legacy = legacyRead()
      const candidate = canonicalRead()
      expect(candidate.status).toBe('available')
      expect(candidate.messages).toEqual(legacy)
    }
    const legacyMs: number[] = []
    const canonicalMs: number[] = []
    for (let sample = 0; sample < 30; sample += 1) {
      const legacyStart = performance.now()
      const legacy = legacyRead()
      legacyMs.push(performance.now() - legacyStart)
      const candidateStart = performance.now()
      const candidate = canonicalRead()
      canonicalMs.push(performance.now() - candidateStart)
      expect(candidate.status).toBe('available')
      expect(candidate.messages).toEqual(legacy)
    }
    const p95 = (values: number[]) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!
    const legacyP95 = p95(legacyMs)
    const canonicalP95 = p95(canonicalMs)
    process.stdout.write(`canonical-api-p95 legacy=${legacyP95.toFixed(2)}ms candidate=${canonicalP95.toFixed(2)}ms samples=${legacyMs.length}\n`)
    expect(canonicalP95).toBeLessThanOrEqual(legacyP95 * 2 + 5)
    expect(canonicalP95).toBeLessThanOrEqual(50)
    db.close()
  })

  it('hydrates source spill after database reopen and cache clear, then uses a rebuilt canonical L1 seed', async () => {
    const temp = createTempDatabase('session-shadow-cache-reopen-')
    const { db, dbPath } = temp
    const session = createSession(db, { name: 'cache reopen shadow', model: 'test' })
    const largeBody = `spill-backed canonical body:${'z'.repeat(70 * 1024)}`
    const user = appendMessage(db, { id: 'cache-reopen-user', sessionId: session.id, role: 'user', content: largeBody, timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'cache-reopen-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    const spillRoot = path.join(path.dirname(dbPath), 'spill')
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id, createSpillStore(spillRoot))
    await history.appendBatch([{
      invocationId: 'cache-reopen-invocation', turnId: 'cache-reopen-turn', sequence: 1, schemaVersion: 1,
      eventId: 'cache-reopen-context', idempotencyKey: 'cache-reopen-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: user.message.id, role: 'user', content: largeBody, timestamp: 1 },
        { id: 'cache-reopen-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
      ] }
    }], 0)
    const legacyBeforeClose = getTurnContext(db, session.id, undefined, user.message.id, [])
    const legacyRouteBeforeClose = getRecentTurnRoutingMessages(db, session.id)
    const expectedTranscript = [
      { id: 'cache-reopen-user', role: 'user' as const, content: largeBody, timestamp: 1 },
      { id: 'cache-reopen-assistant', role: 'assistant' as const, content: 'answer', timestamp: 2 }
    ]
    const originalRead = history.readCanonicalSessionTranscript(session.id, expectedTranscript)
    expect(originalRead.kind).toBe('matched')
    if (originalRead.kind !== 'matched') throw new Error('expected canonical L2 snapshot')
    expect(history.readCanonicalSessionTranscriptWithCache(session.id, 'transcript', expectedTranscript)).toMatchObject({ kind: 'matched', source: 'L1' })
    const firstReport = shadowAcceptedTurnContext(db, session.id, legacyBeforeClose)
    expect(firstReport).toMatchObject({ status: 'matched', source: 'canonical:L1', differenceCount: 0 })
    const firstRouteReport = shadowTurnRoutingInput(db, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: largeBody, recentMessages: legacyRouteBeforeClose, sessionId: session.id },
      excludeMessageIds: [], limit: 50
    })
    expect(firstRouteReport).toMatchObject({ status: 'matched', source: 'canonical:L1', differenceCount: 0 })
    db.close()

    const reopened = openDatabase(dbPath)
    const legacyAfterReopen = getTurnContext(reopened, session.id, undefined, user.message.id, [])
    const legacyRouteAfterReopen = getRecentTurnRoutingMessages(reopened, session.id)
    expect(legacyAfterReopen[0]?.content).toBe(largeBody)
    const reopenedReport = shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)
    expect(reopenedReport).toMatchObject({ status: 'matched', source: 'canonical:L1', differenceCount: 0 })
    expect(reopenedReport.candidate).toEqual(legacyBeforeClose)
    const reopenedRouteReport = shadowTurnRoutingInput(reopened, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: largeBody, recentMessages: legacyRouteAfterReopen, sessionId: session.id },
      excludeMessageIds: [], limit: 50
    })
    expect(reopenedRouteReport).toMatchObject({ status: 'matched', source: 'canonical:L1', differenceCount: 0 })
    expect(reopenedRouteReport.candidate?.recentMessages).toEqual(legacyRouteBeforeClose)
    const stored = getDbConnection(reopened).prepare("SELECT payload_json FROM agent_history_events WHERE event_id='cache-reopen-context'").get() as { payload_json: string }
    const payload = JSON.parse(stored.payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    const spillFile = path.join(spillRoot, payload.messages[0]!.content.__spaceassistant_spill_v1.locator)
    await fs.writeFile(spillFile, `${largeBody.slice(0, -1)}y`)
    const tamperedAfterReopen = shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)
    expect(tamperedAfterReopen).toMatchObject({ status: 'unavailable', source: 'canonical:unavailable' })
    expect(tamperedAfterReopen.candidate).toBeUndefined()
    const tamperedRouteAfterReopen = shadowTurnRoutingInput(reopened, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: largeBody, recentMessages: legacyRouteAfterReopen, sessionId: session.id },
      excludeMessageIds: [], limit: 50
    })
    expect(tamperedRouteAfterReopen).toMatchObject({ status: 'unavailable', source: 'canonical:unavailable' })
    expect(tamperedRouteAfterReopen.candidate).toBeUndefined()
    await fs.writeFile(spillFile, largeBody)
    getDbConnection(reopened).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    const afterCacheClear = shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)
    expect(afterCacheClear).toMatchObject({ status: 'matched', source: 'canonical:L2', differenceCount: 0 })
    expect(afterCacheClear.candidate).toEqual(legacyBeforeClose)
    const routeAfterCacheClear = shadowTurnRoutingInput(reopened, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: largeBody, recentMessages: legacyRouteAfterReopen, sessionId: session.id },
      excludeMessageIds: [], limit: 50
    })
    expect(routeAfterCacheClear).toMatchObject({ status: 'matched', source: 'canonical:L2', differenceCount: 0 })
    const rebuilt = new SqliteAgentHistory(getDbConnection(reopened), 1, Date.now, session.id)
      .readCanonicalSessionTranscriptWithCache(session.id, 'transcript', expectedTranscript)
    expect(rebuilt).toMatchObject({ kind: 'matched', source: 'L2' })
    const afterRebuild = shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)
    expect(afterRebuild).toMatchObject({ status: 'matched', source: 'canonical:L1', differenceCount: 0 })
    expect(afterRebuild.candidate).toEqual(legacyBeforeClose)
    const routeAfterRebuild = shadowTurnRoutingInput(reopened, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: largeBody, recentMessages: legacyRouteAfterReopen, sessionId: session.id },
      excludeMessageIds: [], limit: 50
    })
    expect(routeAfterRebuild).toMatchObject({ status: 'matched', source: 'canonical:L1', differenceCount: 0 })
    expect(routeAfterRebuild.candidate?.recentMessages).toEqual(legacyRouteBeforeClose)
    await fs.writeFile(spillFile, `${largeBody.slice(0, -1)}x`)
    const tamperedRebuiltCache = shadowAcceptedTurnContext(reopened, session.id, legacyAfterReopen)
    expect(tamperedRebuiltCache).toMatchObject({ status: 'unavailable', source: 'canonical:unavailable' })
    expect(tamperedRebuiltCache.candidate).toBeUndefined()
    const tamperedRebuiltRoute = shadowTurnRoutingInput(reopened, {
      sessionId: session.id, mode: 'reuse-user', reuseUserMessageId: user.message.id,
      routeInput: { userInput: largeBody, recentMessages: legacyRouteAfterReopen, sessionId: session.id },
      excludeMessageIds: [], limit: 50
    })
    expect(tamperedRebuiltRoute).toMatchObject({ status: 'unavailable', source: 'canonical:unavailable' })
    expect(tamperedRebuiltRoute.candidate).toBeUndefined()
    temp.cleanup()
  })
})
