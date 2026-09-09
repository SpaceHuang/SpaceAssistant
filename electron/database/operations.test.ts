import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import {
  appendMessage,
  appendMessagesAtomically,
  updateMessageContentIfStreaming,
  checkpointTurnAtomically,
  createSession,
  getApiContextBaseline,
  getTurnContext,
  getMessage,
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
  claimQueuedTurnAtomically,
  recoverPersistedTurn,
  updateQueueInputReceiptState,
  getNextQueuedMessage,
  getSearchCorpusPage,
  resolveRetryContext,
  setPersistedTurnExecutionConfig
} from './operations'
import { getDbConnection, type AppDatabase } from './sqliteStore'

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
})

describe('getTurnContext', () => {
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
    expect(() => enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'enqueue-r', content: 'different' })).toThrow(/FINGERPRINT/)
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
    expect(setPersistedTurnExecutionConfig(db, 'configuring-turn', { lane: 'desktop', model: 'deepseek-chat' }, '{"frozen":true}')).toBe(true)
    expect(getPersistedTurn(db, 'configuring-turn')).toMatchObject({
      state: 'prepared',
      intentFingerprint: '{"frozen":true}',
      executionConfig: { lane: 'desktop', model: 'deepseek-chat' }
    })
    expect(setPersistedTurnExecutionConfig(db, 'configuring-turn', { lane: 'desktop', model: 'other' }, '{}')).toBe(false)
  })

  it('配置失败只终结仍处于 configuring 的 turn，不能覆盖已完成的取消', () => {
    appendMessage(db, { id: 'failure-user', sessionId, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'failure-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'failure-turn', requestId: 'failure-request', sessionId,
      userMessageId: 'failure-user', assistantMessageId: 'failure-assistant', state: 'configuring'
    })

    expect(failConfiguringTurn(db, 'failure-turn', 1, { code: 'configuration-failed', message: 'route rejected' })).toBe(true)
    expect(getPersistedTurn(db, 'failure-turn')).toMatchObject({ state: 'terminal', outcome: 'failed', version: 1 })
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
    expect(resolveRetryContext(db, sessionId, 'b-assistant')?.currentUser.message.id).toBe('b-user')
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
})
