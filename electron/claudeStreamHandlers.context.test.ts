import { describe, expect, it } from 'vitest'
import { appendMessage, claimQueuedTurnAtomically, createPersistedTurn, createSession, enqueueQueuedUserMessage, getDbConnection, openDatabase, prepareTurnAtomically } from './database'
import { loadAuthoritativeTurnContext, normalizeAndValidateClaudeMessagesWithContentBlocks } from './claudeStreamHandlers'
import { buildToolChatMessagesFromSource } from './chatMessageBuild'
import { selectRecoveryMessages } from '../src/shared/overflowRecovery'
import { SqliteAgentHistory } from './runtime/sqliteAgentHistory'

describe('loadAuthoritativeTurnContext', () => {
  it('超窗恢复会从真实归一化的混合 user 中移除历史 tool_result 并保留当前问题', () => {
    const normalized = normalizeAndValidateClaudeMessagesWithContentBlocks([
      { id: 'old-user', role: 'user', content: 'old question' },
      { id: 'old-assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'old-tool', name: 'read', input: {} }] },
      { id: 'current-user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'old result' }, { type: 'text', text: 'current question' }] }
    ], { requiredUserMessageId: 'current-user' })
    const recovered = selectRecoveryMessages(normalized, 'current-user')
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: 'current-user', role: 'user', content: 'current question' })
  })

  it('忽略 renderer 可能提交的伪造历史，只按持久化 turn boundary 返回上下文', () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'authoritative-context' })
    appendMessage(db, { id: 'old', sessionId: session.id, role: 'user', content: 'old', timestamp: 1, status: 'sent' })
    const user = appendMessage(db, { id: 'user-a', sessionId: session.id, role: 'user', content: 'A', timestamp: 2, status: 'sent' })
    appendMessage(db, { id: 'assistant-a', sessionId: session.id, role: 'assistant', content: '', timestamp: 3, status: 'streaming' })
    appendMessage(db, { id: 'after-boundary', sessionId: session.id, role: 'user', content: 'must not enter', timestamp: 4, status: 'sent' })
    createPersistedTurn(db, { turnId: 'turn-a', requestId: 'request-a', sessionId: session.id, userMessageId: user.message.id, assistantMessageId: 'assistant-a', contextBoundarySequence: user.sequence - 1, state: 'prepared', version: 0, startToken: 'token-a' })

    const context = loadAuthoritativeTurnContext(db, 'turn-a', session.id, 'request-a', 'token-a')
    expect(context.currentUserMessageId).toBe('user-a')
    expect(context.messages.map((message) => message.id)).toEqual(['old', 'user-a'])
    expect(context.messages.some((message) => message.content === 'must not enter')).toBe(false)
    expect(() => loadAuthoritativeTurnContext(db, 'turn-a', session.id, 'request-a', 'wrong-token')).toThrow('TURN_EXECUTION_CREDENTIALS_INVALID')
    db.close()
  })

  it('canonical accepted-input fingerprint binds Desktop turn context to the committed user message', () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'accepted-input-binding' })
    const acceptedAttachment = { id: 'accepted-image', stagingKey: `chat-attachments/${session.id}/accepted-image.png`, fileName: 'accepted-image.png', mimeType: 'image/png', byteLength: 4 }
    prepareTurnAtomically(db, {
      user: { id: 'accepted-user', sessionId: session.id, role: 'user', content: 'accepted question', attachments: [acceptedAttachment], timestamp: 1, status: 'sent' },
      assistant: { id: 'accepted-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'accepted-turn', requestId: 'accepted-request', sessionId: session.id, assistantMessageId: 'accepted-assistant', state: 'prepared', startToken: 'accepted-token' }
    })

    expect(loadAuthoritativeTurnContext(db, 'accepted-turn', session.id, 'accepted-request', 'accepted-token').messages)
      .toContainEqual(expect.objectContaining({ id: 'accepted-user', content: 'accepted question' }))
    getDbConnection(db).prepare('UPDATE messages SET content = ? WHERE id = ?').run('changed after acceptance', 'accepted-user')

    expect(() => loadAuthoritativeTurnContext(db, 'accepted-turn', session.id, 'accepted-request', 'accepted-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    getDbConnection(db).prepare('UPDATE messages SET content = ?, attachments = ? WHERE id = ?')
      .run('accepted question', JSON.stringify([{ ...acceptedAttachment, stagingKey: `chat-attachments/${session.id}/replaced.png` }]), 'accepted-user')
    expect(() => loadAuthoritativeTurnContext(db, 'accepted-turn', session.id, 'accepted-request', 'accepted-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    db.close()
  })

  it('accepted-input History marker must belong to the persisted Desktop turn', () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'accepted-input-turn-owner' })
    prepareTurnAtomically(db, {
      user: { id: 'accepted-owner-user', sessionId: session.id, role: 'user', content: 'accepted question', timestamp: 1, status: 'sent' },
      assistant: { id: 'accepted-owner-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'accepted-owner-turn', requestId: 'accepted-owner-request', sessionId: session.id, assistantMessageId: 'accepted-owner-assistant', state: 'prepared', startToken: 'accepted-owner-token' }
    })
    getDbConnection(db).prepare("UPDATE agent_history_events SET turn_id = ? WHERE invocation_id = ? AND kind = 'session-input-committed'")
      .run('foreign-turn', 'accepted-owner-request')

    expect(() => loadAuthoritativeTurnContext(db, 'accepted-owner-turn', session.id, 'accepted-owner-request', 'accepted-owner-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    db.close()
  })

  it('accepted-input marker must be the first and only marker in its turn History', async () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'accepted-input-marker-order' })
    prepareTurnAtomically(db, {
      user: { id: 'marker-order-user', sessionId: session.id, role: 'user', content: 'accepted question', timestamp: 1, status: 'sent' },
      assistant: { id: 'marker-order-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'marker-order-turn', requestId: 'marker-order-request', sessionId: session.id, assistantMessageId: 'marker-order-assistant', state: 'prepared', startToken: 'marker-order-token' }
    })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn)
    const marker = history.readSync('marker-order-request').events[0]!
    conn.prepare('UPDATE agent_history_events SET kind = ?, payload_json = ? WHERE invocation_id = ? AND sequence = 1')
      .run('invocation-context-committed', JSON.stringify({ messages: [] }), 'marker-order-request')
    await history.appendBatch([{
      ...marker, sequence: 2, eventId: 'late-input-marker', idempotencyKey: 'late-input-marker'
    }], 1)

    expect(() => loadAuthoritativeTurnContext(db, 'marker-order-turn', session.id, 'marker-order-request', 'marker-order-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    db.close()
  })

  it('rejects duplicate accepted-input markers even when the first marker is valid', async () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'accepted-input-marker-duplicate' })
    prepareTurnAtomically(db, {
      user: { id: 'duplicate-marker-user', sessionId: session.id, role: 'user', content: 'accepted question', timestamp: 1, status: 'sent' },
      assistant: { id: 'duplicate-marker-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'duplicate-marker-turn', requestId: 'duplicate-marker-request', sessionId: session.id, assistantMessageId: 'duplicate-marker-assistant', state: 'prepared', startToken: 'duplicate-marker-token' }
    })
    const history = new SqliteAgentHistory(getDbConnection(db))
    const marker = history.readSync('duplicate-marker-request').events[0]!
    await history.appendBatch([{
      ...marker, sequence: 2, eventId: 'duplicate-input-marker', idempotencyKey: 'duplicate-input-marker'
    }], 1)

    expect(() => loadAuthoritativeTurnContext(db, 'duplicate-marker-turn', session.id, 'duplicate-marker-request', 'duplicate-marker-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    db.close()
  })

  it('requires History for turns created with the accepted-input commit protocol', () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'accepted-input-stream-missing' })
    prepareTurnAtomically(db, {
      user: { id: 'missing-stream-user', sessionId: session.id, role: 'user', content: 'accepted question', timestamp: 1, status: 'sent' },
      assistant: { id: 'missing-stream-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'missing-stream-turn', requestId: 'missing-stream-request', sessionId: session.id, assistantMessageId: 'missing-stream-assistant', state: 'prepared', startToken: 'missing-stream-token' }
    })
    getDbConnection(db).prepare('DELETE FROM agent_history_events WHERE invocation_id = ?').run('missing-stream-request')
    getDbConnection(db).prepare('DELETE FROM agent_history_streams WHERE invocation_id = ?').run('missing-stream-request')

    expect(() => loadAuthoritativeTurnContext(db, 'missing-stream-turn', session.id, 'missing-stream-request', 'missing-stream-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    db.close()
  })

  it('verifies accepted attachments when a queued user message is claimed', () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'queued-accepted-attachment' })
    const attachment = { id: 'queued-image', stagingKey: `chat-attachments/${session.id}/queued-image.png`, fileName: 'queued.png', mimeType: 'image/png', byteLength: 8 }
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'queued-accepted-request', content: 'look', attachments: [attachment] })
    claimQueuedTurnAtomically(db, {
      sessionId: session.id, userMessageId: queued.persisted.message.id, turnId: 'queued-accepted-turn',
      assistantMessageId: 'queued-accepted-assistant', requestId: 'queued-accepted-request', startToken: 'queued-accepted-token'
    })

    expect(loadAuthoritativeTurnContext(db, 'queued-accepted-turn', session.id, 'queued-accepted-request', 'queued-accepted-token').messages)
      .toContainEqual(expect.objectContaining({ id: queued.persisted.message.id, attachments: [attachment] }))
    getDbConnection(db).prepare('UPDATE messages SET attachments = ? WHERE id = ?')
      .run(JSON.stringify([{ ...attachment, stagingKey: `chat-attachments/${session.id}/substituted.png` }]), queued.persisted.message.id)
    expect(() => loadAuthoritativeTurnContext(db, 'queued-accepted-turn', session.id, 'queued-accepted-request', 'queued-accepted-token'))
      .toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    db.close()
  })

  it('拒绝 configuring turn，避免将未完成配置误判为旧版 executionConfig 缺失', () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'configuring-context' })
    const user = appendMessage(db, { id: 'configuring-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'configuring-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'configuring-turn', requestId: 'configuring-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: 'configuring-assistant',
      contextBoundarySequence: user.sequence - 1, state: 'configuring', startToken: 'configuring-token'
    })

    expect(() => loadAuthoritativeTurnContext(db, 'configuring-turn', session.id, 'configuring-request', 'configuring-token'))
      .toThrow('TURN_EXECUTION_CONFIGURING')
    db.close()
  })

  it('Q9 超过 500 条历史时最终模型 payload 仍只含一次 required user，且不混入边界后消息', async () => {
    const db = openDatabase(':memory:')
    const session = createSession(db, { name: 'long-authoritative-context' })
    const required = appendMessage(db, { id: 'required-old-user', sessionId: session.id, role: 'user', content: 'required', timestamp: 0, status: 'sent' })
    for (let index = 0; index < 510; index++) {
      appendMessage(db, {
        id: `history-${index}`,
        sessionId: session.id,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `history ${index}`,
        timestamp: index + 1,
        status: 'completed'
      })
    }
    const boundary = appendMessage(db, { id: 'boundary-user', sessionId: session.id, role: 'user', content: 'boundary', timestamp: 600, status: 'sent' })
    appendMessage(db, { id: 'after-boundary', sessionId: session.id, role: 'user', content: 'late', timestamp: 601, status: 'sent' })
    const currentAssistant = appendMessage(db, { id: 'long-current-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 602, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'long-turn', requestId: 'long-request', sessionId: session.id, userMessageId: required.message.id, assistantMessageId: currentAssistant.message.id, contextBoundarySequence: boundary.sequence, state: 'prepared', startToken: 'long-token' })

    const authoritative = loadAuthoritativeTurnContext(db, 'long-turn', session.id, 'long-request', 'long-token')
    const built = await buildToolChatMessagesFromSource({ userDataDir: '/tmp', sourceMessages: authoritative.messages, currentUserMessageId: authoritative.currentUserMessageId, sessionId: session.id })
    const payload = normalizeAndValidateClaudeMessagesWithContentBlocks(built, { sessionId: session.id, requiredUserMessageId: authoritative.currentUserMessageId })

    expect(JSON.stringify(payload).match(/required/g)).toHaveLength(1)
    expect(payload.some((message) => message.id === 'after-boundary')).toBe(false)
    expect(payload.some((message) => message.id === 'history-509')).toBe(true)
    db.close()
  })
})
