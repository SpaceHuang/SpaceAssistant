import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendMessage, createSession, deleteSession, getRecentTurnRoutingMessages, getSession, getTurnContext } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runSourceTruthSpillGcMaintenance } from '../storage/spillStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { certifyCanonicalSessionApiRead, isCanonicalApiReadFenceCurrent, readCanonicalApiContextIfEligible,
  beginSessionMessageContentCleanup, clearNextSessionMessageContentBatch, markSessionMessageContentWriteStopped,
  verifyAndCompleteSessionMessageContentCleanup, readCanonicalTurnRoutingInputIfEligible,
  readCanonicalTurnRoutingInputWithFenceIfEligible, setCanonicalApiReadFeatureEnabled } from './sessionStorageCutover'

async function writeCanonicalMessages(db: ReturnType<typeof createMemoryAppDb>, sessionId: string,
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>): Promise<void> {
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).appendBatch([{
    invocationId: `cutover-${sessionId}`, turnId: `turn-${sessionId}`, sequence: 1, schemaVersion: 1,
    eventId: `context-${sessionId}`, idempotencyKey: `context-${sessionId}`, kind: 'invocation-context-committed',
    payload: { messages }
  }], 0)
}

describe('Phase 5.3 per-session canonical API read cutover', () => {
  it('atomically grants a full-session API and routing fence only after both shadows match', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'eligible cutover', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    appendMessage(db, { id: 'cutover-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'cutover-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    const expectedApi = getTurnContext(db, session.id, undefined, undefined, [])
    const expectedRoute = getRecentTurnRoutingMessages(db, session.id, Number.MAX_SAFE_INTEGER)
    await writeCanonicalMessages(db, session.id, [
      { id: 'cutover-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'cutover-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
    ])

    const result = certifyCanonicalSessionApiRead(db, session.id)

    expect(result).toMatchObject({ status: 'eligible', apiReadMode: 'canonical', apiDifferenceCount: 0, routeDifferenceCount: 0 })
    expect(result.watermark).toMatchObject({ sessionGeneration: session.generation, sessionSeq: 1, watermarkEventId: `context-${session.id}` })
    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, undefined, [])).toMatchObject({
      status: 'available', messages: expectedApi
    })
    expect(getRecentTurnRoutingMessages(db, session.id, Number.MAX_SAFE_INTEGER)).toEqual(expectedRoute)
    const routeInput = { userInput: 'new prompt', recentMessages: getRecentTurnRoutingMessages(db, session.id), sessionId: session.id }
    expect(readCanonicalTurnRoutingInputIfEligible(db, {
      sessionId: session.id, mode: 'create-user', routeInput, boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })).toEqual(routeInput)
    expect(getDbConnection(db).prepare('SELECT session_id,session_generation,skeleton_revision,canonical_session_seq,watermark_event_id,protocol_version FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id))
      .toMatchObject({ session_id: session.id, session_generation: session.generation, canonical_session_seq: 1,
        watermark_event_id: `context-${session.id}`, protocol_version: 1 })
    expect(getDbConnection(db).prepare('SELECT api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'canonical', write_mode: 'legacy', cleanup_state: 'retained' })

    getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, undefined, [])).toMatchObject({ status: 'available', messages: expectedApi })
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'canonical' })
    expect(getDbConnection(db).prepare("SELECT cache_key FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toEqual({ cache_key: 'transcript' })

    setCanonicalApiReadFeatureEnabled(db, false)
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'legacy' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    db.close()
  })

  it('does not grant a session-wide fence when any eligible legacy message lacks an exact canonical body', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'incomplete cutover', model: 'test' })
    appendMessage(db, { id: 'cutover-covered-user', sessionId: session.id, role: 'user', content: 'covered', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'cutover-uncovered-user', sessionId: session.id, role: 'user', content: 'uncovered', timestamp: 2, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [
      { id: 'cutover-covered-user', role: 'user', content: 'covered', timestamp: 1 }
    ])

    const result = certifyCanonicalSessionApiRead(db, session.id)

    expect(result).toMatchObject({ status: 'ineligible' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'legacy' })
    db.close()
  })

  it('keeps the canonical reader off by default and re-certifies per session only after the feature flag is enabled', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'feature flag', model: 'test' })
    const user = appendMessage(db, { id: 'feature-flag-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: user.message.id, role: 'user', content: 'body', timestamp: 1 }])

    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, user.message.id, [])).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'legacy' })

    setCanonicalApiReadFeatureEnabled(db, true)
    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, user.message.id, [])).toMatchObject({
      status: 'available', messages: [{ id: user.message.id, content: 'body' }]
    })
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'canonical' })
    db.close()
  })

  it('revokes a stale read fence and falls back to the intact legacy body after a direct canonical watermark change', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'stale cutover', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    const user = appendMessage(db, { id: 'stale-cutover-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [
      { id: user.message.id, role: 'user', content: 'legacy body', timestamp: 1 }
    ])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    getDbConnection(db).prepare("UPDATE agent_history_events SET payload_json=replace(payload_json,'legacy body','changed body') WHERE event_id=?")
      .run(`context-${session.id}`)

    const result = readCanonicalApiContextIfEligible(db, session.id, undefined, user.message.id, [])

    expect(result).toBeUndefined()
    expect(getTurnContext(db, session.id, undefined, user.message.id, [])[0]?.content).toBe('legacy body')
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
    db.close()
  })

  it('revokes canonical API eligibility when a History event is rebound to another session', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history event owner fence', model: 'test' })
    const otherSession = createSession(db, { name: 'other history event owner', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    const user = appendMessage(db, { id: 'history-owner-fence-user', sessionId: session.id, role: 'user', content: 'intact legacy body', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: user.message.id, role: 'user', content: 'intact legacy body', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')

    getDbConnection(db).prepare('UPDATE agent_history_events SET session_id=? WHERE invocation_id=?')
      .run(otherSession.id, `cutover-${session.id}`)

    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id))
      .toBeUndefined()
    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, user.message.id, [])).toBeUndefined()
    expect(getTurnContext(db, session.id, undefined, user.message.id, [])[0]?.content).toBe('intact legacy body')
    db.close()
  })

  it('revokes eligibility on message mutation and allows the complete session to be re-certified', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 're-certification', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    const user = appendMessage(db, { id: 're-certify-user', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [
      { id: user.message.id, role: 'user', content: 'before', timestamp: 1 }
    ])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const previous = getDbConnection(db).prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(session.id)

    // The normal trigger must fence every body and metadata edit before a new turn can use canonical data.
    getDbConnection(db).prepare('UPDATE messages SET content=? WHERE id=?').run('after', user.message.id)

    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, user.message.id, [])).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
    expect(getDbConnection(db).prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .not.toEqual(previous)
    expect(getSession(db, session.id)?.generation).toBe(session.generation)
    db.close()
  })

  it('rejects skill-route configuration when the canonical History watermark changes during the async route', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'async route fence', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    const user = appendMessage(db, { id: 'async-route-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [
      { id: user.message.id, role: 'user', content: 'question', timestamp: 1 }
    ])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const input = { userInput: 'new prompt', recentMessages: getRecentTurnRoutingMessages(db, session.id), sessionId: session.id }
    const selected = readCanonicalTurnRoutingInputWithFenceIfEligible(db, {
      sessionId: session.id, mode: 'create-user', routeInput: input, boundarySequence: undefined, excludeMessageIds: [], limit: 50
    })
    expect(selected?.routeInput).toEqual(input)
    expect(selected?.fence.canonicalSessionSeq).toBe(1)

    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: `cutover-${session.id}`, turnId: `turn-${session.id}`, sequence: 2, schemaVersion: 1,
      eventId: `compaction-${session.id}`, idempotencyKey: `compaction-${session.id}`, kind: 'transcript-compacted',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'question', timestamp: 1 }] }
    }], 1)

    expect(isCanonicalApiReadFenceCurrent(db, session.id, selected!.fence)).toBe(false)
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
    db.close()
  })

  it('keeps a persisted cutover fenced after reopen and falls back when reopened History no longer matches', async () => {
    const temp = createTempDatabase('session-cutover-reopen-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'cutover reopen', model: 'test' })
      setCanonicalApiReadFeatureEnabled(temp.db, true)
      const user = appendMessage(temp.db, { id: 'cutover-reopen-user', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(temp.db, session.id, [
        { id: user.message.id, role: 'user', content: 'legacy body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(temp.db, session.id).status).toBe('eligible')
      expect(readCanonicalApiContextIfEligible(temp.db, session.id, undefined, user.message.id, []))
        .toMatchObject({ status: 'available', messages: [{ id: user.message.id, content: 'legacy body' }] })
      temp.db.close()

      reopened = openDatabase(temp.dbPath)
      expect(readCanonicalApiContextIfEligible(reopened, session.id, undefined, user.message.id, []))
        .toMatchObject({ status: 'available', messages: [{ id: user.message.id, content: 'legacy body' }] })
      expect(getDbConnection(reopened).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ api_read_mode: 'canonical' })

      await new SqliteAgentHistory(getDbConnection(reopened), 1, Date.now, session.id).appendBatch([{
        invocationId: `cutover-${session.id}`, turnId: `turn-${session.id}`, sequence: 2, schemaVersion: 1,
        eventId: `compaction-${session.id}`, idempotencyKey: `compaction-${session.id}`, kind: 'transcript-compacted',
        payload: { messages: [{ id: user.message.id, role: 'user', content: 'provider summary', timestamp: 1 }] }
      }], 1)

      expect(readCanonicalApiContextIfEligible(reopened, session.id, undefined, user.message.id, [])).toBeUndefined()
      expect(getTurnContext(reopened, session.id, undefined, user.message.id, [])[0]?.content).toBe('legacy body')
      expect(getDbConnection(reopened).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
      expect(getDbConnection(reopened).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ api_read_mode: 'revalidation-required' })
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it('preserves legacy parity for a certified canonical API read on a 1200-message session', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'cutover performance', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    const messages: Array<{ id: string; role: 'user'; content: string; timestamp: number }> = []
    for (let index = 0; index < 1200; index += 1) {
      const content = `cutover perf message ${index}`
      const appended = appendMessage(db, { id: `cutover-perf-${index}`, sessionId: session.id, role: 'user', content,
        timestamp: index + 1, status: 'sent' })
      messages.push({ id: appended.message.id, role: 'user', content, timestamp: index + 1 })
    }
    await writeCanonicalMessages(db, session.id, messages)
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const requiredUserId = messages.at(-1)!.id
    const legacy = getTurnContext(db, session.id, undefined, requiredUserId, [])
    const canonical = readCanonicalApiContextIfEligible(db, session.id, undefined, requiredUserId, [])
    expect(canonical?.status).toBe('available')
    expect(canonical?.messages).toEqual(legacy)
    db.close()
  })

  it('refuses canonical write authority for an open or partially mapped session', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write authority gate', model: 'test' })
    appendMessage(db, { id: 'write-gate-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'write-gate-open', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    await writeCanonicalMessages(db, session.id, [{ id: 'write-gate-user', role: 'user', content: 'question', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('ineligible')
    expect(getDbConnection(db).prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ write_mode: 'legacy' })
    db.close()
  })

  it('grants canonical write authority only after full certification and retains exact legacy copies', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write authority eligible', model: 'test' })
    appendMessage(db, { id: 'write-eligible-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'write-eligible-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    await writeCanonicalMessages(db, session.id, [
      { id: 'write-eligible-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'write-eligible-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
    ])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id)).toMatchObject({ status: 'enabled', migratedMessageCount: 2 })
    expect(getDbConnection(db).prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ write_mode: 'canonical' })
    expect(getDbConnection(db).prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
      .toEqual([
        { id: 'write-eligible-user', content: 'question', content_storage_state: 'canonical-backed-dual-write' },
        { id: 'write-eligible-assistant', content: 'answer', content_storage_state: 'canonical-backed-dual-write' }
      ])
    db.close()
  })

  it('fails closed when a session enters the persisted write-stopped cleanup phase', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write stopped cleanup phase', model: 'test' })
    appendMessage(db, { id: 'write-stopped-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'write-stopped-user', role: 'user', content: 'question', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
      VALUES(?,?,?)`).run(session.id, session.generation, Date.now())
    getDbConnection(db).prepare(`UPDATE session_message_content_cutover SET cleanup_state='write-stopped'
      WHERE session_id=?`).run(session.id)

    expect(certifyCanonicalSessionApiRead(db, session.id)).toMatchObject({ status: 'ineligible', reason: 'write-or-cleanup-phase-not-eligible' })
    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, 'write-stopped-user', [])).toBeUndefined()
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id)).toMatchObject({ status: 'ineligible', reason: 'read-fence-not-current' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('write-stopped-user'))
      .toEqual({ content: 'question', content_storage_state: 'legacy' })
    expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'write-stopped' })
    db.close()
  })

  it('refuses write-stop while any queue, turn, or message can still produce body writes', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write-stop active control fence', model: 'test' })
    appendMessage(db, { id: 'write-stop-ready-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'write-stop-ready-user', role: 'user', content: 'question', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(session.id, 'active-turn', 'owner', 1, 'executing', 1, 1)

    expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(false)
    expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'retained' })
    conn.prepare('DELETE FROM session_execution_claims WHERE session_id=?').run(session.id)
    appendMessage(db, { id: 'write-stop-queued-user', sessionId: session.id, role: 'user', content: 'queued', timestamp: 2, status: 'queued' })
    expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(false)
    expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'retained' })
    db.close()
  })

  it('enters write-stopped only for a sealed canonical-write session and preserves every body byte', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write-stop eligible session', model: 'test' })
    appendMessage(db, { id: 'write-stop-sealed-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'write-stop-sealed-user', role: 'user', content: 'question', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
      VALUES(?,?,?)`).run(session.id, session.generation, Date.now())
    expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
    const progress = conn.prepare('SELECT * FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id)
    expect(progress).toMatchObject({ session_generation: session.generation, session_message_revision: 3,
      canonical_session_seq: 1, canonical_commit_order: 1, next_sequence: 0, cleaned_message_count: 0 })
    expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
    expect(conn.prepare('SELECT cleanup_state,api_read_mode,write_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'pending', api_read_mode: 'revalidation-required', write_mode: 'canonical' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=?').all(session.id))
      .toEqual([{ id: 'write-stop-sealed-user', content: 'question', content_storage_state: 'canonical-backed-dual-write' }])
    db.close()
  })

  it('refuses write-stop when any message is unsealed or the full canonical transcript has drifted', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write-stop integrity fence', model: 'test' })
    appendMessage(db, { id: 'write-stop-covered', sessionId: session.id, role: 'user', content: 'covered', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'write-stop-uncovered', sessionId: session.id, role: 'assistant', content: 'uncovered', timestamp: 2, status: 'completed' })
    await writeCanonicalMessages(db, session.id, [
      { id: 'write-stop-covered', role: 'user', content: 'covered', timestamp: 1 },
      { id: 'write-stop-uncovered', role: 'assistant', content: 'uncovered', timestamp: 2 }
    ])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    // Prove the successful control before introducing a storage-state inconsistency.
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    const conn = getDbConnection(db)
    conn.prepare("UPDATE messages SET content_storage_state='legacy' WHERE id='write-stop-uncovered'").run()

    expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(false)
    expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'retained' })
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('write-stop-uncovered'))
      .toEqual({ content: 'uncovered', content_storage_state: 'legacy' })
    db.close()
  })

  it('resumes a persisted write-stop fence after file database reopen and refuses a stale History watermark', async () => {
    const temp = createTempDatabase('content-cleanup-fence-reopen-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'write-stop reopen fence', model: 'test' })
      appendMessage(db, { id: 'write-stop-reopen-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [{ id: 'write-stop-reopen-user', role: 'user', content: 'question', timestamp: 1 }])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      const before = getDbConnection(db).prepare('SELECT * FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id)
      db.close()
      db = openDatabase(temp.dbPath)
      expect(getDbConnection(db).prepare('SELECT * FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id)).toEqual(before)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('write-stop-reopen-user'))
        .toEqual({ content: 'question', content_storage_state: 'canonical-backed-dual-write' })
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }

    const stale = createMemoryAppDb()
    const session = createSession(stale, { name: 'write-stop stale fence', model: 'test' })
    appendMessage(stale, { id: 'write-stop-stale-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(stale, session.id, [{ id: 'write-stop-stale-user', role: 'user', content: 'question', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(stale, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(stale, session.id).status).toBe('enabled')
    expect(markSessionMessageContentWriteStopped(stale, session.id)).toBe(true)
    expect(() => getDbConnection(stale).prepare("UPDATE agent_history_events SET payload_json='invalid' WHERE event_id=?")
      .run(`context-${session.id}`)).toThrow(/History writes are stopped/i)
    const cursor = getDbConnection(stale).prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(session.id) as { next_seq: number }
    getDbConnection(stale).prepare('UPDATE session_event_cursor SET next_seq=next_seq+1 WHERE session_id=?').run(session.id)
    expect(beginSessionMessageContentCleanup(stale, session.id)).toBe(false)
    getDbConnection(stale).prepare('UPDATE session_event_cursor SET next_seq=? WHERE session_id=?').run(cursor.next_seq, session.id)
    expect(beginSessionMessageContentCleanup(stale, session.id)).toBe(true)
    expect(getDbConnection(stale).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'pending' })
    expect(getDbConnection(stale).prepare('SELECT content FROM messages WHERE id=?').get('write-stop-stale-user'))
      .toEqual({ content: 'question' })
    stale.close()
  })

  it('clears bounded batches atomically, resumes after reopen, and completes only after reopened verification', async () => {
    const temp = createTempDatabase('content-cleanup-batches-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'bounded content cleanup', model: 'test' })
      const messages = [
        { id: 'cleanup-user-1', role: 'user' as const, content: 'question one', timestamp: 1, status: 'sent' as const },
        { id: 'cleanup-assistant-1', role: 'assistant' as const, content: 'answer one', timestamp: 2, status: 'completed' as const },
        { id: 'cleanup-user-2', role: 'user' as const, content: 'question two', timestamp: 3, status: 'sent' as const }
      ]
      for (const message of messages) appendMessage(db, { ...message, sessionId: session.id })
      await writeCanonicalMessages(db, session.id, messages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })))
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(() => getDbConnection(db).prepare(`UPDATE messages SET content='',content_storage_state='canonical-backed-only',attachments='[]'
        WHERE id='cleanup-user-1'`).run()).toThrow(/write stopped|write-stop|cleanup/i)

      const firstBatch = clearNextSessionMessageContentBatch(db, session.id, 2)
      expect(firstBatch).toMatchObject({ status: 'advanced', cleanedMessageCount: 2, nextSequence: 1, afterMessageId: 'cleanup-assistant-1' })
      expect(getDbConnection(db).prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
        .toEqual([
          { id: 'cleanup-user-1', content: '', content_storage_state: 'canonical-backed-only' },
          { id: 'cleanup-assistant-1', content: '', content_storage_state: 'canonical-backed-only' },
          { id: 'cleanup-user-2', content: 'question two', content_storage_state: 'canonical-backed-dual-write' }
        ])
      const progressBeforeFault = getDbConnection(db).prepare('SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id)
      getDbConnection(db).exec(`CREATE TRIGGER fail_cleanup_batch BEFORE UPDATE OF content ON messages
        WHEN OLD.id='cleanup-user-2' BEGIN SELECT RAISE(ABORT,'injected cleanup batch failure'); END`)
      expect(() => clearNextSessionMessageContentBatch(db, session.id, 1)).toThrow('injected cleanup batch failure')
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('cleanup-user-2'))
        .toEqual({ content: 'question two', content_storage_state: 'canonical-backed-dual-write' })
      expect(getDbConnection(db).prepare('SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toEqual(progressBeforeFault)
      expect(getDbConnection(db).prepare('SELECT attempts,last_error FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toMatchObject({ attempts: 1, last_error: 'injected cleanup batch failure' })
      getDbConnection(db).exec('DROP TRIGGER fail_cleanup_batch')

      db.close()
      db = openDatabase(temp.dbPath)
      expect(getDbConnection(db).prepare('SELECT attempts,last_error FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toMatchObject({ attempts: 1, last_error: 'injected cleanup batch failure' })
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
      expect(getDbConnection(db).prepare('SELECT attempts,last_error,cleaned_message_count FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toMatchObject({ attempts: 1, last_error: null, cleaned_message_count: 3 })
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(false)
      db.close()
      db = openDatabase(temp.dbPath)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'complete' })
      expect(getDbConnection(db).prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
        .toEqual(messages.map(({ id }) => ({ id, content: '', content_storage_state: 'canonical-backed-only' })))
      expect(getDbConnection(db).prepare('SELECT message_count,preview FROM sessions WHERE id=?').get(session.id))
        .toMatchObject({ message_count: 3, preview: 'question two' })
      expect(getDbConnection(db).prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it('rolls back final verification proof if the complete-state compare-and-set fails', async () => {
    const temp = createTempDatabase('cleanup-final-proof-rollback-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'cleanup final proof rollback', model: 'test' })
      appendMessage(db, { id: 'cleanup-proof-rollback-user', sessionId: session.id, role: 'user', content: 'body',
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-proof-rollback-user', role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
      db.close()
      db = openDatabase(temp.dbPath)
      const conn = getDbConnection(db)
      conn.exec(`CREATE TRIGGER fail_cleanup_completion BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
        WHEN NEW.cleanup_state='complete' BEGIN SELECT RAISE(ABORT,'injected cleanup completion CAS failure'); END`)

      expect(() => verifyAndCompleteSessionMessageContentCleanup(db, session.id))
        .toThrow('injected cleanup completion CAS failure')
      expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(conn.prepare('SELECT scan_complete,verified_at,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ scan_complete: 1, verified_at: null, verification_sha256: null })

      conn.exec('DROP TRIGGER fail_cleanup_completion')
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'complete' })
      expect(conn.prepare('SELECT verified_at,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ verified_at: expect.any(Number), verification_sha256: expect.any(String) })
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it('refuses final completion when the persisted cleanup cursor or count disagrees with cleared rows', async () => {
    const temp = createTempDatabase('cleanup-final-cursor-drift-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'cleanup final cursor drift', model: 'test' })
      appendMessage(db, { id: 'cleanup-final-cursor-user', sessionId: session.id, role: 'user', content: 'body',
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-final-cursor-user', role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
      db.close()
      db = openDatabase(temp.dbPath)
      const conn = getDbConnection(db)
      const expectedCursor = conn.prepare('SELECT next_sequence,after_message_id FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id) as { next_sequence: number; after_message_id: string | null }
      conn.prepare('UPDATE session_message_content_cleanup_progress SET cleaned_message_count=0 WHERE session_id=?').run(session.id)

      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(false)
      expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(conn.prepare('SELECT scan_complete,cleaned_message_count,verified_at,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ scan_complete: 1, cleaned_message_count: 0, verified_at: null, verification_sha256: null })

      conn.prepare('UPDATE session_message_content_cleanup_progress SET cleaned_message_count=1 WHERE session_id=?').run(session.id)
      conn.prepare('UPDATE session_message_content_cleanup_progress SET after_message_id=? WHERE session_id=?').run('forged-cursor-anchor', session.id)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(false)
      expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(conn.prepare('SELECT next_sequence,after_message_id,verified_at,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ next_sequence: expectedCursor.next_sequence, after_message_id: 'forged-cursor-anchor', verified_at: null, verification_sha256: null })

      conn.prepare('UPDATE session_message_content_cleanup_progress SET after_message_id=? WHERE session_id=?')
        .run(expectedCursor.after_message_id, session.id)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(true)
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it('isolates cleanup failures to one session while another pending session completes', async () => {
    const temp = createTempDatabase('content-cleanup-session-isolation-')
    let db = temp.db
    try {
      const sessions = [
        { session: createSession(db, { name: 'cleanup isolated failure', model: 'test' }), id: 'cleanup-isolated-failure' },
        { session: createSession(db, { name: 'cleanup unaffected session', model: 'test' }), id: 'cleanup-unaffected-session' }
      ]
      for (const { session, id } of sessions) {
        const message = { id, role: 'user' as const, content: `body for ${id}`, timestamp: 1, status: 'sent' as const }
        appendMessage(db, { ...message, sessionId: session.id })
        await writeCanonicalMessages(db, session.id, [{ id, role: message.role, content: message.content, timestamp: message.timestamp }])
        expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      }
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      for (const { session } of sessions) {
        expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
        expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
        expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      }

      getDbConnection(db).exec(`CREATE TRIGGER fail_one_session_cleanup BEFORE UPDATE OF content ON messages
        WHEN OLD.id='cleanup-isolated-failure' BEGIN SELECT RAISE(ABORT,'injected isolated-session failure'); END`)
      expect(() => clearNextSessionMessageContentBatch(db, sessions[0].session.id, 1))
        .toThrow('injected isolated-session failure')
      expect(clearNextSessionMessageContentBatch(db, sessions[1].session.id, 1))
        .toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(sessions[0].session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('cleanup-isolated-failure'))
        .toEqual({ content: 'body for cleanup-isolated-failure', content_storage_state: 'canonical-backed-dual-write' })
      expect(getDbConnection(db).prepare('SELECT attempts,last_error FROM session_message_content_cleanup_progress WHERE session_id=?').get(sessions[0].session.id))
        .toMatchObject({ attempts: 1, last_error: 'injected isolated-session failure' })
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('cleanup-unaffected-session'))
        .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
      getDbConnection(db).exec('DROP TRIGGER fail_one_session_cleanup')

      db.close()
      db = openDatabase(temp.dbPath)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, sessions[1].session.id)).toBe(true)
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(sessions[0].session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(clearNextSessionMessageContentBatch(db, sessions[0].session.id, 1))
        .toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
      db.close()
      db = openDatabase(temp.dbPath)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, sessions[0].session.id)).toBe(true)
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id IN (?,?) ORDER BY session_id')
        .all(...sessions.map(({ session }) => session.id)))
        .toEqual([{ cleanup_state: 'complete' }, { cleanup_state: 'complete' }])
      expect(getDbConnection(db).prepare('SELECT id,content FROM messages WHERE session_id IN (?,?) ORDER BY id')
        .all(...sessions.map(({ session }) => session.id)))
        .toEqual(sessions.map(({ id }) => ({ id, content: '' })))
      expect(getDbConnection(db).prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it.each([
    ['message revision changes', 'fence-changed'],
    ['session generation changes', 'fence-changed'],
    ['History cursor advances', 'history-unavailable'],
    ['History cursor regresses', 'history-unavailable'],
    ['History cursor is missing', 'history-unavailable'],
    ['global History commit cursor advances', 'history-unavailable'],
    ['persisted canonical session sequence fence drifts', 'history-unavailable'],
    ['persisted canonical commit order fence drifts', 'history-unavailable'],
    ['persisted watermark event identity drifts', 'history-unavailable'],
    ['persisted watermark invocation identity drifts', 'history-unavailable'],
    ['an active execution claim appears', 'active-control']
  ] as const)('refuses the next cleanup batch when %s after pending', async (drift, expectedReason) => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: `cleanup fence drift: ${drift}`, model: 'test' })
      appendMessage(db, { id: `cleanup-fence-${drift}`, sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: `cleanup-fence-${drift}`, role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      const conn = getDbConnection(db)
      const before = conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)

      if (drift === 'message revision changes') {
        conn.prepare('UPDATE messages SET attachments=? WHERE id=?').run('["changed"]', `cleanup-fence-${drift}`)
      } else if (drift === 'session generation changes') {
        conn.prepare('UPDATE sessions SET generation=? WHERE id=?').run('new-generation', session.id)
      } else if (drift === 'History cursor advances') {
        conn.prepare('UPDATE session_event_cursor SET next_seq=next_seq+1 WHERE session_id=?').run(session.id)
      } else if (drift === 'History cursor regresses') {
        conn.prepare('UPDATE session_event_cursor SET next_seq=0 WHERE session_id=?').run(session.id)
      } else if (drift === 'History cursor is missing') {
        conn.prepare('DELETE FROM session_event_cursor WHERE session_id=?').run(session.id)
      } else if (drift === 'global History commit cursor advances') {
        conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now())
      } else if (drift === 'persisted canonical session sequence fence drifts') {
        conn.exec('DROP TRIGGER guard_session_content_cleanup_progress_baseline')
        conn.prepare('UPDATE session_message_content_cleanup_progress SET canonical_session_seq=canonical_session_seq+1 WHERE session_id=?').run(session.id)
      } else if (drift === 'persisted canonical commit order fence drifts') {
        conn.exec('DROP TRIGGER guard_session_content_cleanup_progress_baseline')
        conn.prepare('UPDATE session_message_content_cleanup_progress SET canonical_commit_order=canonical_commit_order+1 WHERE session_id=?').run(session.id)
      } else if (drift === 'persisted watermark event identity drifts') {
        conn.exec('DROP TRIGGER guard_session_content_cleanup_progress_baseline')
        conn.prepare("UPDATE session_message_content_cleanup_progress SET watermark_event_id='forged-event' WHERE session_id=?").run(session.id)
      } else if (drift === 'persisted watermark invocation identity drifts') {
        conn.exec('DROP TRIGGER guard_session_content_cleanup_progress_baseline')
        conn.prepare("UPDATE session_message_content_cleanup_progress SET watermark_invocation_id='forged-invocation' WHERE session_id=?").run(session.id)
      } else {
        conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(session.id, 'late-active-turn', 'owner', 1, 'executing', 1, 1)
      }

      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'ineligible', cleanedMessageCount: 0, reason: expectedReason
      })
      expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(`cleanup-fence-${drift}`))
        .toEqual({ content: 'body', content_storage_state: 'canonical-backed-dual-write' })
      expect(conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)).toEqual(before)
      expect(conn.prepare('SELECT attempts,last_error FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toMatchObject({ attempts: 1, last_error: expectedReason })
    } finally {
      db.close()
    }
  })

  it('rejects a persisted cleanup cursor that skips an uncleared message', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'cleanup cursor skips uncleared row', model: 'test' })
      const first = appendMessage(db, { id: 'cleanup-cursor-first', sessionId: session.id, role: 'user', content: 'first body',
        timestamp: 1, status: 'sent' }).message
      const second = appendMessage(db, { id: 'cleanup-cursor-second', sessionId: session.id, role: 'assistant', content: 'second body',
        timestamp: 2, status: 'completed' }).message
      await writeCanonicalMessages(db, session.id, [
        { id: first.id, role: 'user', content: 'first body', timestamp: 1 },
        { id: second.id, role: 'assistant', content: 'second body', timestamp: 2 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      const conn = getDbConnection(db)
      const firstSequence = (conn.prepare('SELECT sequence FROM messages WHERE id=?').get(first.id) as { sequence: number }).sequence

      conn.prepare(`UPDATE session_message_content_cleanup_progress SET next_sequence=?,after_message_id=? WHERE session_id=?`)
        .run(firstSequence, first.id, session.id)

      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'ineligible', cleanedMessageCount: 0, reason: 'fence-changed'
      })
      expect(conn.prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence,id').all(session.id))
        .toEqual([
          { id: first.id, content: 'first body', content_storage_state: 'canonical-backed-dual-write' },
          { id: second.id, content: 'second body', content_storage_state: 'canonical-backed-dual-write' }
        ])
      expect(conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete,attempts,last_error
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id))
        .toMatchObject({ next_sequence: firstSequence, after_message_id: first.id, cleaned_message_count: 0,
          scan_complete: 0, attempts: 1, last_error: 'fence-changed' })
    } finally {
      db.close()
    }
  })

  it.each(['rewinds behind a committed prefix', 'claims an uncommitted cleared row'] as const)(
    'rejects a cleanup progress ledger that %s', async (drift) => {
      const db = createMemoryAppDb()
      try {
        const session = createSession(db, { name: `cleanup progress ledger ${drift}`, model: 'test' })
        const first = appendMessage(db, { id: `cleanup-progress-first-${drift}`, sessionId: session.id, role: 'user',
          content: 'first body', timestamp: 1, status: 'sent' }).message
        const second = appendMessage(db, { id: `cleanup-progress-second-${drift}`, sessionId: session.id, role: 'assistant',
          content: 'second body', timestamp: 2, status: 'completed' }).message
        await writeCanonicalMessages(db, session.id, [
          { id: first.id, role: 'user', content: 'first body', timestamp: 1 },
          { id: second.id, role: 'assistant', content: 'second body', timestamp: 2 }
        ])
        expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
        const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
        expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
        expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
        expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
        const conn = getDbConnection(db)
        const firstSequence = (conn.prepare('SELECT sequence FROM messages WHERE id=?').get(first.id) as { sequence: number }).sequence

        if (drift === 'rewinds behind a committed prefix') {
          expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
            status: 'advanced', cleanedMessageCount: 1, afterMessageId: first.id
          })
          conn.prepare(`UPDATE session_message_content_cleanup_progress SET next_sequence=?,after_message_id=NULL WHERE session_id=?`)
            .run(firstSequence, session.id)
        } else {
          conn.prepare('UPDATE session_message_content_cleanup_progress SET cleaned_message_count=1 WHERE session_id=?').run(session.id)
        }
        const cursorBefore = conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
          FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)

        expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
          status: 'ineligible', cleanedMessageCount: 0, reason: 'fence-changed'
        })
        expect(conn.prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence,id').all(session.id))
          .toEqual(drift === 'rewinds behind a committed prefix'
            ? [
                { id: first.id, content: '', content_storage_state: 'canonical-backed-only' },
                { id: second.id, content: 'second body', content_storage_state: 'canonical-backed-dual-write' }
              ]
            : [
                { id: first.id, content: 'first body', content_storage_state: 'canonical-backed-dual-write' },
                { id: second.id, content: 'second body', content_storage_state: 'canonical-backed-dual-write' }
              ])
        expect(conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
          FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)).toEqual(cursorBefore)
        expect(conn.prepare('SELECT attempts,last_error FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
          .toMatchObject({ attempts: 1, last_error: 'fence-changed' })
      } finally {
        db.close()
      }
    }
  )

  it('does not clear another batch after the pending source manifest is corrupted', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'cleanup source manifest fence', model: 'test' })
      appendMessage(db, { id: 'cleanup-source-manifest-user', sessionId: session.id, role: 'user', content: 'body',
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-source-manifest-user', role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      const conn = getDbConnection(db)
      conn.exec('DROP TRIGGER guard_session_content_cleanup_progress_baseline')
      conn.prepare(`UPDATE session_message_content_cleanup_progress SET source_manifest_sha256=? WHERE session_id=?`)
        .run('0'.repeat(64), session.id)

      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'ineligible', cleanedMessageCount: 0, reason: 'fence-changed'
      })
      expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('cleanup-source-manifest-user'))
        .toEqual({ content: 'body', content_storage_state: 'canonical-backed-dual-write' })
      expect(conn.prepare('SELECT attempts,last_error,cleaned_message_count FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ attempts: 1, last_error: 'fence-changed', cleaned_message_count: 0 })
    } finally {
      db.close()
    }
  })

  it('protects pending cleanup source manifest and watermark baseline from direct SQL mutation', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'cleanup immutable baseline', model: 'test' })
      appendMessage(db, { id: 'cleanup-immutable-baseline-user', sessionId: session.id, role: 'user', content: 'body',
        status: 'sent', timestamp: 1 })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-immutable-baseline-user', role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)

      const conn = getDbConnection(db)
      const baseline = conn.prepare(`SELECT session_generation,session_message_revision,canonical_session_seq,
        canonical_commit_order,watermark_event_id,watermark_invocation_id,source_manifest_sha256
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)
      const mutations = [
        () => conn.prepare(`UPDATE session_message_content_cleanup_progress SET source_manifest_sha256=? WHERE session_id=?`)
          .run('0'.repeat(64), session.id),
        () => conn.prepare(`UPDATE session_message_content_cleanup_progress SET canonical_session_seq=canonical_session_seq+1 WHERE session_id=?`)
          .run(session.id)
      ]

      for (const mutate of mutations) expect(mutate).toThrow(/immutable|baseline/i)
      expect(conn.prepare(`SELECT session_generation,session_message_revision,canonical_session_seq,
        canonical_commit_order,watermark_event_id,watermark_invocation_id,source_manifest_sha256
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)).toEqual(baseline)
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'complete', cleanedMessageCount: 1
      })
    } finally {
      db.close()
    }
  })

  it('deletes a pending session and its cleanup ledger atomically with its message skeletons', async () => {
    const temp = createTempDatabase('cleanup-pending-session-delete-')
    const db = temp.db
    try {
      const session = createSession(db, { name: 'delete pending session', model: 'test' })
      appendMessage(db, { id: 'cleanup-delete-pending-user', sessionId: session.id, role: 'user', content: 'body',
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-delete-pending-user', role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)

      const conn = getDbConnection(db)
      deleteSession(db, session.id, { flush: false })
      expect(conn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toBeUndefined()
      expect(conn.prepare('SELECT id FROM messages WHERE session_id=?').all(session.id)).toEqual([])
      expect(conn.prepare('SELECT session_id FROM session_message_content_cutover WHERE session_id=?').get(session.id)).toBeUndefined()
      expect(conn.prepare('SELECT session_id FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id)).toBeUndefined()
      expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
      await fs.rm(path.dirname(temp.dbPath), { recursive: true, force: true })
    }
  })

  it('restores pending cleanup state if whole-session deletion later fails', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'failed delete pending session', model: 'test' })
      appendMessage(db, { id: 'cleanup-delete-rollback-user', sessionId: session.id, role: 'user', content: 'body',
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-delete-rollback-user', role: 'user', content: 'body', timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      const conn = getDbConnection(db)
      conn.exec(`CREATE TRIGGER fail_pending_session_delete BEFORE DELETE ON sessions
        BEGIN SELECT RAISE(ABORT,'injected pending delete failure'); END`)

      expect(() => deleteSession(db, session.id, { flush: false })).toThrow('injected pending delete failure')
      expect(conn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(conn.prepare('SELECT source_manifest_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toMatchObject({ source_manifest_sha256: expect.any(String) })
      expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('cleanup-delete-rollback-user'))
        .toEqual({ content: 'body', content_storage_state: 'canonical-backed-dual-write' })
      conn.exec('DROP TRIGGER fail_pending_session_delete')
    } finally {
      db.close()
    }
  })

  it('deletes a completed cleanup session and reclaims its source spill after reopen', async () => {
    const temp = createTempDatabase('complete-cleanup-delete-spill-gc-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'delete completed cleanup session', model: 'test' })
      const body = 'completed cleanup source spill '.repeat(3_000)
      appendMessage(db, { id: 'complete-cleanup-delete-user', sessionId: session.id, role: 'user', content: body,
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'complete-cleanup-delete-user', role: 'user', content: body, timestamp: 1 }
      ])
      const conn = getDbConnection(db)
      const event = conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
        .get(`context-${session.id}`) as { payload_json: string }
      const payload = JSON.parse(event.payload_json) as { messages: Array<{ content: unknown }> }
      const spill = payload.messages[0]?.content as { __spaceassistant_spill_v1?: { locator?: string } } | undefined
      const locator = spill?.__spaceassistant_spill_v1?.locator
      expect(locator).toEqual(expect.any(String))
      const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
      const spillPath = path.join(spillRoot, locator!)
      expect(await fs.stat(spillPath)).toBeDefined()

      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({ status: 'complete' })
      db.close()
      db = openDatabase(temp.dbPath)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?')
        .get(session.id)).toEqual({ cleanup_state: 'complete' })

      const completedConn = getDbConnection(db)
      expect(() => completedConn.prepare(`UPDATE session_message_content_cleanup_progress SET verification_sha256='forged-proof'
        WHERE session_id=?`).run(session.id)).toThrow('complete session cleanup ledger is immutable')
      expect(completedConn.prepare('SELECT verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ verification_sha256: expect.any(String) })
      expect(() => completedConn.prepare('DELETE FROM session_message_content_cleanup_progress WHERE session_id=?').run(session.id))
        .toThrow('complete session cleanup ledger is immutable')
      expect(completedConn.prepare('SELECT session_id,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ session_id: session.id, verification_sha256: expect.any(String) })
      completedConn.exec(`CREATE TRIGGER fail_completed_session_delete BEFORE DELETE ON sessions
        BEGIN SELECT RAISE(ABORT,'injected completed-session delete failure'); END`)
      expect(() => deleteSession(db, session.id, { flush: false })).toThrow('injected completed-session delete failure')
      expect(completedConn.prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?')
        .get(session.id)).toEqual({ cleanup_state: 'complete' })
      expect(completedConn.prepare('SELECT verified_at,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ verified_at: expect.any(Number), verification_sha256: expect.any(String) })
      expect(completedConn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?')
        .get('complete-cleanup-delete-user')).toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
      expect(completedConn.prepare('SELECT locator FROM source_truth_spill_gc_queue WHERE locator=?').get(locator)).toBeUndefined()
      expect(completedConn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toEqual({ id: session.id })
      completedConn.exec('DROP TRIGGER fail_completed_session_delete')
      deleteSession(db, session.id, { flush: false })
      const reopenedConn = getDbConnection(db)
      expect(reopenedConn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toBeUndefined()
      expect(reopenedConn.prepare('SELECT session_id,generation,status FROM source_truth_spill_gc_queue WHERE locator=?')
        .get(locator)).toMatchObject({ session_id: session.id, generation: session.generation, status: 'pending' })
      expect(await fs.stat(spillPath)).toBeDefined()
      db.close()
      db = openDatabase(temp.dbPath)
      await expect(runSourceTruthSpillGcMaintenance(db, spillRoot)).resolves.toMatchObject({ pending: 0, completed: 1 })
      expect(getDbConnection(db).prepare('SELECT status,attempts,last_error FROM source_truth_spill_gc_queue WHERE locator=?')
        .get(locator)).toMatchObject({ status: 'completed', attempts: 1, last_error: null })
      await expect(fs.access(spillPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(getDbConnection(db).prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it('keeps cleared-session source spills queued and present across deletion and database reopen', async () => {
    const temp = createTempDatabase('cleanup-delete-spill-gc-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const db = temp.db
      const session = createSession(db, { name: 'delete cleared spill session', model: 'test' })
      const otherSession = createSession(db, { name: 'shared source spill owner' })
      const body = 'source truth retained until GC '.repeat(3_000)
      appendMessage(db, { id: 'cleanup-delete-spill-user', sessionId: session.id, role: 'user', content: body,
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: 'cleanup-delete-spill-user', role: 'user', content: body, timestamp: 1 }
      ])
      const conn = getDbConnection(db)
      const event = conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
        .get(`context-${session.id}`) as { payload_json: string }
      const payload = JSON.parse(event.payload_json) as { messages: Array<{ content: unknown }> }
      const sourceContent = payload.messages[0]?.content as { __spaceassistant_spill_v1?: { locator?: string } } | undefined
      const locator = sourceContent?.__spaceassistant_spill_v1?.locator
      expect(locator).toEqual(expect.any(String))
      const spillPath = path.join(path.dirname(temp.dbPath), 'spill', locator!)
      expect(await fs.stat(spillPath)).toBeDefined()
      await new SqliteAgentHistory(conn, 1, Date.now, otherSession.id).appendBatch([{
        invocationId: `cutover-shared-spill-${otherSession.id}`, turnId: `cutover-shared-turn-${otherSession.id}`,
        sequence: 1, schemaVersion: 1, eventId: `cutover-shared-event-${otherSession.id}`,
        idempotencyKey: `cutover-shared-key-${otherSession.id}`, kind: 'invocation-context-committed',
        payload: { messages: [], sharedSpill: sourceContent.__spaceassistant_spill_v1 }
      }], 0)

      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'complete', cleanedMessageCount: 1
      })
      deleteSession(db, session.id, { flush: false })
      expect(conn.prepare('SELECT session_id,generation,status FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
        .toMatchObject({ session_id: session.id, generation: session.generation, status: 'pending' })
      expect(await fs.stat(spillPath)).toBeDefined()
      db.close()

      reopened = openDatabase(temp.dbPath)
      const reopenedConn = getDbConnection(reopened)
      expect(reopenedConn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toBeUndefined()
      expect(reopenedConn.prepare('SELECT session_id,status FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
        .toEqual({ session_id: session.id, status: 'pending' })
      expect(await fs.stat(spillPath)).toBeDefined()
      await expect(runSourceTruthSpillGcMaintenance(reopened, path.join(path.dirname(temp.dbPath), 'spill')))
        .resolves.toMatchObject({ pending: 1, shared: 1, completed: 0 })
      expect(reopenedConn.prepare('SELECT status FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
        .toEqual({ status: 'pending' })
      expect(await fs.stat(spillPath)).toBeDefined()
      deleteSession(reopened, otherSession.id, { flush: false })
      await expect(runSourceTruthSpillGcMaintenance(reopened, path.join(path.dirname(temp.dbPath), 'spill')))
        .resolves.toMatchObject({ pending: 0, completed: 1 })
      expect(reopenedConn.prepare('SELECT status,attempts,last_error FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
        .toMatchObject({ status: 'completed', last_error: null })
      await expect(fs.access(spillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it.each(['missing', 'tampered'] as const)('stops later cleanup batches when a canonical source spill becomes %s', async (failure) => {
    const temp = createTempDatabase(`cleanup-source-spill-${failure}-`)
    let db = temp.db
    try {
      const session = createSession(db, { name: `cleanup source spill ${failure}`, model: 'test' })
      const body = 'canonical cleanup source body '.repeat(3_000)
      appendMessage(db, { id: `cleanup-spill-user-${failure}`, sessionId: session.id, role: 'user', content: body,
        timestamp: 1, status: 'sent' })
      appendMessage(db, { id: `cleanup-spill-assistant-${failure}`, sessionId: session.id, role: 'assistant', content: 'answer',
        timestamp: 2, status: 'completed' })
      await writeCanonicalMessages(db, session.id, [
        { id: `cleanup-spill-user-${failure}`, role: 'user', content: body, timestamp: 1 },
        { id: `cleanup-spill-assistant-${failure}`, role: 'assistant', content: 'answer', timestamp: 2 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)

      const conn = getDbConnection(db)
      const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
        .get(`context-${session.id}`)!.payload_json as string) as {
          messages: Array<{ id: string; content: { __spaceassistant_spill_v1?: { locator?: string } } | string }>
        }
      const content = stored.messages.find(({ id }) => id === `cleanup-spill-user-${failure}`)?.content
      if (!content || typeof content === 'string' || !content.__spaceassistant_spill_v1?.locator) {
        throw new Error('expected canonical cleanup source spill locator')
      }
      const spillPath = path.join(path.dirname(temp.dbPath), 'spill', content.__spaceassistant_spill_v1.locator)

      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'advanced', cleanedMessageCount: 1, nextSequence: 0, afterMessageId: `cleanup-spill-user-${failure}`
      })
      const before = conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)
      if (failure === 'missing') await fs.rm(spillPath)
      else await fs.writeFile(spillPath, 'tampered canonical cleanup source')

      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({
        status: 'ineligible', cleanedMessageCount: 0, reason: 'history-unavailable'
      })
      expect(conn.prepare('SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
        .toEqual([
          { id: `cleanup-spill-user-${failure}`, content: '', content_storage_state: 'canonical-backed-only' },
          { id: `cleanup-spill-assistant-${failure}`, content: 'answer', content_storage_state: 'canonical-backed-dual-write' }
        ])
      expect(conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
        FROM session_message_content_cleanup_progress WHERE session_id=?`).get(session.id)).toEqual(before)
      expect(conn.prepare('SELECT attempts,last_error FROM session_message_content_cleanup_progress WHERE session_id=?').get(session.id))
        .toMatchObject({ attempts: 1, last_error: 'history-unavailable' })
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it.each(['missing', 'tampered'] as const)('does not complete cleanup after the final source spill becomes %s before reopened verification', async (failure) => {
    const temp = createTempDatabase(`cleanup-final-spill-${failure}-`)
    let db = temp.db
    try {
      const session = createSession(db, { name: `cleanup final spill ${failure}`, model: 'test' })
      const body = 'canonical final verification source body '.repeat(3_000)
      appendMessage(db, { id: `cleanup-final-spill-user-${failure}`, sessionId: session.id, role: 'user', content: body,
        timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(db, session.id, [
        { id: `cleanup-final-spill-user-${failure}`, role: 'user', content: body, timestamp: 1 }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
      expect(beginSessionMessageContentCleanup(db, session.id)).toBe(true)

      const conn = getDbConnection(db)
      const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
        .get(`context-${session.id}`)!.payload_json as string) as {
          messages: Array<{ id: string; content: { __spaceassistant_spill_v1?: { locator?: string } } | string }>
        }
      const content = stored.messages.find(({ id }) => id === `cleanup-final-spill-user-${failure}`)?.content
      if (!content || typeof content === 'string' || !content.__spaceassistant_spill_v1?.locator) {
        throw new Error('expected canonical final verification spill locator')
      }
      const spillPath = path.join(path.dirname(temp.dbPath), 'spill', content.__spaceassistant_spill_v1.locator)
      expect(clearNextSessionMessageContentBatch(db, session.id, 1)).toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
      if (failure === 'missing') await fs.rm(spillPath)
      else await fs.writeFile(spillPath, 'tampered before final cleanup verification')

      db.close()
      db = openDatabase(temp.dbPath)
      expect(verifyAndCompleteSessionMessageContentCleanup(db, session.id)).toBe(false)
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
        .toEqual({ cleanup_state: 'pending' })
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(`cleanup-final-spill-user-${failure}`))
        .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
      expect(getDbConnection(db).prepare('SELECT scan_complete,verified_at,verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id=?')
        .get(session.id)).toMatchObject({ scan_complete: 1, verified_at: null, verification_sha256: null })
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
    }
  })

  it('refuses write-stop body mirrors and queued writes after the fence, while still allowing terminal metadata updates', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write stop body writer fence', model: 'test' })
    appendMessage(db, { id: 'write-fence-user', sessionId: session.id, role: 'user', content: 'original', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'write-fence-user', role: 'user', content: 'original', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await expect(history.appendBatch([{
      invocationId: 'post-stop-invocation', turnId: 'post-stop-turn', sequence: 1, schemaVersion: 1,
      eventId: 'post-stop-context', idempotencyKey: 'post-stop-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'write-fence-user', role: 'user', content: 'rewritten', timestamp: 1 }] }
    }], 0)).rejects.toThrow(/write stopped|write-stop|cleanup/i)
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('write-fence-user')).toEqual({ content: 'original' })
    expect(() => {
      conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
        VALUES('post-stop-queued',?,'user','queued body','queued',1,2,2)`).run(session.id)
    }).toThrow(/write stopped|write-stop|cleanup/i)
    expect(conn.prepare('SELECT id,content,status FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
      .toEqual([{ id: 'write-fence-user', content: 'original', status: 'sent' }])
    db.close()
  })

  it('rolls back write mode and every storage-state change if one row transition fails', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write migration rollback', model: 'test' })
    appendMessage(db, { id: 'write-rollback-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'write-rollback-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    await writeCanonicalMessages(db, session.id, [
      { id: 'write-rollback-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'write-rollback-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
    ])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    getDbConnection(db).exec(`CREATE TRIGGER fail_write_state_transition BEFORE UPDATE OF content_storage_state ON messages
      WHEN NEW.content_storage_state='canonical-backed-dual-write' AND NEW.id='write-rollback-assistant'
      BEGIN SELECT RAISE(ABORT,'injected storage state failure'); END`)
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(() => enableCanonicalSessionWriteAuthority(db, session.id)).toThrow('injected storage state failure')
    expect(getDbConnection(db).prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ write_mode: 'legacy' })
    expect(getDbConnection(db).prepare('SELECT DISTINCT content_storage_state FROM messages WHERE session_id=?').all(session.id))
      .toEqual([{ content_storage_state: 'legacy' }])
    db.close()
  })

  it('canonical History writes atomically mirror sealed bodies and mark them dual-write under canonical authority', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write authority live', model: 'test' })
    appendMessage(db, { id: 'write-live-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'write-live-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    const initial = [
      { id: 'write-live-user', role: 'user' as const, content: 'question', timestamp: 1 },
      { id: 'write-live-assistant', role: 'assistant' as const, content: 'answer', timestamp: 2 }
    ]
    await writeCanonicalMessages(db, session.id, initial)
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    appendMessage(db, { id: 'write-live-next-user', sessionId: session.id, role: 'user', content: 'next', timestamp: 3, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    const nextContext = [{
      invocationId: `cutover-next-${session.id}`, turnId: `turn-next-${session.id}`, sequence: 1, schemaVersion: 1,
      eventId: `context-next-${session.id}`, idempotencyKey: `context-next-${session.id}`, kind: 'invocation-context-committed',
      payload: { messages: [...initial, { id: 'write-live-next-user', role: 'user', content: 'next', timestamp: 3 }] }
    }] as const
    const conn = getDbConnection(db)
    const eventCount = conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)
    conn.exec(`CREATE TRIGGER fail_canonical_mode_context_mirror BEFORE UPDATE OF content_storage_state ON messages
      WHEN NEW.id='write-live-next-user' AND NEW.content_storage_state='canonical-backed-dual-write'
      BEGIN SELECT RAISE(ABORT,'injected canonical mode context mirror failure'); END`)
    await expect(history.appendBatch(nextContext, 0)).rejects.toThrow('injected canonical mode context mirror failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toEqual(eventCount)
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('write-live-next-user'))
      .toEqual({ content: 'next', content_storage_state: 'legacy' })
    conn.exec('DROP TRIGGER fail_canonical_mode_context_mirror')
    await history.appendBatch(nextContext, 0)
    expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('write-live-next-user'))
      .toEqual({ content: 'next', content_storage_state: 'canonical-backed-dual-write' })
    expect(getDbConnection(db).prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ write_mode: 'canonical' })
    db.close()
  })

  it('writes edits to canonical History before the retained legacy copy and reads the edited body after recertification', async () => {
    const temp = createTempDatabase('canonical-message-edit-reopen-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      const session = createSession(temp.db, { name: 'canonical edit', model: 'test' })
      appendMessage(temp.db, { id: 'canonical-edit-user', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
      await writeCanonicalMessages(temp.db, session.id, [{ id: 'canonical-edit-user', role: 'user', content: 'before', timestamp: 1 }])
      expect(certifyCanonicalSessionApiRead(temp.db, session.id).status).toBe('eligible')
      const { enableCanonicalSessionWriteAuthority, writeCanonicalBackedMessageContent } = await import('./sessionContentWriteAuthority')
      expect(enableCanonicalSessionWriteAuthority(temp.db, session.id).status).toBe('enabled')
      expect(await writeCanonicalBackedMessageContent(temp.db, 'canonical-edit-user', 'after')).toBe(true)
      expect(getDbConnection(temp.db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('canonical-edit-user'))
        .toEqual({ content: 'after', content_storage_state: 'canonical-backed-dual-write' })
      temp.db.close()
      reopened = openDatabase(temp.dbPath)
      expect(certifyCanonicalSessionApiRead(reopened, session.id).status).toBe('eligible')
      setCanonicalApiReadFeatureEnabled(reopened, true)
      expect(readCanonicalApiContextIfEligible(reopened, session.id, undefined, 'canonical-edit-user', [])?.messages?.[0]?.content).toBe('after')
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })

  it('updates the session preview from canonical content when mirroring an edit to the last message', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical edit preview', model: 'test' })
    appendMessage(db, { id: 'canonical-edit-preview-user', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'canonical-edit-preview-user', role: 'user', content: 'before', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority, writeCanonicalBackedMessageContent } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    await expect(writeCanonicalBackedMessageContent(db, 'canonical-edit-preview-user', 'canonical preview body')).resolves.toBe(true)

    expect(getSession(db, session.id)?.preview).toBe('canonical preview body')
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('canonical-edit-preview-user'))
      .toEqual({ content: 'canonical preview body' })
    db.close()
  })

  it('rolls back canonical edits and legacy mirrors together if the sealed message mirror fails', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical edit rollback', model: 'test' })
    appendMessage(db, { id: 'canonical-edit-rollback-user', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'canonical-edit-rollback-user', role: 'user', content: 'before', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority, writeCanonicalBackedMessageContent } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    const conn = getDbConnection(db)
    const before = conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)
    conn.exec(`CREATE TRIGGER fail_canonical_edit_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='canonical-edit-rollback-user' AND NEW.content='after'
      BEGIN SELECT RAISE(ABORT,'injected canonical edit mirror failure'); END`)
    await expect(writeCanonicalBackedMessageContent(db, 'canonical-edit-rollback-user', 'after'))
      .rejects.toThrow('injected canonical edit mirror failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toEqual(before)
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('canonical-edit-rollback-user'))
      .toEqual({ content: 'before', content_storage_state: 'canonical-backed-dual-write' })
    db.close()
  })

  it('keeps canonical-write sessions readable from retained legacy copies after the read kill switch', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical write rollback read', model: 'test' })
    appendMessage(db, { id: 'canonical-rollback-read-user', sessionId: session.id, role: 'user', content: 'legacy retained', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'canonical-rollback-read-user', role: 'user', content: 'legacy retained', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    setCanonicalApiReadFeatureEnabled(db, false)
    expect(readCanonicalApiContextIfEligible(db, session.id, undefined, 'canonical-rollback-read-user', [])).toBeUndefined()
    expect(getTurnContext(db, session.id, undefined, 'canonical-rollback-read-user', [])[0]?.content).toBe('legacy retained')
    expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('canonical-rollback-read-user'))
      .toEqual({ content: 'legacy retained', content_storage_state: 'canonical-backed-dual-write' })
    expect(getDbConnection(db).prepare('SELECT write_mode,api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ write_mode: 'canonical', api_read_mode: 'legacy' })
    db.close()
  })

  it('refuses to edit a canonical-backed message when its retained legacy body has drifted', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical edit drift', model: 'test' })
    appendMessage(db, { id: 'canonical-edit-drift-user', sessionId: session.id, role: 'user', content: 'canonical body', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'canonical-edit-drift-user', role: 'user', content: 'canonical body', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority, writeCanonicalBackedMessageContent } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    getDbConnection(db).prepare('UPDATE messages SET content=? WHERE id=?').run('drifted legacy copy', 'canonical-edit-drift-user')
    expect(await writeCanonicalBackedMessageContent(db, 'canonical-edit-drift-user', 'user edit')).toBe(false)
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('canonical-edit-drift-user'))
      .toEqual({ content: 'drifted legacy copy' })
    db.close()
  })

  it('fails closed on legacy message edits if a canonical-only session loses its cutover row', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'missing cutover fence', model: 'test' })
    appendMessage(db, { id: 'missing-cutover-user', sessionId: session.id, role: 'user', content: 'canonical body', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'missing-cutover-user', role: 'user', content: 'canonical body', timestamp: 1 }])
    const conn = getDbConnection(db)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run('missing-cutover-user')
    conn.prepare('DELETE FROM session_message_content_cutover WHERE session_id=?').run(session.id)

    const { updateMessageContent } = await import('../database/operations')
    expect(() => updateMessageContent(db, 'missing-cutover-user', { content: 'legacy write after fence loss' }))
      .toThrow('canonical-backed-only message content is immutable')
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('missing-cutover-user'))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    db.close()
  })

  it('blocks legacy coordinator body mutations after canonical write authority while allowing metadata updates', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical write boundary', model: 'test' })
    appendMessage(db, { id: 'canonical-write-boundary-user', sessionId: session.id, role: 'user', content: 'canonical body', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'canonical-write-boundary-user', role: 'user', content: 'canonical body', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    const { updateMessageContent } = await import('../database/operations')
    expect(() => updateMessageContent(db, 'canonical-write-boundary-user', { content: 'legacy bypass' }))
      .toThrow('canonical write authority requires a canonical History append')
    expect(updateMessageContent(db, 'canonical-write-boundary-user', { thinking: 'metadata only' })?.message.content)
      .toBe('canonical body')
    expect(getDbConnection(db).prepare('SELECT content,thinking FROM messages WHERE id=?').get('canonical-write-boundary-user'))
      .toEqual({ content: 'canonical body', thinking: JSON.stringify({ ...'metadata only' }) })
    db.close()
  })

  it('rejects a canonical edit append prepared against a stale History watermark', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical edit CAS', model: 'test' })
    appendMessage(db, { id: 'canonical-cas-user', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
    await writeCanonicalMessages(db, session.id, [{ id: 'canonical-cas-user', role: 'user', content: 'before', timestamp: 1 }])
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    const before = getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id) as { count: number }
    await expect(history.appendBatch([
      { invocationId: 'stale-edit', turnId: 'stale-edit-turn', sequence: 1, schemaVersion: 1, eventId: 'stale-edit-context',
        idempotencyKey: 'stale-edit-context', kind: 'invocation-context-committed', payload: {
          messages: [{ id: 'canonical-cas-user', role: 'user', content: 'stale edit', timestamp: 1 }],
          canonicalWriteFence: { sessionGeneration: 'old-generation', sessionSeq: -1, commitOrder: -1,
            watermarkEventId: null, watermarkInvocationId: null }
        } },
      { invocationId: 'stale-edit', turnId: 'stale-edit-turn', sequence: 2, schemaVersion: 1, eventId: 'stale-edit-terminal',
        idempotencyKey: 'stale-edit-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)).rejects.toThrow(/canonical write fence/)
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toEqual(before)
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('canonical-cas-user')).toEqual({ content: 'before' })
    db.close()
  })
})
