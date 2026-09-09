import { describe, expect, it } from 'vitest'
import { appendMessage, createPersistedTurn, createSession, openDatabase } from './database'
import { loadAuthoritativeTurnContext, normalizeAndValidateClaudeMessagesWithContentBlocks } from './claudeStreamHandlers'
import { buildToolChatMessagesFromSource } from './chatMessageBuild'

describe('loadAuthoritativeTurnContext', () => {
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
