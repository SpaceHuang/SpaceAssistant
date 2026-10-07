import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { appendMessage, createSession, getDbConnection, openDatabase } from '../database'
import { createAcceptedTurnFromPrepared as createAcceptedTurnFromPreparedWithPort, loadAcceptedTurnMessages as loadAcceptedTurnMessagesWithPort } from './acceptedTurnContext'
import { commitSessionTranscript } from '../database/sessionTranscript'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { queueInputFingerprint } from '../queueInputFingerprint'
import * as sessionStorageShadow from './sessionStorageShadow'
import * as sessionStorageMaintenance from '../sessionStorage/maintenance'
import * as sessionStorageCertification from '../sessionStorage/certification'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createSessionExecutionStore, loadAcceptedMessagesForTurn } from '../sessionStorage/execution'

function createAcceptedTurnFromPrepared(
  db: Parameters<typeof createSqliteSessionStorage>[0],
  prepared: Parameters<typeof createAcceptedTurnFromPreparedWithPort>[0],
  lane: Parameters<typeof createAcceptedTurnFromPreparedWithPort>[1],
  config: Parameters<typeof createAcceptedTurnFromPreparedWithPort>[2]
) {
  return createAcceptedTurnFromPreparedWithPort(prepared, lane, config, createSqliteSessionStorage(db).execution)
}

function loadAcceptedTurnMessages(db: Parameters<typeof createSqliteSessionStorage>[0], turn: Parameters<typeof loadAcceptedTurnMessagesWithPort>[0]) {
  const storage = createSqliteSessionStorage(db)
  const execution = storage.execution
  return execution.readTurn({ sessionId: turn.sessionId, turnId: turn.turnId })
    ? loadAcceptedTurnMessagesWithPort(turn, execution)
    : loadAcceptedMessagesForTurn(db, turn, storage.queries)
}

describe('createAcceptedTurnFromPrepared', () => {
  let db: ReturnType<typeof createMemoryAppDb>
  beforeEach(() => { db = createMemoryAppDb('zh-CN') })
  afterEach(() => db.close())

  it('freezes the prepared identity, execution config, and current transcript version', () => {
    const session = createSession(db, { name: 'accepted-turn' })
    commitSessionTranscript(db, { sessionId: session.id, turnId: 'prior-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'prior' }] })
    const config = { lane: 'feishu' as const, skillFragments: ['frozen'] }
    const accepted = createAcceptedTurnFromPrepared(db, {
      turnId: 'remote-turn', requestId: 'remote-request', sessionId: session.id, startToken: 'start-token',
      userMessage: { id: 'accepted-user' }
    }, 'feishu', config)
    config.skillFragments[0] = 'mutated'
    expect(accepted).toMatchObject({ turnId: 'remote-turn', requestId: 'remote-request', sessionId: session.id, lane: 'feishu', startToken: 'start-token', currentUserMessageId: 'accepted-user', transcriptVersion: 1 })
    expect(accepted.config.skillFragments).toEqual(['frozen'])
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(readAcceptedTurn(db, session.id, 'remote-request')).toEqual(accepted)
  })

  it('reuses the original accepted snapshot when the same prepared turn is retried after checkpoint advances', () => {
    const session = createSession(db, { name: 'accepted-turn-retry' })
    const prepared = { turnId: 'retry-turn', requestId: 'retry-request', sessionId: session.id, startToken: 'retry-token', userMessage: { id: 'retry-user' } }
    const first = createAcceptedTurnFromPrepared(db, prepared, 'feishu', { lane: 'feishu', model: 'frozen-model' })
    commitSessionTranscript(db, { sessionId: session.id, turnId: 'preceding-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'previous' }] })
    const retried = createAcceptedTurnFromPrepared(db, prepared, 'feishu', { lane: 'feishu', model: 'new-default' })
    expect(retried).toEqual(first)
    expect(retried.transcriptVersion).toBe(0)
    expect(retried.config.model).toBe('frozen-model')
  })

  it('rejects acceptance while the session checkpoint needs reconciliation', () => {
    const session = createSession(db, { name: 'blocked-session' })
    getDbConnection(db).prepare("INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,0,'blocked-turn','blocked',1)").run(session.id)
    expect(() => createAcceptedTurnFromPrepared(db, {
      turnId: 'new-turn', requestId: 'new-request', sessionId: session.id, startToken: 'token', userMessage: { id: 'user' }
    }, 'wechat', { lane: 'wechat' })).toThrow('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')
  })
})

describe('loadAcceptedTurnMessages Phase 5.2 shadow ordering', () => {
  let db: ReturnType<typeof createMemoryAppDb>
  beforeEach(() => { db = createMemoryAppDb('zh-CN'); vi.restoreAllMocks() })
  afterEach(() => db.close())

  it('通过注入的 SessionQueries 读取 accepted turn context', async () => {
    const session = createSession(db, { name: 'accepted-query-port' })
    const user = appendMessage(db, { id: 'accepted-query-user', sessionId: session.id, role: 'user', content: 'from query port', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'accepted-query-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    const accepted = createAcceptedTurnFromPrepared(db, {
      turnId: 'accepted-query-turn', requestId: 'accepted-query-request', sessionId: session.id,
      startToken: 'accepted-query-start', userMessage: { id: user.message.id }
    }, 'desktop', { lane: 'desktop' })
    getDbConnection(db).prepare(`INSERT INTO turns (turn_id,request_id,session_id,assistant_message_id,user_message_id,state,version,start_token,created_at,updated_at)
      VALUES(?,?,?,?,?,'prepared',0,?,1,1)`).run(accepted.turnId, accepted.requestId, session.id, assistant.message.id, user.message.id, accepted.startToken)
    const storage = createSqliteSessionStorage(db)
    const readTurnContext = vi.fn(storage.queries.readTurnContext)
    const queries = Object.freeze({ ...storage.queries, readTurnContext })
    const executionStore = createSessionExecutionStore(db, queries)
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 0, excludeMessageIds: [] } as never

    expect(executionStore.loadAcceptedMessages({ sessionId: session.id, turnId: turn.turnId })).toEqual([user.message])
    expect(readTurnContext).toHaveBeenCalledWith({
      sessionId: session.id, boundarySequence: null, requiredUserMessageId: user.message.id, excludeMessageIds: []
    })
  })

  async function seedAcceptedTurn(fingerprint: string) {
    const session = createSession(db, { name: 'accepted-shadow' })
    const user = appendMessage(db, { id: 'accepted-shadow-user', sessionId: session.id, role: 'user', content: 'accepted body', timestamp: 1, status: 'sent' })
    const accepted = createAcceptedTurn({
      turnId: 'accepted-shadow-turn', requestId: 'accepted-shadow-request', sessionId: session.id,
      lane: 'desktop', startToken: 'accepted-shadow-start', currentUserMessageId: user.message.id,
      transcriptVersion: 0, config: { lane: 'desktop' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 1, schemaVersion: 1,
      eventId: 'accepted-shadow-input', idempotencyKey: 'accepted-shadow-input', kind: 'session-input-committed',
      payload: { sessionId: session.id, messageId: user.message.id, role: 'user', inputFingerprint: fingerprint }
    }], 0)
    return { accepted, session, user }
  }

  it('通过 legacy 指纹校验后才以已接受指纹运行 canonical shadow', async () => {
    const content = 'accepted body'
    const fingerprint = queueInputFingerprint({ text: content })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-shadow-context', idempotencyKey: 'accepted-shadow-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content, timestamp: 1 }] }
    }], 1)
    const shadow = vi.spyOn(sessionStorageShadow, 'shadowAcceptedTurnContext')
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content }])
    expect(shadow).toHaveBeenCalledWith(db, session.id, expect.any(Array), { messageId: user.message.id, fingerprint })
    getDbConnection(db).prepare("UPDATE agent_history_events SET payload_json=replace(payload_json, 'accepted body', 'canonical drift') WHERE event_id='accepted-shadow-context'").run()
    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content }])
    expect(shadow.mock.results.at(-1)?.value).toMatchObject({ status: 'mismatched', fields: ['content', 'accepted-input-fingerprint'] })
  })

  it('只有完整逐会话认证后才让 accepted API context 读取 canonical 正文', async () => {
    const fingerprint = queueInputFingerprint({ text: 'accepted body' })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-cutover-context', idempotencyKey: 'accepted-cutover-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted body', timestamp: 1 }] }
    }], 1)
    sessionStorageCertification.setCanonicalApiReadFeatureEnabled(db, true)
    expect(sessionStorageCertification.certifyCanonicalSessionApiRead(db, session.id)).toMatchObject({
      status: 'eligible', apiReadMode: 'canonical', apiDifferenceCount: 0, routeDifferenceCount: 0
    })
    const canonicalRead = vi.spyOn(sessionStorageCertification, 'readCanonicalApiContextIfEligible')
    const duplicateShadow = vi.spyOn(sessionStorageShadow, 'shadowAcceptedTurnContext')
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content: 'accepted body' }])
    expect(canonicalRead).toHaveBeenCalledWith(db, session.id, undefined, user.message.id, [], { messageId: user.message.id, fingerprint })
    expect(duplicateShadow).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'canonical' })
  })

  it('旧正文已清空时先从 canonical-backed transcript 重建 accepted input，再验证持久指纹', async () => {
    const fingerprint = queueInputFingerprint({ text: 'accepted body' })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-cleared-context', idempotencyKey: 'accepted-cleared-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted body', timestamp: 1 }] }
    }], 1)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run(user.message.id)
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content: 'accepted body' }])
  })

  it('清理真实清空旧正文后关闭 API 读开关，accepted turn 仍从 canonical transcript 取正文', async () => {
    const priorDb = db
    const temp = createTempDatabase('accepted-turn-cleanup-killswitch-')
    db = temp.db
    try {
    const fingerprint = queueInputFingerprint({ text: 'accepted body' })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-cleanup-context', idempotencyKey: 'accepted-cleanup-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted body', timestamp: user.message.timestamp }] }
    }], 1)
    sessionStorageCertification.setCanonicalApiReadFeatureEnabled(db, true)
    expect(sessionStorageCertification.certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    const { enableCanonicalSessionWriteAuthority } = await import('./sessionContentWriteAuthority')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    expect(sessionStorageMaintenance.markSessionMessageContentWriteStopped(db, session.id)).toBe(true)
    expect(sessionStorageMaintenance.beginSessionMessageContentCleanup(db, session.id)).toBe(true)
    expect(sessionStorageMaintenance.clearNextSessionMessageContentBatch(db, session.id, 10))
      .toMatchObject({ status: 'complete', cleanedMessageCount: 1 })
    expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(user.message.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })

    sessionStorageCertification.setCanonicalApiReadFeatureEnabled(db, false)
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content: 'accepted body' }])
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get(user.message.id))
      .toEqual({ content: '' })
    expect(getDbConnection(db).prepare('SELECT cleanup_state,api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ cleanup_state: 'pending', api_read_mode: 'legacy' })
    db.close()
    db = openDatabase(temp.dbPath)
    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content: 'accepted body' }])
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get(user.message.id))
      .toEqual({ content: '' })
    } finally {
      try { db.close() } catch { /* cleanup closes the current handle */ }
      temp.cleanup()
      db = priorDb
    }
  })

  it('canonical-only + L1 miss 下持久 accepted-input 指纹漂移必须在返回正文前失败', async () => {
    const fingerprint = queueInputFingerprint({ text: 'accepted body' })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-fingerprint-drift-context', idempotencyKey: 'accepted-fingerprint-drift-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted body', timestamp: user.message.timestamp }] }
    }], 1)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run(user.message.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({
      sessionId: session.id, messageId: user.message.id, role: 'user', inputFingerprint: '0'.repeat(64)
    }), 'accepted-shadow-input')
    const shadow = vi.spyOn(sessionStorageShadow, 'shadowAcceptedTurnContext')
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(() => loadAcceptedTurnMessages(db, turn)).toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    expect(shadow).not.toHaveBeenCalled()
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(user.message.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
  })

  it('canonical-only accepted turn 遇到 History owner 漂移时必须拒绝，不能回退为空旧正文', async () => {
    const fingerprint = queueInputFingerprint({ text: 'accepted body' })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    const conn = getDbConnection(db)
    await new SqliteAgentHistory(conn, 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-owner-drift-context', idempotencyKey: 'accepted-owner-drift-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted body', timestamp: user.message.timestamp }] }
    }], 1)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run(user.message.id)
    conn.prepare('UPDATE agent_history_events SET session_id=? WHERE event_id=?').run('foreign-session', 'accepted-owner-drift-context')
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(() => loadAcceptedTurnMessages(db, turn)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(user.message.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
  })

  it('legacy required-user 指纹不匹配时在 shadow 读取前失败', async () => {
    const { accepted, session, user } = await seedAcceptedTurn('0'.repeat(64))
    const shadow = vi.spyOn(sessionStorageShadow, 'shadowAcceptedTurnContext')
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(() => loadAcceptedTurnMessages(db, turn)).toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    expect(shadow).not.toHaveBeenCalled()
  })

  it('在同一个事务快照中读取 legacy context、accepted-input History 并执行 shadow', async () => {
    const fingerprint = queueInputFingerprint({ text: 'accepted body' })
    const { accepted, session, user } = await seedAcceptedTurn(fingerprint)
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: accepted.turnId, turnId: accepted.turnId, sequence: 2, schemaVersion: 1,
      eventId: 'accepted-snapshot-context', idempotencyKey: 'accepted-snapshot-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted body', timestamp: 1 }] }
    }], 1)
    const transactionStates: boolean[] = []
    const originalReadSync = SqliteAgentHistory.prototype.readSync
    vi.spyOn(SqliteAgentHistory.prototype, 'readSync').mockImplementation(function (invocationId) {
      transactionStates.push(getDbConnection(db).isTransaction)
      return originalReadSync.call(this, invocationId)
    })
    const turn = { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: session.id, userMessageId: user.message.id,
      acceptedInputHistoryVersion: 1, excludeMessageIds: [] } as never

    expect(loadAcceptedTurnMessages(db, turn)).toMatchObject([{ id: user.message.id, content: 'accepted body' }])
    expect(transactionStates.length).toBeGreaterThan(0)
    expect(transactionStates.every(Boolean)).toBe(true)
  })
})
