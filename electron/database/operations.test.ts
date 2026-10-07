import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from './testHelpers'
import {
  appendMessage,
  appendMessagesAtomically,
  updateMessageContentIfStreaming,
  updateMessageContent,
  checkpointTurnAtomically,
  createSession,
  deleteSession,
  getApiContextBaseline,
  getTurnContext,
  getTurnContextSkeleton,
  getMessageSkeleton,
  getMessageSkeletons,
  getMessage,
  getSession,
  getChatMessagePage,
  getContextHistorySummaryBaseline,
  getMessagesPage,
  getRecentTurnRoutingMessages,
  hasVisionInTurnRoutingContext,
  listStreamingAssistantMessages,
  getPersistedTurn,
  failConfiguringTurn,
  hasActiveTurn,
  prepareTurnAtomically,
  listPersistedTurns,
  createPersistedTurn,
  createQueueInputReceipt,
  getQueueInputReceipt,
  enqueueQueuedUserMessage,
  deleteQueuedUserMessage,
  claimQueuedTurnAtomically,
  recoverPersistedTurn,
  updateQueueInputReceiptState,
  getNextQueuedMessage,
  getSearchCorpusPage,
  reorderQueuedUserMessages,
  updateQueuedUserMessageContent,
  resolveRetryContext,
  getSessionMessageRevisionSnapshot,
  setPersistedTurnExecutionConfig,
  updatePersistedTurnState,
  listTurnErrorsByAssistantMessageIds
  ,finalizeResidueMessageKeepingOutcome
} from './operations'
import { getDbConnection, type AppDatabase } from './sqliteStore'
import { setConfigValue } from './operations'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { openDatabase } from './index'

describe('appendMessage stored count', () => {
  it('keeps the stored session message counter equal to inserted rows across sequential appends', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'incremental-message-count' })
    appendMessage(db, { id: 'counter-a', sessionId: session.id, role: 'user', content: 'a', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'counter-b', sessionId: session.id, role: 'assistant', content: 'b', timestamp: 2, status: 'completed' })
    const conn = getDbConnection(db)
    expect(conn.prepare('SELECT message_count FROM sessions WHERE id=?').get(session.id)).toEqual({ message_count: 2 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(session.id)).toEqual({ count: 2 })
    db.close()
  })
})

describe('atomic turn continuation acceptance', () => {
  it('persists continuation acceptance and retry lineage with the accepted turn', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'atomic-continuation' })
    prepareTurnAtomically(db, {
      user: { id: 'continuation-user', sessionId: session.id, role: 'user', content: '继续修复', timestamp: 1, status: 'sent' },
      assistant: { id: 'continuation-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: {
        turnId: 'continuation-turn', requestId: 'continuation-request', sessionId: session.id,
        assistantMessageId: 'continuation-assistant', state: 'prepared', retryOfMessageId: 'failed-assistant',
        retryOfInvocationId: 'failed-invocation', continuationAcceptance: {
          payloadSha256: 'a'.repeat(64), rawText: '继续修复', kind: 'follow-up', route: 'context-turn',
          sourceInvocationId: 'failed-invocation', sourceTurnId: 'failed-turn', sourceSequence: 9
        }
      }
    })

    expect(getPersistedTurn(db, 'continuation-turn')).toMatchObject({
      retryOfMessageId: 'failed-assistant', retryOfInvocationId: 'failed-invocation'
    })
    expect(getDbConnection(db).prepare(`SELECT route,status,source_invocation_id,source_turn_id,source_sequence,target_id
      FROM continuation_intents WHERE request_id=?`).get('continuation-request')).toEqual({
      route: 'context-turn', status: 'accepted_turn', source_invocation_id: 'failed-invocation',
      source_turn_id: 'failed-turn', source_sequence: 9, target_id: 'continuation-turn'
    })
    expect(new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).readSync('continuation-turn').events[0]?.kind)
      .toBe('session-input-committed')
    db.close()
  })

  it('file-backed reopen preserves main session config, retry lineage, and atomic continuation acceptance', () => {
    const file = createTempDatabase('main-storage-operations-reopen-')
    try {
      const session = createSession(file.db, {
        name: 'operations-reopen', fixedWorkDir: '/workspace/project', thinkingEffort: 'high',
        ownership: 'user', visibility: 'primary'
      })
      prepareTurnAtomically(file.db, {
        user: { id: 'reopen-user', sessionId: session.id, role: 'user', content: 'continue', timestamp: 1, status: 'sent' },
        assistant: { id: 'reopen-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
        turn: {
          turnId: 'reopen-turn', requestId: 'reopen-request', sessionId: session.id,
          assistantMessageId: 'reopen-assistant', state: 'prepared', retryOfMessageId: 'failed-message',
          retryOfInvocationId: 'failed-invocation', continuationAcceptance: {
            payloadSha256: 'b'.repeat(64), rawText: 'continue', kind: 'follow-up', route: 'context-turn',
            sourceInvocationId: 'failed-invocation', sourceTurnId: 'failed-turn', sourceSequence: 4
          }
        }
      })
      const expectedGeneration = session.generation
      file.db.close()

      const reopened = openDatabase(file.dbPath)
      try {
        expect(getSession(reopened, session.id)).toMatchObject({
          fixedWorkDir: '/workspace/project', thinkingEffort: 'high', ownership: 'user', visibility: 'primary',
          generation: expectedGeneration
        })
        expect(getPersistedTurn(reopened, 'reopen-turn')).toMatchObject({
          retryOfMessageId: 'failed-message', retryOfInvocationId: 'failed-invocation'
        })
        expect(getDbConnection(reopened).prepare(`SELECT route,status,source_invocation_id,source_turn_id,source_sequence,target_id
          FROM continuation_intents WHERE request_id='reopen-request'`).get()).toEqual({
          route: 'context-turn', status: 'accepted_turn', source_invocation_id: 'failed-invocation',
          source_turn_id: 'failed-turn', source_sequence: 4, target_id: 'reopen-turn'
        })
        expect(getDbConnection(reopened).prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
        expect(getDbConnection(reopened).prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      file.cleanup()
    }
  })
})

describe('deleteSession persisted transcript cleanup', () => {
  it('keeps an active session and its records intact when deletion is requested', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'active-session-delete' })
    const assistant = appendMessage(db, { id: 'active-delete-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'active-delete-turn', requestId: 'active-delete-request', sessionId: session.id,
      assistantMessageId: assistant.message.id, state: 'executing' })
    expect(() => deleteSession(db, session.id, { flush: false })).toThrow('cannot delete a session with an active turn')
    expect(getSession(db, session.id)?.id).toBe(session.id)
    expect(getDbConnection(db).prepare('SELECT turn_id FROM turns WHERE turn_id=?').get('active-delete-turn')).toEqual({ turn_id: 'active-delete-turn' })
    db.close()
  })

  it('deletes owned History and transcript records durably without touching another or ambiguous session data', () => {
    const { db, dbPath, cleanup } = createTempDatabase('sa-delete-session-transcript-')
    const conn = getDbConnection(db)
    const owned = createSession(db, { name: 'owned' })
    const other = createSession(db, { name: 'other' })
    const now = Date.now()
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,?)')
    const insertEvent = conn.prepare('INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at) VALUES(?,1,?,?,?,1,?,?,?)')
    insertStream.run('owned-history', owned.id)
    insertEvent.run('owned-history', 'owned-event', 'owned-key', 'owned-turn', 'invocation-context-committed', JSON.stringify({ messages: [{ role: 'user', content: 'PRIVATE_HISTORY_SENTINEL' }] }), now)
    insertStream.run('other-history', other.id)
    insertEvent.run('other-history', 'other-event', 'other-key', 'other-turn', 'invocation-context-committed', JSON.stringify({ messages: [{ role: 'user', content: 'OTHER_HISTORY_SENTINEL' }] }), now)
    insertStream.run('bound-other-conflict', other.id)
    insertEvent.run('bound-other-conflict', 'conflicting-input', 'conflicting-input-key', 'conflicting-turn', 'session-input-committed', JSON.stringify({
      sessionId: owned.id, messageId: 'conflicting-user-message', role: 'user', inputFingerprint: 'conflicting-fingerprint'
    }), now)

    // An unbound legacy stream can be removed only when its committed input identifies one owner.
    conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,NULL)').run('legacy-owned-history')
    insertEvent.run('legacy-owned-history', 'legacy-input', 'legacy-input-key', 'legacy-turn', 'session-input-committed', JSON.stringify({
      sessionId: owned.id, messageId: 'legacy-user-message', role: 'user', inputFingerprint: 'legacy-fingerprint'
    }), now)
    insertEvent.run('legacy-orphan-event', 'orphan-input', 'orphan-input-key', 'orphan-turn', 'session-input-committed', JSON.stringify({
      sessionId: owned.id, messageId: 'orphan-user-message', role: 'user', inputFingerprint: 'orphan-fingerprint'
    }), now)
    conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,NULL)').run('ambiguous-history')
    insertEvent.run('ambiguous-history', 'ambiguous-input', 'ambiguous-input-key', 'ambiguous-turn', 'session-input-committed', JSON.stringify({
      sessionId: owned.id, messageId: 'ambiguous-user-message', role: 'user', inputFingerprint: 'ambiguous-fingerprint'
    }), now)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES(?,2,?,?,?,1,'invocation-completed',?,?)`).run('ambiguous-history', 'ambiguous-terminal', 'ambiguous-terminal-key', 'ambiguous-turn', JSON.stringify({
      status: 'completed', sessionLedger: { location: { sessionId: other.id, workDir: '/work', createdAt: now } }
    }), now)

    conn.prepare('INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,1,?,\'ready\',?)').run(owned.id, 'owned-turn', now)
    conn.prepare('INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at) VALUES(?,?,0,1,\'failed\',?,?)')
      .run(owned.id, 'owned-turn', JSON.stringify([{ role: 'user', content: 'PRIVATE_TRANSCRIPT_SENTINEL' }]), now)
    conn.prepare('INSERT INTO session_transcript_reconciliations(resolution_id,session_id,turn_id,resolved_version,resolution,operator_id,rationale,created_at) VALUES(?,?,?,1,\'commit-reviewed\',\'operator\',?,?)')
      .run('owned-resolution', owned.id, 'owned-turn', 'private rationale', now)
    conn.prepare('INSERT INTO accepted_turn_contexts(turn_id,session_id,request_id,accepted_turn_json,created_at) VALUES(?,?,?,?,?)')
      .run('owned-turn', owned.id, 'owned-request', JSON.stringify({ message: 'PRIVATE_ACCEPTED_TURN_SENTINEL' }), now)
    conn.prepare('INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at) VALUES(?,?,?,1,\'commit_uncertain\',?,?)')
      .run(owned.id, 'owned-turn', 'owner', now, now)
    conn.prepare('INSERT INTO session_execution_queue(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at) VALUES(?,?,?,1,\'commit_uncertain\',?,?)')
      .run(owned.id, 'owned-turn', 'owner', now, now)

    deleteSession(db, owned.id)
    db.close()

    const reopened = openDatabase(dbPath)
    const persisted = getDbConnection(reopened)
    expect(persisted.prepare('SELECT id FROM sessions WHERE id=?').get(owned.id)).toBeUndefined()
    for (const table of ['session_transcript_checkpoints', 'session_transcript_entries', 'session_transcript_reconciliations', 'accepted_turn_contexts', 'session_execution_claims', 'session_execution_queue']) {
      expect(persisted.prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`).get(owned.id), table).toBeUndefined()
    }
    expect(persisted.prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id=?').get('owned-history')).toBeUndefined()
    expect(persisted.prepare('SELECT invocation_id FROM agent_history_streams WHERE invocation_id=?').get('owned-history')).toBeUndefined()
    expect(persisted.prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id=?').get('legacy-owned-history')).toBeUndefined()
    expect(persisted.prepare('SELECT invocation_id FROM agent_history_streams WHERE invocation_id=?').get('legacy-owned-history')).toBeUndefined()
    expect(persisted.prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id=?').get('legacy-orphan-event')).toBeUndefined()
    expect(persisted.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id=?').get('other-history')).toEqual({ session_id: other.id })
    expect(persisted.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id=?').get('bound-other-conflict')).toEqual({ session_id: other.id })
    expect(persisted.prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id=?').get('bound-other-conflict')).toBeDefined()
    expect(persisted.prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id=?').get('ambiguous-history')).toBeDefined()
    reopened.close()
    cleanup()
  })

  it('rolls back session and History deletion together when a transcript cleanup fails', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'atomic-delete' })
    conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(\'atomic-history\',1,1,?)').run(session.id)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('atomic-history',1,'event','key','turn',1,'invocation-context-committed','{"messages":[{"role":"user","content":"PRIVATE_ATOMIC_SENTINEL"}]}',1)`).run()
    conn.prepare('INSERT INTO accepted_turn_contexts(turn_id,session_id,request_id,accepted_turn_json,created_at) VALUES(\'atomic-turn\',?,\'atomic-request\',\'{}\',1)').run(session.id)
    conn.exec(`CREATE TRIGGER fail_session_delete_cleanup BEFORE DELETE ON accepted_turn_contexts
      BEGIN SELECT RAISE(ABORT, 'forced cleanup failure'); END`)

    expect(() => deleteSession(db, session.id, { flush: false })).toThrow('forced cleanup failure')
    expect(conn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toEqual({ id: session.id })
    expect(conn.prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id=\'atomic-history\'').get()).toMatchObject({
      payload_json: expect.stringContaining('PRIVATE_ATOMIC_SENTINEL')
    })
    expect(conn.prepare('SELECT turn_id FROM accepted_turn_contexts WHERE session_id=?').get(session.id)).toEqual({ turn_id: 'atomic-turn' })
    db.close()
  })
})

describe('createSession 默认模型', () => {
  it('回退到配置里的默认模型，而不是写死的历史模型名', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.defaultModel', 'deepseek-v4-flash')

    const session = createSession(db, { name: 'no-model' })

    // 默认值必须来自配置（并归一到当前内置名），不能是已下线的 claude-sonnet-4-20250514
    expect(session.model).toBe('deepseek-flash')
  })

  it('显式传入的模型优先', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.defaultModel', 'deepseek-flash')

    expect(createSession(db, { name: 'explicit', model: 'deepseek-v4-pro' }).model).toBe('deepseek-v4-pro')
  })

  it('配置缺失时不写入任何历史模型名', () => {
    const db = createMemoryAppDb()
    expect(createSession(db, { name: 'empty-config' }).model).toBe('')
  })
})

describe('createSession fixed work directory', () => {
  it('persists and returns the session-specific fixed work directory', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'fixed-work-dir', fixedWorkDir: '/workspace/project' })
    expect(getDbConnection(db).prepare('SELECT fixed_work_dir FROM sessions WHERE id=?').get(session.id))
      .toEqual({ fixed_work_dir: '/workspace/project' })
    expect(getSession(db, session.id)?.fixedWorkDir).toBe('/workspace/project')
    db.close()
  })
})

describe('getMessagesPage', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('returns an empty page for a session with no messages', () => {
    const page = getMessagesPage(db, sessionId, 0, 10)
    expect(page).toEqual({ messages: [], nextSequence: 0 })
  })

  it('paginates strictly by sequence order across multiple pages until exhausted', () => {
    const total = 25
    for (let i = 0; i < total; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }

    const collected: string[] = []
    let cursor = 0
    for (;;) {
      const page = getMessagesPage(db, sessionId, cursor, 7)
      if (page.messages.length === 0) break
      collected.push(...page.messages.map((m) => m.id))
      cursor = page.nextSequence
    }

    expect(collected).toEqual(Array.from({ length: total }, (_, i) => `m${i}`))
  })

  it('does not skip or duplicate rows when a message is appended between page reads', () => {
    for (let i = 0; i < 5; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }

    const firstPage = getMessagesPage(db, sessionId, 0, 3)
    expect(firstPage.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])

    appendMessage(db, {
      id: 'm-new',
      sessionId,
      role: 'user',
      content: 'new',
      timestamp: 99,
      status: 'sent'
    })

    const secondPage = getMessagesPage(db, sessionId, firstPage.nextSequence, 10)
    expect(secondPage.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm-new'])
  })

  it('returns sequence ack from appendMessage', () => {
    const ack = appendMessage(db, {
      id: 'a1',
      sessionId,
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'sent'
    })
    expect(ack.sequence).toBe(0)
    expect(ack.message.id).toBe('a1')
  })
})

describe('turn routing context queries', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'routing' }).id
  })

  function insertLongHistory(total: number, imageSequence?: number): void {
    const conn = getDbConnection(db)
    const insert = conn.prepare(`INSERT INTO messages (
      id, session_id, role, content, tool_use, tool_calls, thinking,
      content_segments, skill_hints, attachments, images_delivered_to_api,
      status, schema_version, timestamp, sequence
    ) VALUES (?, ?, 'user', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, 'sent', 1, ?, ?)`)
    conn.exec('BEGIN')
    try {
      for (let sequence = 0; sequence < total; sequence++) {
        insert.run(
          `history-${sequence}`,
          sessionId,
          `message-${sequence}`,
          sequence === imageSequence ? '[{"id":"tail-image"}]' : null,
          sequence,
          sequence
        )
      }
      conn.exec('COMMIT')
    } catch (error) {
      conn.exec('ROLLBACK')
      throw error
    }
  }

  it('超过五万条历史时仍向 skill router 返回真正末尾的 50 条', () => {
    insertLongHistory(50_051)

    expect(getRecentTurnRoutingMessages(db, sessionId).map((message) => message.content)).toEqual(
      Array.from({ length: 50 }, (_, offset) => `message-${50_001 + offset}`)
    )
  })

  it('会从超长历史末尾识别图片，并尊重排除列表', () => {
    insertLongHistory(50_051, 50_050)

    expect(hasVisionInTurnRoutingContext(db, sessionId)).toBe(true)
    expect(hasVisionInTurnRoutingContext(db, sessionId, undefined, ['history-50050'])).toBe(false)
  })

  it('路由窗口 oracle 会拒绝先取尾部 50 条再过滤空白正文的实现', () => {
    // 方案 §8.8.2.1 要求严格正文解析和 TRIM 判空发生在 limit 之前；否则
    // 窗口尾部的空白消息会挤掉更早、仍应进入路由上下文的有效消息。
    insertLongHistory(52)
    getDbConnection(db).prepare("UPDATE messages SET content = '   ' WHERE id IN (?, ?)")
      .run('history-50', 'history-51')

    const expected = Array.from({ length: 50 }, (_, offset) => ({ role: 'user' as const, content: `message-${offset}` }))
    const actual = getRecentTurnRoutingMessages(db, sessionId)
    const intentionallyWrongLimitBeforeFilter = Array.from({ length: 50 }, (_, offset) => ({
      role: 'user' as const,
      content: offset < 48 ? `message-${offset + 2}` : '   '
    })).filter((message) => message.content.trim() !== '')

    expect(actual).toEqual(expected)
    expect(intentionallyWrongLimitBeforeFilter).not.toEqual(expected)
  })


  it('路由基线保留正文原字节、turn 锚点顺序、boundary/exclude 与 vision 附件语义', () => {
    const firstUser = appendMessage(db, { id: 'route-user', sessionId, role: 'user', content: '  exact user  ', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'route-assistant', sessionId, role: 'assistant', content: 'assistant', timestamp: 2, status: 'completed' })
    const outside = appendMessage(db, { id: 'route-outside', sessionId, role: 'user', content: 'outside', timestamp: 3, status: 'sent' })
    getDbConnection(db).prepare('UPDATE messages SET attachments = ? WHERE id = ?')
      .run(JSON.stringify([{ id: 'image', type: 'image' }]), firstUser.message.id)
    createPersistedTurn(db, {
      turnId: 'route-turn', requestId: 'route-request', sessionId,
      userMessageId: firstUser.message.id, assistantMessageId: assistant.message.id,
      state: 'terminal', outcome: 'completed'
    })

    expect(getRecentTurnRoutingMessages(db, sessionId, 50, outside.sequence))
      .toEqual([
        { role: 'user', content: '  exact user  ' },
        { role: 'assistant', content: 'assistant' },
        { role: 'user', content: 'outside' }
      ])
    expect(getRecentTurnRoutingMessages(db, sessionId, 50, firstUser.sequence, [firstUser.message.id])).toEqual([])
    expect(hasVisionInTurnRoutingContext(db, sessionId, outside.sequence)).toBe(true)
    expect(hasVisionInTurnRoutingContext(db, sessionId, outside.sequence, [firstUser.message.id])).toBe(false)
  })
})

describe('getTurnContext', () => {
  it('returns context and single-message skeletons without a synthetic content field', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'typed skeleton', model: 'test' })
    appendMessage(db, { id: 'typed-skeleton-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 1, status: 'sent' })

    const context = getTurnContextSkeleton(db, session.id, undefined, undefined, [])
    const single = getMessageSkeleton(db, 'typed-skeleton-user')
    const all = getMessageSkeletons(db, session.id)

    expect(context).toHaveLength(1)
    expect(single).toBeDefined()
    expect(all).toHaveLength(1)
    expect([...context, single!, ...all].every((message) => !Object.hasOwn(message, 'content'))).toBe(true)
    db.close()
  })

  it('无论 timestamp 如何逆序或相同都严格按 sequence 构建权威上下文', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'turn-sequence' })
    const old = appendMessage(db, { id: 'old', sessionId: session.id, role: 'user', content: 'old', timestamp: 300, status: 'sent' })
    appendMessage(db, { id: 'same-time-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 300, status: 'completed' })
    const current = appendMessage(db, { id: 'current', sessionId: session.id, role: 'user', content: 'current', timestamp: 1, status: 'sent' })
    getDbConnection(db).prepare('UPDATE messages SET sequence = 10 WHERE id = ?').run(current.message.id)

    const messages = getTurnContext(db, session.id, old.sequence + 1, current.message.id, [])

    expect(messages.map((message) => message.id)).toEqual(['old', 'same-time-assistant', 'current'])
  })

  it('Q1/Q2 过滤 queued 与 streaming 占位并按 turn 关联恢复连续队列因果顺序', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'causal-queue-context' })
    const aUser = appendMessage(db, { id: 'a-user', sessionId: session.id, role: 'user', content: 'A', timestamp: 1, status: 'sent' })
    const aAssistant = appendMessage(db, { id: 'a-assistant', sessionId: session.id, role: 'assistant', content: 'A final', timestamp: 2, status: 'completed' })
    const bUser = appendMessage(db, { id: 'b-user', sessionId: session.id, role: 'user', content: 'B', timestamp: 3, status: 'sent' })
    const cUser = appendMessage(db, { id: 'c-user', sessionId: session.id, role: 'user', content: 'C', timestamp: 4, status: 'queued' })
    const bAssistant = appendMessage(db, { id: 'b-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 5, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'a-turn', requestId: 'a-r', sessionId: session.id, userMessageId: aUser.message.id, assistantMessageId: aAssistant.message.id, state: 'terminal', outcome: 'completed' })
    createPersistedTurn(db, { turnId: 'b-turn', requestId: 'b-r', sessionId: session.id, userMessageId: bUser.message.id, assistantMessageId: bAssistant.message.id, contextBoundarySequence: cUser.sequence, state: 'prepared' })

    expect(getTurnContext(db, session.id, cUser.sequence, bUser.message.id, []).map((message) => message.id))
      .toEqual(['a-user', 'a-assistant', 'b-user'])

    updateMessageContentIfStreaming(db, bAssistant.message.id, { content: 'B final', status: 'completed' })
    getDbConnection(db).prepare("UPDATE turns SET state = 'terminal', outcome = 'completed' WHERE turn_id = 'b-turn'").run()
    getDbConnection(db).prepare("UPDATE messages SET status = 'sent' WHERE id = ?").run(cUser.message.id)
    const cAssistant = appendMessage(db, { id: 'c-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 6, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'c-turn', requestId: 'c-r', sessionId: session.id, userMessageId: cUser.message.id, assistantMessageId: cAssistant.message.id, contextBoundarySequence: bAssistant.sequence, state: 'prepared' })

    expect(getTurnContext(db, session.id, bAssistant.sequence, cUser.message.id, []).map((message) => message.id))
      .toEqual(['a-user', 'a-assistant', 'b-user', 'b-assistant', 'c-user'])

    updateMessageContentIfStreaming(db, cAssistant.message.id, { content: 'C final', status: 'completed' })
    getDbConnection(db).prepare("UPDATE turns SET state = 'terminal', outcome = 'completed' WHERE turn_id = 'c-turn'").run()
    const dUser = appendMessage(db, { id: 'd-user', sessionId: session.id, role: 'user', content: 'D', timestamp: 7, status: 'sent' })
    const dAssistant = appendMessage(db, { id: 'd-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 8, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'd-turn', requestId: 'd-r', sessionId: session.id, userMessageId: dUser.message.id, assistantMessageId: dAssistant.message.id, contextBoundarySequence: dUser.sequence, state: 'prepared' })

    expect(getTurnContext(db, session.id, dUser.sequence, dUser.message.id, []).map((message) => message.id))
      .toEqual(['a-user', 'a-assistant', 'b-user', 'b-assistant', 'c-user', 'c-assistant', 'd-user'])
    expect(getMessagesPage(db, session.id, 0, 20).messages.map((message) => message.id))
      .toEqual(['a-user', 'a-assistant', 'b-user', 'c-user', 'b-assistant', 'c-assistant', 'd-user', 'd-assistant'])
  })

  it('Q3 retry 按 turn 关联 B.user、排除失败 assistant 并保留其后的终态历史', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'causal-retry-context' })
    const bUser = appendMessage(db, { id: 'retry-b-user', sessionId: session.id, role: 'user', content: 'B', timestamp: 1, status: 'sent' })
    const cUser = appendMessage(db, { id: 'retry-c-user', sessionId: session.id, role: 'user', content: 'C', timestamp: 2, status: 'sent' })
    const failedB = appendMessage(db, { id: 'retry-b-failed', sessionId: session.id, role: 'assistant', content: 'partial B', timestamp: 3, status: 'failed' })
    const cAssistant = appendMessage(db, { id: 'retry-c-assistant', sessionId: session.id, role: 'assistant', content: 'C final', timestamp: 4, status: 'completed' })
    createPersistedTurn(db, { turnId: 'retry-b-old-turn', requestId: 'retry-b-old-r', sessionId: session.id, userMessageId: bUser.message.id, assistantMessageId: failedB.message.id, state: 'terminal', outcome: 'failed' })
    createPersistedTurn(db, { turnId: 'retry-c-turn', requestId: 'retry-c-r', sessionId: session.id, userMessageId: cUser.message.id, assistantMessageId: cAssistant.message.id, state: 'terminal', outcome: 'completed' })

    const context = getTurnContext(db, session.id, cAssistant.sequence, bUser.message.id, [failedB.message.id])

    expect(context.map((message) => message.id)).toEqual(['retry-b-user', 'retry-c-user', 'retry-c-assistant'])
    expect(context.filter((message) => message.id === bUser.message.id)).toHaveLength(1)
  })

  it('只允许 terminal turn 关联的 assistant 进入上下文，同时保留无关联 legacy assistant', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'assistant-turn-eligibility' })
    appendMessage(db, { id: 'legacy-user', sessionId: session.id, role: 'user', content: 'legacy U', timestamp: 0, status: 'sent' })
    const user = appendMessage(db, { id: 'eligible-user', sessionId: session.id, role: 'user', content: 'U', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'legacy-assistant', sessionId: session.id, role: 'assistant', content: 'legacy', timestamp: 2, status: 'completed' })
    const draftAssistant = appendMessage(db, { id: 'draft-assistant', sessionId: session.id, role: 'assistant', content: 'draft', timestamp: 3, status: 'completed' })
    const unboundDraftAssistant = appendMessage(db, { id: 'unbound-draft-assistant', sessionId: session.id, role: 'assistant', content: 'unbound draft', timestamp: 4, status: 'completed' })
    createPersistedTurn(db, { turnId: 'draft-turn', requestId: 'draft-r', sessionId: session.id, userMessageId: user.message.id, assistantMessageId: draftAssistant.message.id, state: 'executing' })
    createPersistedTurn(db, { turnId: 'unbound-draft-turn', requestId: 'unbound-draft-r', sessionId: session.id, assistantMessageId: unboundDraftAssistant.message.id, state: 'prepared' })

    expect(getTurnContext(db, session.id, unboundDraftAssistant.sequence, user.message.id, []).map((message) => message.id))
      .toEqual(['legacy-user', 'legacy-assistant', 'eligible-user'])
  })
})

describe('appendMessagesAtomically', () => {
  it('uses one transaction and preserves sequence order', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'atomic' })
    const rows = appendMessagesAtomically(db, [
      { id: 'atomic-u', sessionId: session.id, role: 'user', content: 'u', timestamp: 1, status: 'sent' },
      { id: 'atomic-a', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' }
    ])
    expect(rows.map((row) => [row.message.id, row.sequence])).toEqual([['atomic-u', 0], ['atomic-a', 1]])
  })

  it('rolls back every message if one append fails', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'rollback' })
    expect(() => appendMessagesAtomically(db, [
      { id: 'same', sessionId: session.id, role: 'user', content: 'first', timestamp: 1, status: 'sent' },
      { id: 'same', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' }
    ])).toThrow()
    expect(getMessagesPage(db, session.id, 0, 10).messages).toEqual([])
  })
})

describe('updateMessageContentIfStreaming', () => {
  it('只更新 streaming assistant，终态更新返回 null', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'conditional' })
    appendMessage(db, { id: 'conditional-a', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    expect(updateMessageContentIfStreaming(db, 'conditional-a', { content: 'done', status: 'completed' })?.message.content).toBe('done')
    expect(updateMessageContentIfStreaming(db, 'conditional-a', { content: 'late', status: 'completed' })).toBeNull()
  })

  it('checkpointTurnAtomically 按 expected version 拒绝重复 checkpoint', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'checkpoint-version' })
    appendMessage(db, { id: 'checkpoint-a', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'checkpoint-t', requestId: 'checkpoint-r', sessionId: session.id, assistantMessageId: 'checkpoint-a', state: 'executing' })
    expect(checkpointTurnAtomically(db, 'checkpoint-t', 1, 'checkpoint-a', { content: 'one' })).toBe(true)
    expect(checkpointTurnAtomically(db, 'checkpoint-t', 2, 'checkpoint-a', { content: 'two' })).toBe(true)
    expect(checkpointTurnAtomically(db, 'checkpoint-t', 1, 'checkpoint-a', { content: 'late' })).toBe(false)
    expect(checkpointTurnAtomically(db, 'checkpoint-t', 2, 'checkpoint-a', { content: 'duplicate' })).toBe(false)
    expect(checkpointTurnAtomically(db, 'checkpoint-t', 10_000, 'checkpoint-a', { content: 'coalesced' })).toBe(true)
    expect(getMessage(db, 'checkpoint-a')?.content).toBe('coalesced')
    expect(getPersistedTurn(db, 'checkpoint-t')?.version).toBe(10_000)
  })

  it('streaming checkpoint 保留 legacy 正文状态并撤销旧 canonical 资格', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'checkpoint-content-cutover' })
    appendMessage(db, { id: 'checkpoint-cutover-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'checkpoint-cutover-turn', requestId: 'checkpoint-cutover-request', sessionId: session.id,
      assistantMessageId: 'checkpoint-cutover-assistant', state: 'executing' })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical',write_mode='dual-write'
      WHERE session_id=?`).run(session.id)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(session.id, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,1,1,1,'watermark','invocation',1,1)`)
      .run(session.id, generation.generation)

    expect(checkpointTurnAtomically(db, 'checkpoint-cutover-turn', 1, 'checkpoint-cutover-assistant', { content: 'partial checkpoint' })).toBe(true)

    expect(conn.prepare('SELECT content,content_storage_state,status FROM messages WHERE id=?').get('checkpoint-cutover-assistant'))
      .toEqual({ content: 'partial checkpoint', content_storage_state: 'legacy', status: 'streaming' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required', write_mode: 'dual-write', cleanup_state: 'retained' })
    db.close()
  })
})

describe('listStreamingAssistantMessages', () => {
  it('只返回 assistant streaming 行', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'recovery-list' })
    appendMessage(db, { id: 'recover-user', sessionId: session.id, role: 'user', content: 'u', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'recover-stream', sessionId: session.id, role: 'assistant', content: 'a', timestamp: 2, status: 'streaming' })
    appendMessage(db, { id: 'recover-done', sessionId: session.id, role: 'assistant', content: 'd', timestamp: 3, status: 'completed' })
    expect(listStreamingAssistantMessages(db).map((message) => message.id)).toEqual(['recover-stream'])
  })
})

describe('persisted turns', () => {
  it('补偿残留消息时降级活动工具调用但不改 turns outcome', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'residue-compensation' })
    appendMessage(db, { id: 'residue-a', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming', toolCalls: [{ id: 'tool-1', toolName: 'run_shell', input: {}, status: 'executing', riskLevel: 'low' }] })
    createPersistedTurn(db, { turnId: 'residue-turn', requestId: 'residue-r', sessionId: session.id, assistantMessageId: 'residue-a', state: 'terminal', version: 2, outcome: 'cancelled' })
    expect(finalizeResidueMessageKeepingOutcome(db, 'residue-a', 'cancelled')).toBe(true)
    expect(getMessage(db, 'residue-a')).toMatchObject({ status: 'cancelled', toolCalls: [{ status: 'failed', interrupted: true }] })
    expect(getPersistedTurn(db, 'residue-turn')).toMatchObject({ outcome: 'cancelled', state: 'terminal' })
  })
  it('补偿已完成终态残留时保留工具调用状态并写入 completed', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'completed-residue-compensation' })
    appendMessage(db, { id: 'completed-residue-assistant', sessionId: session.id, role: 'assistant', content: 'canonical final', timestamp: 1, status: 'streaming', toolCalls: [{ id: 'tool-1', toolName: 'run_shell', input: {}, status: 'completed', result: { success: true, output: 'ok' } }] })
    createPersistedTurn(db, { turnId: 'completed-residue-turn', requestId: 'completed-residue-request', sessionId: session.id, assistantMessageId: 'completed-residue-assistant', state: 'terminal', version: 2, outcome: 'completed' })

    expect(finalizeResidueMessageKeepingOutcome(db, 'completed-residue-assistant', 'completed')).toBe(true)
    expect(getMessage(db, 'completed-residue-assistant')).toMatchObject({
      status: 'completed', content: 'canonical final',
      toolCalls: [{ id: 'tool-1', status: 'completed', result: { success: true } }]
    })
    expect(getPersistedTurn(db, 'completed-residue-turn')).toMatchObject({ outcome: 'completed', state: 'terminal' })
  })
  it('canonical-only 下补偿 terminal/failed 残留仅更新骨架状态并保留 canonical 正文', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical-terminal-residue' })
    appendMessage(db, { id: 'canonical-terminal-residue-assistant', sessionId: session.id, role: 'assistant', content: 'canonical final', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'canonical-terminal-residue-turn', requestId: 'canonical-terminal-residue-request', sessionId: session.id, assistantMessageId: 'canonical-terminal-residue-assistant', state: 'terminal', version: 2, outcome: 'failed' })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run('canonical-terminal-residue-assistant')

    expect(finalizeResidueMessageKeepingOutcome(db, 'canonical-terminal-residue-assistant', 'failed')).toBe(true)
    expect(conn.prepare('SELECT content,status,content_storage_state FROM messages WHERE id=?').get('canonical-terminal-residue-assistant'))
      .toEqual({ content: '', status: 'failed', content_storage_state: 'canonical-backed-only' })
    expect(getPersistedTurn(db, 'canonical-terminal-residue-turn')).toMatchObject({ outcome: 'failed', state: 'terminal' })
  })
  it('can read turns by id and list by lifecycle state', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'turns' })
    appendMessage(db, { id: 'turn-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'turn-1', requestId: 'request-1', sessionId: session.id, assistantMessageId: 'turn-assistant', state: 'prepared', version: 3, outcome: 'completed', usage: { input: 2 } })
    expect(getPersistedTurn(db, 'turn-1')).toMatchObject({ requestId: 'request-1', assistantMessageId: 'turn-assistant' })
    expect(getPersistedTurn(db, 'turn-1')).toMatchObject({ version: 3, outcome: 'completed', usage: { input: 2 } })
    expect(listPersistedTurns(db, 'prepared')).toHaveLength(1)
    expect(listPersistedTurns(db, 'terminal')).toEqual([])
  })
})

describe('queue input receipts', () => {
  it('按 session/request 唯一保存并在消息删除后保留去重凭证', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'queue-receipt' })
    createQueueInputReceipt(db, { sessionId: session.id, requestId: 'queue-r', fingerprint: 'sha256:x', state: 'queued' })
    expect(getQueueInputReceipt(db, session.id, 'queue-r')).toMatchObject({ fingerprint: 'sha256:x', state: 'queued' })
    expect(() => createQueueInputReceipt(db, { sessionId: session.id, requestId: 'queue-r', fingerprint: 'different', state: 'queued' })).toThrow()
  })

  it('enqueue 同时写入 queued message 和 receipt，重复请求返回同一消息', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'queue-enqueue' })
    const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'enqueue-r', content: ' hello ' })
    const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'enqueue-r', content: 'hello' })
    expect(second.duplicate).toBe(true)
    expect(second.persisted.message.id).toBe(first.persisted.message.id)
    expect(getDbConnection(db).prepare('SELECT content,content_storage_state,status FROM messages WHERE id=?').get(first.persisted.message.id))
      .toEqual({ content: 'hello', content_storage_state: 'legacy', status: 'queued' })
    expect(() => enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'enqueue-r', content: 'different' })).toThrow(/FINGERPRINT/)
  })

  it('queued enqueue 撤销会话既有 canonical eligibility 并保留 legacy 正文', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'queued-content-cutover' })
    appendMessage(db, { id: 'queued-cutover-existing-user', sessionId: session.id, role: 'user', content: 'existing', timestamp: 1, status: 'sent' })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical',write_mode='dual-write'
      WHERE session_id=?`).run(session.id)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(session.id, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,1,1,1,'watermark','invocation',1,1)`)
      .run(session.id, generation.generation)

    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'queued-cutover-request', content: 'queued payload' })

    expect(queued.persisted.message).toMatchObject({ content: 'queued payload', status: 'queued' })
    expect(conn.prepare('SELECT content,content_storage_state,status FROM messages WHERE id=?').get(queued.persisted.message.id))
      .toEqual({ content: 'queued payload', content_storage_state: 'legacy', status: 'queued' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required', write_mode: 'dual-write', cleanup_state: 'retained' })
    db.close()
  })

  it('队列 no-op 移序保留 eligibility，实际移序通过 message trigger 撤销两类资格', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'queued-reorder-content-fence' })
    const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'reorder-first', content: 'first' })
    const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'reorder-second', content: 'second' })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    const revision = conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(session.id) as { message_revision: number }
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(session.id, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version)
      VALUES(?,?,?,1,1,'reorder-watermark','reorder-invocation',1,1)`).run(session.id, generation.generation, revision.message_revision)

    expect(reorderQueuedUserMessages(db, { sessionId: session.id, messageIds: [first.persisted.message.id, second.persisted.message.id] }).ok).toBe(true)
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeDefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeDefined()
    expect(conn.prepare('SELECT message_revision,api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ message_revision: revision.message_revision, api_read_mode: 'canonical' })

    expect(reorderQueuedUserMessages(db, { sessionId: session.id, messageIds: [second.persisted.message.id, first.persisted.message.id] }).ok).toBe(true)
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    const invalidated = conn.prepare('SELECT message_revision,api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id) as
      { message_revision: number; api_read_mode: string }
    expect(invalidated.api_read_mode).toBe('revalidation-required')
    expect(invalidated.message_revision).toBeGreaterThan(revision.message_revision)
    expect(conn.prepare('SELECT id,sequence,status,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence').all(session.id))
      .toEqual([
        { id: second.persisted.message.id, sequence: first.persisted.sequence, status: 'queued', content_storage_state: 'legacy' },
        { id: first.persisted.message.id, sequence: second.persisted.sequence, status: 'queued', content_storage_state: 'legacy' }
      ])
    db.close()
  })

  it('队列移序后的 preview 写入失败时回滚 sequence、receipt 和 eligibility fence', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'queued reorder rollback' })
    const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'reorder-rollback-first', content: 'first' })
    const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'reorder-rollback-second', content: 'second' })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    const revision = conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(session.id) as { message_revision: number }
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(session.id, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version)
      VALUES(?,?,?,1,1,'reorder-rollback-watermark','reorder-rollback-invocation',1,1)`).run(session.id, generation.generation, revision.message_revision)
    const before = conn.prepare('SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence').all(session.id)
    const preview = getSession(db, session.id)?.preview
    conn.exec(`CREATE TRIGGER reject_reorder_preview BEFORE UPDATE OF preview ON sessions
      WHEN NEW.id='${session.id}' BEGIN SELECT RAISE(ABORT,'injected preview failure'); END`)

    expect(() => reorderQueuedUserMessages(db, { sessionId: session.id, messageIds: [second.persisted.message.id, first.persisted.message.id] }))
      .toThrow('injected preview failure')

    expect(conn.prepare('SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence').all(session.id)).toEqual(before)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(session.id)).toEqual({ count: 2 })
    expect(getSession(db, session.id)?.preview).toBe(preview)
    expect(getQueueInputReceipt(db, session.id, 'reorder-rollback-first')?.state).toBe('queued')
    expect(getQueueInputReceipt(db, session.id, 'reorder-rollback-second')?.state).toBe('queued')
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeDefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeDefined()
    db.close()
  })

  it('receipt 状态可标记 cancelled，保留请求去重记录', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'queue-cancel-receipt' })
    createQueueInputReceipt(db, { sessionId: session.id, requestId: 'cancel-r', fingerprint: 'x', state: 'queued' })
    expect(updateQueueInputReceiptState(db, session.id, 'cancel-r', 'cancelled')).toBe(true)
    expect(getQueueInputReceipt(db, session.id, 'cancel-r')?.state).toBe('cancelled')
  })

  it('claim queued turn 原子更新 user、assistant、turn 和 receipt', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'queue-claim' })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'claim-r', content: 'queued' })
    const claimed = claimQueuedTurnAtomically(db, { sessionId: session.id, userMessageId: queued.persisted.message.id, turnId: 'claim-t', assistantMessageId: 'claim-a', requestId: 'claim-r', startToken: 'claim-token', intentFingerprint: 'intent:claim' })
    expect(claimed.user.message.status).toBe('sent')
    expect(claimed.assistant.message.status).toBe('streaming')
    expect(getQueueInputReceipt(db, session.id, 'claim-r')).toMatchObject({ state: 'claimed', turnId: 'claim-t' })
    expect(getPersistedTurn(db, 'claim-t')).toMatchObject({ userMessageId: queued.persisted.message.id, assistantMessageId: 'claim-a', startToken: 'claim-token', intentFingerprint: 'intent:claim' })
  })

  it('recoverPersistedTurn 原子收敛 assistant、turn 和 claimed receipt', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'queue-recover' })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'recover-r', content: 'queued' })
    claimQueuedTurnAtomically(db, { sessionId: session.id, userMessageId: queued.persisted.message.id, turnId: 'recover-t', assistantMessageId: 'recover-a', requestId: 'recover-r' })
    expect(recoverPersistedTurn(db, 'recover-t', 'recover-a')).toBe(true)
    expect(getMessage(db, 'recover-a')?.status).toBe('failed')
    expect(getPersistedTurn(db, 'recover-t')).toMatchObject({ state: 'terminal', outcome: 'recovered', version: 1 })
    expect(getQueueInputReceipt(db, session.id, 'recover-r')?.state).toBe('recovered')
  })

  it('turn recovery preserves the legacy body and revokes API and projection eligibility', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'recover-content-fence' })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'recover-content-fence-request', content: 'accepted question' })
    claimQueuedTurnAtomically(db, { sessionId: session.id, userMessageId: queued.persisted.message.id, turnId: 'recover-content-fence-turn', assistantMessageId: 'recover-content-fence-assistant', requestId: 'recover-content-fence-request' })
    updateMessageContentIfStreaming(db, 'recover-content-fence-assistant', { content: 'partial answer' })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(session.id) as { generation: string }
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(session.id, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version)
      VALUES(?,?,1,1,1,'watermark','invocation',1,1)`).run(session.id, generation.generation)

    expect(recoverPersistedTurn(db, 'recover-content-fence-turn', 'recover-content-fence-assistant')).toBe(true)

    expect(getMessage(db, 'recover-content-fence-assistant')).toMatchObject({ content: 'partial answer', status: 'failed' })
    expect(getPersistedTurn(db, 'recover-content-fence-turn')).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    expect(getQueueInputReceipt(db, session.id, 'recover-content-fence-request')?.state).toBe('recovered')
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(session.id))
      .toEqual({ api_read_mode: 'revalidation-required' })
    db.close()
  })

  it.each(['completed', 'failed', 'cancelled', 'timed-out', 'recovered', 'commit-uncertain'] as const)(
    'canonical-only recovery preserves History body while converging %s outcome metadata', async (outcome) => {
      const db = createMemoryAppDb()
      const session = createSession(db, { name: `canonical recovery ${outcome}` })
      appendMessage(db, { id: `canonical-recovery-user-${outcome}`, sessionId: session.id, role: 'user', content: 'accepted input', timestamp: 1, status: 'sent' })
      appendMessage(db, {
        id: `canonical-recovery-assistant-${outcome}`, sessionId: session.id, role: 'assistant', content: 'canonical answer',
        timestamp: 2, status: 'failed', toolCalls: [{ id: 'tool-done', toolName: 'read_file', input: {}, status: 'completed', riskLevel: 'low' }]
      })
      createPersistedTurn(db, {
        turnId: `canonical-recovery-turn-${outcome}`, requestId: `canonical-recovery-request-${outcome}`, sessionId: session.id,
        userMessageId: `canonical-recovery-user-${outcome}`, assistantMessageId: `canonical-recovery-assistant-${outcome}`, state: 'executing'
      })
      const conn = getDbConnection(db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: `canonical-recovery-invocation-${outcome}`, turnId: `canonical-recovery-turn-${outcome}`, sequence: 1, schemaVersion: 1,
        eventId: `canonical-recovery-context-${outcome}`, idempotencyKey: `canonical-recovery-context-${outcome}`,
        kind: 'invocation-context-committed',
        payload: { messages: [
          { id: `canonical-recovery-user-${outcome}`, role: 'user', content: 'accepted input', timestamp: 1 },
          { id: `canonical-recovery-assistant-${outcome}`, role: 'assistant', content: 'canonical answer', timestamp: 2 }
        ] }
      }], 0)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

      expect(recoverPersistedTurn(db, `canonical-recovery-turn-${outcome}`, `canonical-recovery-assistant-${outcome}`, {
        outcome, ...(outcome === 'completed' ? { completed: true } : {})
      })).toBe(true)

      expect(getMessage(db, `canonical-recovery-assistant-${outcome}`)).toMatchObject({
        content: '', status: outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed',
        toolCalls: [{ id: 'tool-done', status: 'completed' }]
      })
      expect(getPersistedTurn(db, `canonical-recovery-turn-${outcome}`)).toMatchObject({ state: 'terminal', outcome })
      expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched', messages: [
        { id: `canonical-recovery-user-${outcome}`, content: 'accepted input' },
        { id: `canonical-recovery-assistant-${outcome}`, content: 'canonical answer' }
      ] })
      db.close()
    }
  )

  it.each(['calling', 'confirming', 'executing'] as const)('completed recovery refuses pending %s tool calls without partial writes', (status) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `queue-completed-recover-${status}` })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: `completed-recover-${status}`, content: 'queued' })
    claimQueuedTurnAtomically(db, { sessionId: session.id, userMessageId: queued.persisted.message.id, turnId: `completed-turn-${status}`, assistantMessageId: `completed-assistant-${status}`, requestId: `completed-recover-${status}` })
    updateMessageContentIfStreaming(db, `completed-assistant-${status}`, { toolCalls: [{ id: 'pending-tool', toolName: 'write_file', input: { path: 'x' }, status, riskLevel: 'low' }] })

    expect(recoverPersistedTurn(db, `completed-turn-${status}`, `completed-assistant-${status}`, { completed: true, completedOutputText: 'canonical output' })).toBe(false)
    expect(getMessage(db, `completed-assistant-${status}`)).toMatchObject({ status: 'streaming', content: '', toolCalls: [{ id: 'pending-tool', status }] })
    expect(getPersistedTurn(db, `completed-turn-${status}`)).toMatchObject({ state: 'prepared', version: 0 })
    expect(getQueueInputReceipt(db, session.id, `completed-recover-${status}`)?.state).toBe('claimed')

    expect(recoverPersistedTurn(db, `completed-turn-${status}`, `completed-assistant-${status}`)).toBe(true)
    expect(getMessage(db, `completed-assistant-${status}`)).toMatchObject({ status: 'failed', toolCalls: [{ id: 'pending-tool', status: 'failed', interrupted: true }] })
    expect(getPersistedTurn(db, `completed-turn-${status}`)).toMatchObject({ state: 'terminal', outcome: 'recovered', version: 1 })
    expect(getQueueInputReceipt(db, session.id, `completed-recover-${status}`)?.state).toBe('recovered')
  })

  it('recoverPersistedTurn 也收敛重启前等待确认的 turn，避免重试被 busy 阻断', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'confirm-recover' })
    const user = appendMessage(db, { id: 'confirm-user', sessionId: session.id, role: 'user', content: 'confirm', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'confirm-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'confirm-turn', requestId: 'confirm-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: 'confirm-assistant', state: 'waiting-confirm'
    })
    expect(recoverPersistedTurn(db, 'confirm-turn', 'confirm-assistant')).toBe(true)
    expect(getMessage(db, 'confirm-assistant')?.status).toBe('failed')
    expect(getPersistedTurn(db, 'confirm-turn')).toMatchObject({ state: 'terminal', outcome: 'recovered' })
  })

  it('recoverPersistedTurn 收敛 assistant 已被旧启动清理标为 failed 的 prepared turn', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'failed-prepared-recover' })
    appendMessage(db, { id: 'failed-prepared-user', sessionId: session.id, role: 'user', content: 'retry', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'failed-prepared-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'failed' })
    createPersistedTurn(db, {
      turnId: 'failed-prepared-turn', requestId: 'failed-prepared-request', sessionId: session.id,
      assistantMessageId: 'failed-prepared-assistant', state: 'prepared'
    })
    expect(recoverPersistedTurn(db, 'failed-prepared-turn', 'failed-prepared-assistant')).toBe(true)
    expect(getPersistedTurn(db, 'failed-prepared-turn')).toMatchObject({ state: 'terminal', outcome: 'recovered' })
  })

  it('turn recovery fields survive SQLite round-trip', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'turn-recovery-fields' })
    appendMessage(db, { id: 'recovery-fields-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 1, status: 'failed' })
    createPersistedTurn(db, {
      turnId: 'recovery-fields-turn', requestId: 'recovery-fields-request', sessionId: session.id,
      assistantMessageId: 'recovery-fields-assistant', state: 'terminal', version: 4,
      outcome: 'failed', usage: { input_tokens: 3 }, error: { code: 'PROVIDER_FAILED', message: 'provider failed' },
      intentFingerprint: 'sha256:intent', startToken: 'start-token'
    })
    expect((getDbConnection(db).prepare('SELECT usage_json AS usageJson, terminal_usage_json AS terminalUsageJson FROM turns WHERE turn_id = ?').get('recovery-fields-turn') as { usageJson: string | null; terminalUsageJson: string | null })).toEqual({ usageJson: null, terminalUsageJson: JSON.stringify({ input_tokens: 3 }) })
    expect(getPersistedTurn(db, 'recovery-fields-turn')).toMatchObject({
      version: 4, outcome: 'failed', usage: { input_tokens: 3 },
      error: { code: 'PROVIDER_FAILED', message: 'provider failed' }, intentFingerprint: 'sha256:intent', startToken: 'start-token'
    })
  })
})

describe('turn prepare and canonical History atomicity', () => {
  it('rejects configuring a turn when the session generation or message revision changes during preparation', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'turn-config-session-fence' }).id
    appendMessage(db, { id: 'turn-config-fence-user', sessionId, role: 'user', content: 'before route', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'turn-config-fence-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'turn-config-fence-turn', requestId: 'turn-config-fence-request', sessionId,
      userMessageId: 'turn-config-fence-user', assistantMessageId: 'turn-config-fence-assistant', state: 'configuring' })
    const snapshot = getSessionMessageRevisionSnapshot(db, sessionId)!
    updateMessageContent(db, 'turn-config-fence-user', { content: 'edited while route awaited' })

    expect(setPersistedTurnExecutionConfig(db, 'turn-config-fence-turn', { lane: 'desktop', model: 'deepseek-chat' }, '{}', {
      ...snapshot
    })).toBe(false)
    expect(getPersistedTurn(db, 'turn-config-fence-turn')).toMatchObject({ state: 'configuring' })
    expect(getPersistedTurn(db, 'turn-config-fence-turn')?.executionConfig).toBeUndefined()

    createPersistedTurn(db, { turnId: 'turn-config-generation-fence', requestId: 'turn-config-generation-request', sessionId,
      userMessageId: 'turn-config-fence-user', assistantMessageId: 'turn-config-fence-assistant', state: 'configuring' })
    const generationSnapshot = getSessionMessageRevisionSnapshot(db, sessionId)!
    getDbConnection(db).prepare('UPDATE sessions SET generation=? WHERE id=?').run('recreated-generation', sessionId)
    expect(setPersistedTurnExecutionConfig(db, 'turn-config-generation-fence', { lane: 'desktop', model: 'deepseek-chat' }, '{}', generationSnapshot)).toBe(false)
    expect(getPersistedTurn(db, 'turn-config-generation-fence')).toMatchObject({ state: 'configuring' })
    db.close()
  })

  it('commits the user input identity to the session-bound invocation History in the prepare transaction', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'atomic-history-success' }).id
    const prepared = prepareTurnAtomically(db, {
      user: { id: 'input-user', sessionId, role: 'user', content: 'sensitive text is not copied', timestamp: 1, status: 'sent' },
      assistant: { id: 'input-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'input-turn', requestId: 'input-request', sessionId, assistantMessageId: 'input-assistant', state: 'prepared' }
    })
    const snapshot = new SqliteAgentHistory(getDbConnection(db)).readLatestCompletedInvocationForSession(sessionId)

    expect(prepared.user.message.id).toBe('input-user')
    expect(getPersistedTurn(db, 'input-turn')?.acceptedInputHistoryVersion).toBe(1)
    expect(await snapshot).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id = ?').get('input-turn')).toEqual({ session_id: sessionId })
    expect(getDbConnection(db).prepare('SELECT kind, payload_json FROM agent_history_events WHERE invocation_id = ?').get('input-turn'))
      .toMatchObject({ kind: 'session-input-committed' })
    const persisted = getDbConnection(db).prepare('SELECT payload_json FROM agent_history_events WHERE invocation_id = ?').get('input-turn') as { payload_json: string }
    expect(JSON.parse(persisted.payload_json)).toMatchObject({ sessionId, messageId: 'input-user', role: 'user' })
    expect(persisted.payload_json).not.toContain('sensitive text')
  })

  it('commits queued input History when the queued turn is claimed', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'queued-history' }).id
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'queued-request', content: 'queued question' })
    claimQueuedTurnAtomically(db, {
      sessionId, requestId: 'queued-request', userMessageId: queued.persisted.message.id,
      turnId: 'queued-turn', assistantMessageId: 'queued-assistant'
    })

    const history = await new SqliteAgentHistory(getDbConnection(db)).read('queued-turn')
    expect(getPersistedTurn(db, 'queued-turn')?.acceptedInputHistoryVersion).toBe(1)
    expect(history.events).toMatchObject([{
      sequence: 1, kind: 'session-input-committed',
      payload: { sessionId, messageId: queued.persisted.message.id, role: 'user' }
    }])
  })

  it('keeps queued input claimable if its canonical History event fails to commit', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'queued-history-rollback' }).id
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'queued-rollback-request', content: 'queued question' })
    getDbConnection(db).exec(`CREATE TRIGGER reject_queued_canonical_input BEFORE INSERT ON agent_history_events
      WHEN NEW.kind = 'session-input-committed' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`)

    expect(() => claimQueuedTurnAtomically(db, {
      sessionId, requestId: 'queued-rollback-request', userMessageId: queued.persisted.message.id,
      turnId: 'queued-rollback-turn', assistantMessageId: 'queued-rollback-assistant'
    })).toThrow(/history unavailable/)

    expect(getMessage(db, queued.persisted.message.id)?.status).toBe('queued')
    expect(getMessage(db, 'queued-rollback-assistant')).toBeUndefined()
    expect(getPersistedTurn(db, 'queued-rollback-turn')).toBeUndefined()
    expect(getQueueInputReceipt(db, sessionId, 'queued-rollback-request')?.state).toBe('queued')
  })

  it('rolls back user/assistant messages and turn when the canonical input event cannot be committed', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'atomic-history' }).id
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER reject_canonical_input BEFORE INSERT ON agent_history_events
      WHEN NEW.kind = 'session-input-committed' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`)

    expect(() => prepareTurnAtomically(db, {
      user: { id: 'atomic-user', sessionId, role: 'user', content: 'hello', timestamp: 1, status: 'sent' },
      assistant: { id: 'atomic-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'atomic-turn', requestId: 'atomic-request', sessionId, assistantMessageId: 'atomic-assistant', state: 'prepared' }
    })).toThrow(/history unavailable/)

    expect(getMessage(db, 'atomic-user')).toBeUndefined()
    expect(getMessage(db, 'atomic-assistant')).toBeUndefined()
    expect(getPersistedTurn(db, 'atomic-turn')).toBeUndefined()
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_streams WHERE invocation_id = ?').get('atomic-request')).toEqual({ count: 0 })
  })
})

describe('getApiContextBaseline', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('returns latest 500 messages with sequences ASC', () => {
    for (let i = 0; i < 600; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i,
        status: i % 2 === 0 ? 'sent' : 'completed'
      })
    }
    const baseline = getApiContextBaseline(db, sessionId)
    expect(baseline.sessionId).toBe(sessionId)
    expect(baseline.entries).toHaveLength(500)
    expect(baseline.entries[0]).toMatchObject({ sequence: 100, message: { id: 'm100' } })
    expect(baseline.entries[499]).toMatchObject({ sequence: 599, message: { id: 'm599' } })
  })
})

describe('getChatMessagePage', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('loads latest page ASC with hasMoreBefore', () => {
    for (let i = 0; i < 100; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }
    const page = getChatMessagePage(db, sessionId, null, 60)
    expect(page.entries).toHaveLength(60)
    expect(page.entries[0]?.message.id).toBe('m40')
    expect(page.entries[59]?.message.id).toBe('m99')
    expect(page.oldestSequence).toBe(40)
    expect(page.hasMoreBefore).toBe(true)

    const prev = getChatMessagePage(db, sessionId, page.oldestSequence!, 60)
    expect(prev.entries[0]?.message.id).toBe('m0')
    expect(prev.hasMoreBefore).toBe(false)
  })
})

describe('queued and retry queries', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('returns next queued by sequence', () => {
    appendMessage(db, {
      id: 'q1',
      sessionId,
      role: 'user',
      content: 'first',
      timestamp: 1,
      status: 'queued'
    })
    appendMessage(db, {
      id: 'q2',
      sessionId,
      role: 'user',
      content: 'second',
      timestamp: 2,
      status: 'queued'
    })
    const next = getNextQueuedMessage(db, sessionId)
    expect(next?.message.id).toBe('q1')
    expect(next?.sequence).toBe(0)
  })

  it('不会在同一 session 存在活动 turn 时认领 queued user', () => {
    appendMessage(db, { id: 'busy-q', sessionId, role: 'user', content: 'queued', timestamp: 1, status: 'queued' })
    createQueueInputReceipt(db, { sessionId, requestId: 'busy-r', fingerprint: 'busy-f', queuedMessageId: 'busy-q', state: 'queued' })
    appendMessage(db, { id: 'active-a', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'busy-t', requestId: 'active-r', sessionId, assistantMessageId: 'active-a', state: 'executing' })
    expect(() => claimQueuedTurnAtomically(db, { sessionId, userMessageId: 'busy-q', turnId: 'next-t', assistantMessageId: 'next-a', requestId: 'busy-r' })).toThrow('SESSION_TURN_BUSY')
  })

  it('prepare turn 固化 assistant 插入前的 session 高水位', () => {
    appendMessage(db, { id: 'before-user', sessionId, role: 'user', content: 'before', timestamp: 1, status: 'sent' })
    const prepared = prepareTurnAtomically(db, {
      user: { id: 'new-user', sessionId, role: 'user', content: 'new', timestamp: 2, status: 'sent' },
      assistant: { id: 'new-assistant', sessionId, role: 'assistant', content: '', timestamp: 3, status: 'streaming' },
      turn: { turnId: 'boundary-t', requestId: 'boundary-r', sessionId, assistantMessageId: 'new-assistant', state: 'prepared' }
    })
    expect(prepared.assistant.sequence).toBeGreaterThan(prepared.user.sequence)
    expect(getPersistedTurn(db, 'boundary-t')).toMatchObject({
      userMessageId: prepared.user.message.id,
      contextBoundarySequence: prepared.user.sequence - 1
    })
  })

  it('configuring turn 在配置与指纹同时冻结前不可执行，且仍占有 session', () => {
    appendMessage(db, { id: 'configuring-user', sessionId, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'configuring-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'configuring-turn', requestId: 'configuring-request', sessionId,
      userMessageId: 'configuring-user', assistantMessageId: 'configuring-assistant',
      state: 'configuring', intentFingerprint: '{}'
    })

    expect(hasActiveTurn(db, sessionId)).toBe(true)
    const snapshot = getSessionMessageRevisionSnapshot(db, sessionId)!
    expect(setPersistedTurnExecutionConfig(db, 'configuring-turn', { lane: 'desktop', model: 'deepseek-chat' }, '{"frozen":true}', snapshot)).toBe(true)
    expect(getPersistedTurn(db, 'configuring-turn')).toMatchObject({
      state: 'prepared',
      intentFingerprint: '{"frozen":true}',
      executionConfig: { lane: 'desktop', model: 'deepseek-chat' }
    })
    expect(setPersistedTurnExecutionConfig(db, 'configuring-turn', { lane: 'desktop', model: 'other' }, '{}', snapshot)).toBe(false)
  })

  it('配置失败原子终结 turn 与 assistant streaming 状态，不能覆盖已完成的取消', () => {
    appendMessage(db, { id: 'failure-user', sessionId, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'failure-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'failure-turn', requestId: 'failure-request', sessionId,
      userMessageId: 'failure-user', assistantMessageId: 'failure-assistant', state: 'configuring'
    })

    expect(failConfiguringTurn(db, 'failure-turn', 1, { code: 'configuration-failed', message: 'route rejected' })).toBe(true)
    expect(getPersistedTurn(db, 'failure-turn')).toMatchObject({ state: 'terminal', outcome: 'failed', version: 1 })
    expect(getMessage(db, 'failure-assistant')).toMatchObject({ status: 'failed' })
    expect(failConfiguringTurn(db, 'failure-turn', 2, { code: 'configuration-failed', message: 'late failure' })).toBe(false)
    expect(getPersistedTurn(db, 'failure-turn')).toMatchObject({ outcome: 'failed', version: 1 })
  })

  it('resolves retry context to prior eligible user', () => {
    appendMessage(db, {
      id: 'u1',
      sessionId,
      role: 'user',
      content: 'ask',
      timestamp: 1,
      status: 'sent'
    })
    appendMessage(db, {
      id: 'a1',
      sessionId,
      role: 'assistant',
      content: 'fail',
      timestamp: 2,
      status: 'failed'
    })
    const target = resolveRetryContext(db, sessionId, 'a1')
    expect(target?.currentUser.message.id).toBe('u1')
    expect(target?.failedAssistant.message.id).toBe('a1')
    expect(target?.excludeMessageIds).toEqual(['a1'])
  })

  it('连续排队时按 turn.user_message_id 找到真实 retry user，而不是最近物理 user', () => {
    appendMessage(db, { id: 'a-user', sessionId, role: 'user', content: 'A', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'a-assistant', sessionId, role: 'assistant', content: 'A done', timestamp: 2, status: 'completed' })
    appendMessage(db, { id: 'b-user', sessionId, role: 'user', content: 'B', timestamp: 3, status: 'sent' })
    appendMessage(db, { id: 'b-assistant', sessionId, role: 'assistant', content: 'B failed', timestamp: 4, status: 'failed' })
    appendMessage(db, { id: 'c-user', sessionId, role: 'user', content: 'C queued after B', timestamp: 5, status: 'sent' })
    createPersistedTurn(db, {
      turnId: 'b-turn', requestId: 'b-request', sessionId,
      assistantMessageId: 'b-assistant', userMessageId: 'b-user', state: 'terminal', outcome: 'failed'
    })
    expect(resolveRetryContext(db, sessionId, 'b-assistant')).toMatchObject({
      currentUser: { message: { id: 'b-user' } }, sourceInvocationId: 'b-request'
    })
  })

  it('重试同一用户输入时排除它之前所有失败的助手尝试', () => {
    appendMessage(db, { id: 'retry-chain-user', sessionId, role: 'user', content: 'retry me', timestamp: 1, status: 'sent' })
    for (const [index, assistantId] of ['retry-chain-failed-1', 'retry-chain-failed-2', 'retry-chain-failed-3'].entries()) {
      appendMessage(db, { id: assistantId, sessionId, role: 'assistant', content: '', timestamp: index + 2, status: 'failed' })
      createPersistedTurn(db, {
        turnId: `${assistantId}-turn`, requestId: `${assistantId}-request`, sessionId,
        userMessageId: 'retry-chain-user', assistantMessageId: assistantId, state: 'terminal', outcome: 'failed'
      })
    }

    const target = resolveRetryContext(db, sessionId, 'retry-chain-failed-3')
    expect(target).toMatchObject({
      currentUser: { message: { id: 'retry-chain-user' } },
      excludeMessageIds: ['retry-chain-failed-1', 'retry-chain-failed-2', 'retry-chain-failed-3']
    })
    expect(getTurnContext(db, sessionId, target!.failedAssistant.sequence, target!.currentUser.message.id, target!.excludeMessageIds)
      .map(({ id }) => id)).toEqual(['retry-chain-user'])
  })
})

describe('getContextHistorySummaryBaseline', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('keeps late image and thinking rows visible to context consumers', () => {
    for (let i = 0; i < 600; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i,
        status: i % 2 === 0 ? 'sent' : 'completed'
      })
    }
    appendMessage(db, {
      id: 'img-late',
      sessionId,
      role: 'user',
      content: 'pic',
      timestamp: 1000,
      status: 'sent',
      attachments: [
        {
          id: 'a',
          stagingKey: 'chat-attachments/s/a.png',
          fileName: 'a.png',
          mimeType: 'image/png',
          byteLength: 4000,
          width: 512,
          height: 512
        }
      ]
    })
    appendMessage(db, {
      id: 'think-late',
      sessionId,
      role: 'assistant',
      content: 'ok',
      timestamp: 1001,
      status: 'completed',
      thinking: {
        content: 'deep thought about tokens',
        isVisible: true,
        startTime: 1,
        segments: [{ content: 'deep thought about tokens', startTime: 1, endTime: 2 }]
      }
    })

    const api = getApiContextBaseline(db, sessionId)
    expect(api.entries.some((e) => e.message.id === 'img-late')).toBe(true)

    const summary = getContextHistorySummaryBaseline(db, sessionId)
    expect(summary.entries.some((e) => e.messageId === 'img-late' && e.imageTokens > 0)).toBe(true)
    expect(summary.entries.some((e) => e.messageId === 'think-late' && e.thinkingTokens > 0)).toBe(
      true
    )
  })

  it('reads only image/thinking metadata instead of loading message bodies', () => {
    appendMessage(db, {
      id: 'summary-large-body',
      sessionId,
      role: 'user',
      content: 'large historical body that this metadata summary must not load',
      timestamp: 10,
      status: 'sent',
      attachments: [{
        id: 'summary-image', stagingKey: 'chat-attachments/s/image.png', fileName: 'image.png',
        mimeType: 'image/png', byteLength: 4096, width: 512, height: 512
      }]
    })
    const conn = getDbConnection(db)
    const preparedSql: string[] = []
    const prepare = conn.prepare.bind(conn)
    vi.spyOn(conn, 'prepare').mockImplementation(((sql: string) => {
      preparedSql.push(sql)
      return prepare(sql)
    }) as typeof conn.prepare)

    const summary = getContextHistorySummaryBaseline(db, sessionId)

    const messageRead = preparedSql.find((sql) => /FROM\s+messages/i.test(sql))
    expect(messageRead).toMatch(/SELECT\s+id\s*,\s*role\s*,\s*thinking\s*,\s*attachments\s*,\s*sequence\s+FROM\s+messages/i)
    expect(messageRead).not.toMatch(/\bcontent\b/i)
    expect(summary.entries).toEqual([expect.objectContaining({
      messageId: 'summary-large-body', role: 'user', imageTokens: 400, thinkingTokens: 0
    })])
  })

})

describe('getSearchCorpusPage', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('pages ASC without UI latest-page truncation', () => {
    for (let i = 0; i < 150; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }
    const first = getSearchCorpusPage(db, sessionId, 0, 100)
    expect(first.entries).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(first.entries[0]?.sequence).toBe(0)
    const second = getSearchCorpusPage(db, sessionId, first.nextSequence, 100)
    expect(second.entries[0]?.message.id).toBe('m100')
    expect(second.hasMore).toBe(false)
  })

  it('搜索语料排除排队用户消息且排除后游标仍能推进到下一页', () => {
    for (let i = 0; i < 60; i++) {
      appendMessage(db, { id: `search-${i}`, sessionId, role: 'user', content: `c${i}`, timestamp: i, status: i === 0 ? 'queued' : 'sent' })
    }
    const first = getSearchCorpusPage(db, sessionId, 0, 50)
    expect(first.entries.some(({ message }) => message.status === 'queued')).toBe(false)
    expect(first.entries).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    const second = getSearchCorpusPage(db, sessionId, first.nextSequence, 50)
    expect(second.entries.map(({ message }) => message.id)).toEqual(['search-51', 'search-52', 'search-53', 'search-54', 'search-55', 'search-56', 'search-57', 'search-58', 'search-59'])
    expect(second.hasMore).toBe(false)
  })
})

describe('updateQueuedUserMessageContent', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'queued edit' }).id
  })

  it('拒绝非排队消息和空内容', () => {
    const sent = appendMessage(db, { id: 'edit-sent', sessionId, role: 'user', content: 'sent', timestamp: 1, status: 'sent' })
    expect(updateQueuedUserMessageContent(db, { sessionId, messageId: sent.message.id, content: 'updated' })).toEqual({ ok: false, error: 'message_not_queued' })
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-empty', content: 'queued' })
    expect(updateQueuedUserMessageContent(db, { sessionId, messageId: queued.persisted.message.id, content: '   ' })).toEqual({ ok: false, error: 'empty_content' })
  })

  it('成功后内容与指纹同步更新，且更新最后一条 preview', () => {
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-success', content: 'before' })
    const result = updateQueuedUserMessageContent(db, { sessionId, messageId: queued.persisted.message.id, content: ' after ' })
    expect(result).toMatchObject({ ok: true, message: { content: 'after', status: 'queued' }, sequence: queued.persisted.sequence })
    expect(getQueueInputReceipt(db, sessionId, 'edit-success')?.fingerprint).not.toBe(queued.receipt.fingerprint)
    expect(getSession(db, sessionId)?.preview).toBe('after')
    expect(enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-success', content: 'after' }).duplicate).toBe(true)
  })

  it('编辑非最后一条不更新 preview', () => {
    enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-prior', content: 'prior' })
    const last = enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-last', content: 'last' })
    const preview = getSession(db, sessionId)?.preview
    expect(updateQueuedUserMessageContent(db, { sessionId, messageId: last.persisted.message.id, content: 'latest' }).ok).toBe(true)
    expect(getSession(db, sessionId)?.preview).not.toBe(preview)
    const prior = getQueueInputReceipt(db, sessionId, 'edit-prior')!
    expect(updateQueuedUserMessageContent(db, { sessionId, messageId: prior.queuedMessageId!, content: 'older' }).ok).toBe(true)
    expect(getSession(db, sessionId)?.preview).toBe('latest')
  })

  it('queued 正文编辑后 preview 写入失败时回滚正文、fingerprint、revision 与资格 fence', () => {
    const conn = getDbConnection(db)
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-rollback-request', content: 'before' })
    const generation = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string }
    const beforeCutover = conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(sessionId) as { message_revision: number }
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(sessionId)
    conn.prepare('INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)')
      .run(sessionId, generation.generation)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version)
      VALUES(?,?,?,1,1,'edit-rollback-watermark','edit-rollback-invocation',1,1)`).run(sessionId, generation.generation, beforeCutover.message_revision)
    const originalFingerprint = getQueueInputReceipt(db, sessionId, 'edit-rollback-request')!.fingerprint
    const originalPreview = getSession(db, sessionId)?.preview
    const originalRevision = conn.prepare('SELECT message_revision FROM session_message_content_cutover WHERE session_id=?').get(sessionId) as { message_revision: number }
    conn.exec(`CREATE TRIGGER reject_edit_preview BEFORE UPDATE OF preview ON sessions
      WHEN NEW.id='${sessionId}' BEGIN SELECT RAISE(ABORT,'injected queued edit preview failure'); END`)

    expect(() => updateQueuedUserMessageContent(db, { sessionId, messageId: queued.persisted.message.id, content: 'after' }))
      .toThrow('injected queued edit preview failure')

    expect(getMessage(db, queued.persisted.message.id)).toMatchObject({ content: 'before', status: 'queued' })
    expect(getQueueInputReceipt(db, sessionId, 'edit-rollback-request')).toMatchObject({ fingerprint: originalFingerprint, state: 'queued' })
    expect(getSession(db, sessionId)?.preview).toBe(originalPreview)
    expect(conn.prepare('SELECT message_revision,api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(sessionId))
      .toEqual({ message_revision: originalRevision.message_revision, api_read_mode: 'canonical' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get(sessionId)).toBeDefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(sessionId)).toBeDefined()
  })

  it('编辑已 claim 的消息返回 message_not_queued 且内容不变', () => {
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'edit-claimed', content: 'before' })
    claimQueuedTurnAtomically(db, { sessionId, userMessageId: queued.persisted.message.id, turnId: 'edit-turn', assistantMessageId: 'edit-assistant', requestId: 'edit-claimed' })
    expect(updateQueuedUserMessageContent(db, { sessionId, messageId: queued.persisted.message.id, content: 'after' })).toEqual({ ok: false, error: 'message_not_queued' })
    expect(getMessage(db, queued.persisted.message.id)?.content).toBe('before')
  })
})

describe('listTurnErrorsByAssistantMessageIds', () => {
  function seedTurn(
    db: AppDatabase,
    sessionId: string,
    suffix: string,
    error?: { code: string; message: string }
  ): string {
    const assistantId = `a-${suffix}`
    appendMessage(db, {
      id: assistantId,
      sessionId,
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: error ? 'failed' : 'completed'
    })
    createPersistedTurn(db, {
      turnId: `t-${suffix}`,
      requestId: `r-${suffix}`,
      sessionId,
      assistantMessageId: assistantId,
      state: 'terminal',
      outcome: error ? 'failed' : 'completed'
    })
    if (error) updatePersistedTurnState(db, `t-${suffix}`, 'terminal', { outcome: 'failed', error })
    return assistantId
  }

  it('按 assistantMessageId 返回持久化的失败原因', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'errors' }).id
    const a1 = seedTurn(db, sessionId, '1', { code: 'source-failed', message: '会话模型「x」当前不可用' })
    const a2 = seedTurn(db, sessionId, '2', { code: 'source-failed', message: 'Request not allowed' })

    expect(listTurnErrorsByAssistantMessageIds(db, [a1, a2])).toEqual([
      { assistantMessageId: a1, message: '会话模型「x」当前不可用' },
      { assistantMessageId: a2, message: 'Request not allowed' }
    ])
  })

  it('无错误记录的 turn 与未知 id 都不返回', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'errors-mixed' }).id
    const withError = seedTurn(db, sessionId, 'ok', { code: 'x', message: 'r' })
    const withoutError = seedTurn(db, sessionId, 'none')

    expect(listTurnErrorsByAssistantMessageIds(db, [withError, withoutError, 'a-unknown'])).toEqual([
      { assistantMessageId: withError, message: 'r' }
    ])
  })

  it('空输入不查库并返回空数组', () => {
    const db = createMemoryAppDb()
    expect(listTurnErrorsByAssistantMessageIds(db, [])).toEqual([])
    expect(listTurnErrorsByAssistantMessageIds(db, ['', '   '])).toEqual([])
  })

  it('忽略空白错误消息并对重复 id 只返回一次', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'errors-blank' }).id
    const blank = seedTurn(db, sessionId, 'blank', { code: 'x', message: '   ' })
    const real = seedTurn(db, sessionId, 'real', { code: 'x', message: ' 真实原因 ' })

    expect(listTurnErrorsByAssistantMessageIds(db, [blank, real, real])).toEqual([
      { assistantMessageId: real, message: '真实原因' }
    ])
  })
})

describe('updatePersistedTurnState terminal message projection', () => {
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['timed-out', 'failed'],
    ['recovered', 'failed'],
    ['commit-uncertain', 'failed']
  ])('将终态 outcome %s 原子投影到仍在 streaming 的 assistant 消息', (outcome, expectedStatus) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `terminal-${outcome}` })
    appendMessage(db, {
      id: `terminal-assistant-${outcome}`,
      sessionId: session.id,
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'streaming',
      toolCalls: [{ id: 'tool-1', toolName: 'probe', input: {}, status: 'completed', riskLevel: 'low' }]
    })
    createPersistedTurn(db, {
      turnId: `terminal-turn-${outcome}`,
      requestId: `terminal-request-${outcome}`,
      sessionId: session.id,
      assistantMessageId: `terminal-assistant-${outcome}`,
      state: 'executing'
    })

    expect(updatePersistedTurnState(db, `terminal-turn-${outcome}`, 'terminal', { outcome })).toBe(true)

    expect(getPersistedTurn(db, `terminal-turn-${outcome}`)).toMatchObject({ state: 'terminal', outcome })
    expect(getMessage(db, `terminal-assistant-${outcome}`)).toMatchObject({ status: expectedStatus, content: '' })
    expect(getMessage(db, `terminal-assistant-${outcome}`)?.toolCalls).toMatchObject([{ id: 'tool-1', status: 'completed' }])
    db.close()
  })

  it('终态同步不覆盖已经完成的消息', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'terminal-keeps-completed' })
    appendMessage(db, { id: 'terminal-completed-assistant', sessionId: session.id, role: 'assistant', content: 'canonical output', timestamp: 1, status: 'completed' })
    createPersistedTurn(db, { turnId: 'terminal-completed-turn', requestId: 'terminal-completed-request', sessionId: session.id, assistantMessageId: 'terminal-completed-assistant', state: 'executing' })

    updatePersistedTurnState(db, 'terminal-completed-turn', 'terminal', { outcome: 'failed' })

    expect(getMessage(db, 'terminal-completed-assistant')).toMatchObject({ status: 'completed', content: 'canonical output' })
    db.close()
  })

  it('assistant 状态镜像失败时回滚 turn 终态', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'terminal-atomic-rollback' })
    appendMessage(db, { id: 'terminal-rollback-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'terminal-rollback-turn', requestId: 'terminal-rollback-request', sessionId: session.id, assistantMessageId: 'terminal-rollback-assistant', state: 'executing' })
    conn.exec(`CREATE TRIGGER fail_terminal_message_projection BEFORE UPDATE OF status ON messages
      WHEN NEW.id='terminal-rollback-assistant' BEGIN SELECT RAISE(ABORT,'forced terminal projection failure'); END`)

    expect(() => updatePersistedTurnState(db, 'terminal-rollback-turn', 'terminal', { outcome: 'failed' })).toThrow('forced terminal projection failure')

    expect(getPersistedTurn(db, 'terminal-rollback-turn')).toMatchObject({ state: 'executing', outcome: null })
    expect(getMessage(db, 'terminal-rollback-assistant')).toMatchObject({ status: 'streaming' })
    db.close()
  })

  it('文件数据库重开后保留终态，迟到 checkpoint 不能恢复 streaming', () => {
    const file = createTempDatabase('terminal-turn-message-projection-')
    try {
      const session = createSession(file.db, { name: 'terminal-reopen' })
      appendMessage(file.db, { id: 'terminal-reopen-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
      createPersistedTurn(file.db, { turnId: 'terminal-reopen-turn', requestId: 'terminal-reopen-request', sessionId: session.id, assistantMessageId: 'terminal-reopen-assistant', state: 'executing' })
      expect(updatePersistedTurnState(file.db, 'terminal-reopen-turn', 'terminal', { version: 1, outcome: 'failed' })).toBe(true)
      file.db.close()

      const reopened = openDatabase(file.dbPath)
      expect(getPersistedTurn(reopened, 'terminal-reopen-turn')).toMatchObject({ state: 'terminal', outcome: 'failed', version: 1 })
      expect(getMessage(reopened, 'terminal-reopen-assistant')).toMatchObject({ status: 'failed', content: '' })
      expect(checkpointTurnAtomically(reopened, 'terminal-reopen-turn', 2, 'terminal-reopen-assistant', { status: 'streaming', content: 'late checkpoint' })).toBe(false)
      expect(getMessage(reopened, 'terminal-reopen-assistant')).toMatchObject({ status: 'failed', content: '' })
      reopened.close()
    } finally {
      file.cleanup()
    }
  })
})

describe('canonical-backed session preview', () => {
  it('recomputes preview through canonical History when queued messages move and the last assistant row is canonical-only', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical preview reorder' })
    appendMessage(db, { id: 'preview-reorder-user', sessionId: session.id, role: 'user', content: 'canonical question', timestamp: 1, status: 'sent' })
    const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'preview-reorder-first', content: 'first queued' })
    const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'preview-reorder-second', content: 'second queued' })
    appendMessage(db, { id: 'preview-reorder-assistant', sessionId: session.id, role: 'assistant', content: 'canonical final answer', timestamp: 4, status: 'completed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'preview-reorder-invocation', turnId: 'preview-reorder-turn', sequence: 1, schemaVersion: 1,
      eventId: 'preview-reorder-context', idempotencyKey: 'preview-reorder-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'preview-reorder-user', role: 'user', content: 'canonical question', timestamp: 1 },
        { id: 'preview-reorder-assistant', role: 'assistant', content: 'canonical final answer', timestamp: 4 }
      ] }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id IN ('preview-reorder-user','preview-reorder-assistant')").run()

    expect(getSession(db, session.id)?.preview).toBe('canonical final answer')
    expect(reorderQueuedUserMessages(db, { sessionId: session.id, messageIds: [second.persisted.message.id, first.persisted.message.id] })).toMatchObject({ ok: true })

    expect(getSession(db, session.id)?.preview).toBe('canonical final answer')
    db.close()
  })

  it('recomputes preview from canonical body after deleting the trailing queued message', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical preview delete' })
    appendMessage(db, { id: 'preview-canonical-user', sessionId: session.id, role: 'user', content: 'canonical question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'preview-canonical-assistant', sessionId: session.id, role: 'assistant', content: 'canonical answer', timestamp: 2, status: 'completed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'preview-canonical-invocation', turnId: 'preview-canonical-turn', sequence: 1, schemaVersion: 1,
      eventId: 'preview-canonical-context', idempotencyKey: 'preview-canonical-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'preview-canonical-user', role: 'user', content: 'canonical question', timestamp: 1 },
        { id: 'preview-canonical-assistant', role: 'assistant', content: 'canonical answer', timestamp: 2 }
      ] }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'preview-queued-request', content: 'queued preview' })

    expect(deleteQueuedUserMessage(db, queued.persisted.message.id)).toEqual({ ok: true, sessionId: session.id })
    expect(getSession(db, session.id)?.preview).toBe('canonical answer')
    db.close()
  })

  it('canonical preview 解析失败时回滚队列删除、receipt 和 preview', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical preview rollback' })
    appendMessage(db, { id: 'preview-rollback-user', sessionId: session.id, role: 'user', content: 'canonical question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'preview-rollback-assistant', sessionId: session.id, role: 'assistant', content: 'canonical answer', timestamp: 2, status: 'completed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'preview-rollback-invocation', turnId: 'preview-rollback-turn', sequence: 1, schemaVersion: 1,
        eventId: 'preview-rollback-context', idempotencyKey: 'preview-rollback-context', kind: 'invocation-context-committed',
        payload: { messages: [
          { id: 'preview-rollback-user', role: 'user', content: 'canonical question', timestamp: 1 },
          { id: 'preview-rollback-assistant', role: 'assistant', content: 'canonical answer', timestamp: 2 }
        ] } },
      { invocationId: 'preview-rollback-invocation', turnId: 'preview-rollback-turn', sequence: 2, schemaVersion: 1,
        eventId: 'preview-rollback-terminal', idempotencyKey: 'preview-rollback-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'preview-rollback-request', content: 'queued preview' })
    conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?').run('{broken', 'preview-rollback-context')
    const beforePreview = getSession(db, session.id)?.preview

    expect(() => deleteQueuedUserMessage(db, queued.persisted.message.id)).toThrow()

    expect(getMessage(db, queued.persisted.message.id)).toMatchObject({ content: 'queued preview', status: 'queued' })
    expect(getQueueInputReceipt(db, session.id, 'preview-rollback-request')).toMatchObject({ state: 'queued', queuedMessageId: queued.persisted.message.id })
    expect(getSession(db, session.id)?.preview).toBe(beforePreview)
    expect(conn.prepare('SELECT id FROM messages WHERE session_id=? ORDER BY sequence').all(session.id).map(({ id }) => id))
      .toEqual(['preview-rollback-user', 'preview-rollback-assistant', queued.persisted.message.id])
    db.close()
  })
})
