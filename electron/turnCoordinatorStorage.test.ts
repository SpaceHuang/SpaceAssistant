import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from './database/testHelpers'
import {
  appendMessage,
  createSession,
  enqueueQueuedUserMessage,
  getQueueInputReceipt,
  getMessagesPage,
  getPersistedTurn,
  getTurnContext,
  listPersistedTurns,
  openDatabase,
  setConfigValue
} from './database'
import { createTurnCoordinatorStorage } from './turnCoordinatorStorage'
import { TurnCoordinator } from '../src/shared/turnCoordinator'
import { TurnRuntime } from './turnRuntime'
import { getDbConnection } from './database'
import { SqliteAgentHistory } from './runtime/sqliteAgentHistory'

describe('createTurnCoordinatorStorage', () => {
  it('sent retry 经 SQLite round-trip 后仍会从权威上下文排除失败 assistant', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'sent-retry-exclusions' })
    appendMessage(db, { id: 'sent-user', sessionId: session.id, role: 'user', content: 'retry me', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'failed-assistant', sessionId: session.id, role: 'assistant', content: 'partial failure', timestamp: 2, status: 'failed' })
    const coordinator = new TurnCoordinator(createTurnCoordinatorStorage(db), {
      now: () => 3,
      id: (() => { let n = 0; return () => `sent-${++n}` })()
    })

    const started = coordinator.prepare({
      mode: 'reuse-user', requestId: 'sent-retry-request', sessionId: session.id,
      userMessageId: 'sent-user', excludeMessageIds: ['failed-assistant'], config: {}
    })
    const persisted = getPersistedTurn(db, started.turnId)!
    const context = getTurnContext(db, session.id, persisted.contextBoundarySequence, persisted.userMessageId, persisted.excludeMessageIds ?? [])

    expect(persisted.excludeMessageIds).toEqual(['failed-assistant'])
    expect(context.map((message) => message.id)).toEqual(['sent-user'])
  })

  it('queued reuse 经 SQLite round-trip 后仍会从权威上下文排除指定消息', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'queued-retry-exclusions' })
    appendMessage(db, { id: 'failed-before-queue', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 1, status: 'failed' })
    const queued = enqueueQueuedUserMessage(db, {
      sessionId: session.id,
      requestId: 'queued-retry-request',
      content: 'queued retry'
    })
    const coordinator = new TurnCoordinator(createTurnCoordinatorStorage(db), {
      now: () => 3,
      id: (() => { let n = 0; return () => `queued-${++n}` })()
    })

    const started = coordinator.prepare({
      mode: 'reuse-user', requestId: 'queued-retry-request', sessionId: session.id,
      userMessageId: queued.persisted.message.id, excludeMessageIds: ['failed-before-queue'], config: {}
    })
    const persisted = getPersistedTurn(db, started.turnId)!
    const context = getTurnContext(db, session.id, persisted.contextBoundarySequence, persisted.userMessageId, persisted.excludeMessageIds ?? [])

    expect(persisted.excludeMessageIds).toEqual(['failed-before-queue'])
    expect(context.map((message) => message.id)).toEqual([queued.persisted.message.id])
  })

  it('将 coordinator storage 端口绑定到 SQLite', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'coordinator-storage' })
    const storage = createTurnCoordinatorStorage(db)
    const rows = storage.appendMany?.([
      { id: 'storage-u', sessionId: session.id, role: 'user', content: 'u', timestamp: 1, status: 'sent' },
      { id: 'storage-a', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' }
    ])
    expect(rows?.map((row) => row.message.id)).toEqual(['storage-u', 'storage-a'])
    storage.saveTurn?.({ turnId: 'storage-turn', requestId: 'storage-request', sessionId: session.id, assistantMessageId: 'storage-a', state: 'prepared' })
    expect(storage.getMessage('storage-a')?.status).toBe('streaming')
    expect(storage.listStreaming?.().map((message) => message.id)).toEqual(['storage-a'])
    expect(storage.updateIfStreaming?.('storage-a', { content: 'done', status: 'completed' })?.message.content).toBe('done')
    expect(storage.updateIfStreaming?.('storage-a', { content: 'late' })).toBeNull()
  })

  it('从 SQLite 恢复 requestId 幂等结果，而不是依赖进程内 Map', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'request-idempotency' })
    const storage = createTurnCoordinatorStorage(db)
    storage.appendMany?.([
      { id: 'request-user', sessionId: session.id, role: 'user', content: 'u', timestamp: 1, status: 'sent' },
      { id: 'request-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' }
    ])
    storage.saveTurn?.({ turnId: 'request-turn', requestId: 'request-key', sessionId: session.id, assistantMessageId: 'request-assistant', state: 'executing' })

    const restored = storage.findByRequestId(session.id, 'request-key')
    expect(restored).toMatchObject({
      turnId: 'request-turn',
      requestId: 'request-key',
      sessionId: session.id,
      assistantMessage: { id: 'request-assistant', content: 'partial' }
    })
  })

  it('跨 SQLite coordinator 实例拒绝同幂等键异载荷并保持零写入', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'persisted-fingerprint-conflict' })
    const first = new TurnCoordinator(createTurnCoordinatorStorage(db), { now: () => 1, id: (() => { let n = 0; return () => `first-${++n}` })() })
    first.prepare({ mode: 'create-user', requestId: 'stable-request', sessionId: session.id, input: { text: 'original' }, config: {} })
    const before = getMessagesPage(db, session.id, 0, 20).messages.map((message) => message.id)

    const restarted = new TurnCoordinator(createTurnCoordinatorStorage(db), { now: () => 2, id: () => 'must-not-write' })
    expect(() => restarted.prepare({ mode: 'create-user', requestId: 'stable-request', sessionId: session.id, input: { text: 'changed' }, config: {} }))
      .toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')
    expect(getMessagesPage(db, session.id, 0, 20).messages.map((message) => message.id)).toEqual(before)
    expect(listPersistedTurns(db)).toHaveLength(1)
  })

  it('冻结执行配置经 SQLite 重启恢复后仍参与幂等冲突检查', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'persisted-execution-config' })
    const first = new TurnCoordinator(createTurnCoordinatorStorage(db), { now: () => 1, id: (() => { let n = 0; return () => `config-${++n}` })() })
    const prepared = first.prepare({ mode: 'create-user', requestId: 'config-request', sessionId: session.id, input: { text: 'same' }, config: { lane: 'desktop', model: 'deepseek-chat', maxTokens: 4096 } })
    expect(getPersistedTurn(db, prepared.turnId)?.executionConfig).toEqual({ lane: 'desktop', model: 'deepseek-chat', maxTokens: 4096 })

    const restarted = new TurnCoordinator(createTurnCoordinatorStorage(db), { now: () => 2, id: () => 'must-not-write' })
    expect(() => restarted.prepare({ mode: 'create-user', requestId: 'config-request', sessionId: session.id, input: { text: 'same' }, config: { lane: 'desktop', model: 'deepseek-reasoner' } }))
      .toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')
    expect(listPersistedTurns(db)).toHaveLength(1)
  })

  it('SQLite 重启后用原冻结配置重放同一 request，设置漂移不会产生新写入', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'persisted-config-replay' })
    const originalConfig = { lane: 'desktop' as const, model: 'deepseek-chat', maxTokens: 4096, enableThinking: false, locale: 'zh-CN' }
    const first = new TurnCoordinator(createTurnCoordinatorStorage(db), { now: () => 1, id: (() => { let n = 0; return () => `replay-${++n}` })() })
    const original = first.prepare({ mode: 'create-user', requestId: 'replay-request', sessionId: session.id, input: { text: 'same' }, config: originalConfig })
    const beforeMessages = getMessagesPage(db, session.id, 0, 20).messages.map((message) => message.id)

    setConfigValue(db, 'config.model', 'deleted-model')
    setConfigValue(db, 'config.thinkingEnabled', 'true')
    setConfigValue(db, 'config.locale', 'en-US')
    const restarted = new TurnCoordinator(createTurnCoordinatorStorage(db), { now: () => 2, id: () => 'must-not-write' })
    const replayed = restarted.prepare({ mode: 'create-user', requestId: 'replay-request', sessionId: session.id, input: { text: 'same' }, config: originalConfig })

    expect(replayed).toMatchObject({ turnId: original.turnId, startToken: original.startToken, executionConfig: originalConfig })
    expect(getMessagesPage(db, session.id, 0, 20).messages.map((message) => message.id)).toEqual(beforeMessages)
    expect(listPersistedTurns(db)).toHaveLength(1)
  })

  it('恢复 requestId 时返回完整 user fact 和持久化 version', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'request-idempotency-complete' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'restore-user', sessionId: session.id, role: 'user', content: 'recover me', timestamp: 1, status: 'sent' },
      assistant: { id: 'restore-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' },
      turn: { turnId: 'restore-turn', requestId: 'restore-request', sessionId: session.id, assistantMessageId: 'restore-assistant', state: 'executing', version: 7, startToken: 'persisted-start-token' }
    })
    const restored = storage.findByRequestId(session.id, 'restore-request')
    expect(restored).toMatchObject({
      userMessage: { id: 'restore-user', content: 'recover me' },
      assistantMessage: { id: 'restore-assistant', content: 'partial' },
      version: 7,
      startToken: 'persisted-start-token'
    })
  })

  it('恢复已终止 requestId 时返回 terminal outcome 与 usage', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'request-terminal-recovery' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'terminal-user', sessionId: session.id, role: 'user', content: 'done', timestamp: 1, status: 'sent' },
      assistant: { id: 'terminal-assistant', sessionId: session.id, role: 'assistant', content: 'ok', timestamp: 1, status: 'completed' },
      turn: { turnId: 'terminal-turn', requestId: 'terminal-request', sessionId: session.id, userMessageId: 'terminal-user', assistantMessageId: 'terminal-assistant', state: 'terminal', version: 3, outcome: 'completed', usage: { input_tokens: 4, output_tokens: 2 }, startToken: 'terminal-token' }
    })
    expect(storage.findByRequestId(session.id, 'terminal-request')).toMatchObject({
      persistedOutcome: 'completed',
      persistedUsage: { input_tokens: 4, output_tokens: 2 }
    })
  })

  it('prepareAtomic 在 turn 回执失败时回滚两条消息', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'atomic-prepare' })
    const storage = createTurnCoordinatorStorage(db)
    expect(() => storage.prepareAtomic?.({
      user: { id: 'atomic-user', sessionId: session.id, role: 'user', content: 'u', timestamp: 1, status: 'sent' },
      assistant: { id: 'atomic-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' },
      turn: { turnId: 'atomic-turn', requestId: 'atomic-request', sessionId: 'wrong-session', assistantMessageId: 'atomic-assistant', state: 'prepared' }
    })).toThrow()
    expect(storage.getMessage('atomic-user')).toBeUndefined()
    expect(storage.getMessage('atomic-assistant')).toBeUndefined()
  })

  it('真实 SQLite checkpoint 允许固定 timer 合并 10000 个 rawDelta', () => {
    vi.useFakeTimers()
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'checkpoint-performance' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic!({
      user: { id: 'perf-user', sessionId: session.id, role: 'user', content: 'long', timestamp: 1, status: 'sent' },
      assistant: { id: 'perf-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' },
      turn: { turnId: 'perf-turn', requestId: 'perf-request', sessionId: session.id, userMessageId: 'perf-user', assistantMessageId: 'perf-assistant', state: 'executing', version: 0 }
    })
    const coordinator = new TurnCoordinator(storage, { now: () => 1, id: () => 'perf-id' })
    const turn = coordinator.prepare({ mode: 'create-user', requestId: 'perf-request', sessionId: session.id, input: { text: 'long' }, config: {} })
    const mergeStartedAt = performance.now()
    for (let i = 1; i <= 10_000; i++) coordinator.consume(turn.turnId, { type: 'content-delta', text: 'x'.repeat(32), eventSeq: i })
    coordinator.consume(turn.turnId, { type: 'preview-commit' })
    const mergeMs = performance.now() - mergeStartedAt
    vi.advanceTimersByTime(2_000)
    expect(storage.getMessage('perf-assistant')?.content).toHaveLength(320_000)
    expect(storage.findByRequestId(session.id, 'perf-request')?.version).toBe(10_001)
    console.log('[sqlite-turn-checkpoint-perf]', JSON.stringify({ rawDeltaCount: 10_000, mergeMs, checkpointWindowMs: 2_000, checkpointCount: 1 }))
    vi.useRealTimers()
  })

  it('关闭并重新打开 SQLite 后仍恢复 turn snapshot、error、usage 和 intent fingerprint', () => {
    const temp = createTempDatabase('sa-turn-restart-')
    const session = createSession(temp.db, { name: 'restart-recovery' })
    const firstStorage = createTurnCoordinatorStorage(temp.db)
    firstStorage.prepareAtomic?.({
      user: { id: 'restart-user', sessionId: session.id, role: 'user', content: 'restart', timestamp: 1, status: 'sent' },
      assistant: { id: 'restart-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'failed' },
      turn: { turnId: 'restart-turn', requestId: 'restart-request', sessionId: session.id, userMessageId: 'restart-user', assistantMessageId: 'restart-assistant', state: 'terminal', version: 6, outcome: 'failed', usage: { input_tokens: 8 }, error: { code: 'REMOTE_FAILED', message: 'remote failed' }, intentFingerprint: 'intent:restart', startToken: 'restart-token' }
    })
    temp.db.flushSave()
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const restored = createTurnCoordinatorStorage(reopened).findByRequestId(session.id, 'restart-request')
    expect(restored).toMatchObject({
      assistantMessage: { id: 'restart-assistant', content: 'partial', status: 'failed' },
      version: 6, startToken: 'restart-token', intentFingerprint: 'intent:restart',
      persistedOutcome: 'failed', persistedUsage: { input_tokens: 8 }, persistedError: { code: 'REMOTE_FAILED', message: 'remote failed' }
    })
    reopened.close()
    temp.cleanup()
  })

  it.each(['prepared', 'executing', 'waiting-confirm'] as const)('Runtime recover 对 %s turn 只做一次终态收敛', (state) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `recover-${state}` })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: `recover-${state}-user`, sessionId: session.id, role: 'user', content: 'recover', timestamp: 1, status: 'sent' },
      assistant: { id: `recover-${state}-assistant`, sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' },
      turn: { turnId: `recover-${state}-turn`, requestId: `recover-${state}-request`, sessionId: session.id, userMessageId: `recover-${state}-user`, assistantMessageId: `recover-${state}-assistant`, state }
    })
    const runtime = new TurnRuntime({ storage, deps: { now: () => 1, id: () => 'recovery-id' } })
    expect(runtime.recover()).toBe(1)
    expect(runtime.recover()).toBe(0)
    expect(storage.findByRequestId(session.id, `recover-${state}-request`)).toMatchObject({ persistedOutcome: 'recovered', assistantMessage: { status: 'failed' } })
  })

  it('若 canonical History 已完成但 persisted turn 尚未终结，重启恢复保留 assistant 成功结果', async () => {
    const temp = createTempDatabase('sa-history-turn-terminal-gap-')
    const db = temp.db
    const session = createSession(db, { name: 'history-turn-terminal-gap' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'history-gap-user', sessionId: session.id, role: 'user', content: 'answer', timestamp: 1, status: 'sent' },
      assistant: { id: 'history-gap-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'history-gap-turn', requestId: 'history-gap-request', sessionId: session.id, userMessageId: 'history-gap-user', assistantMessageId: 'history-gap-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: 'history-gap-request', turnId: 'history-gap-turn', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'answer' }], requiredUserMessage: { id: 'history-gap-user', message: { role: 'user', content: 'answer' } } } },
      { invocationId: 'history-gap-request', turnId: 'history-gap-turn', sequence: 3, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'canonical answer', usage: { inputTokens: 12, outputTokens: 3 } } }
    ], 1)
    db.flushSave()
    db.close()

    const reopened = openDatabase(temp.dbPath)
    const restartedStorage = createTurnCoordinatorStorage(reopened)
    const runtime = new TurnRuntime({ storage: restartedStorage, deps: { now: () => 4, id: () => 'history-gap-recovery' } })
    const persisted = listPersistedTurns(reopened, 'executing')[0]!
    expect(persisted.acceptedInputHistoryVersion).toBe(1)
    runtime.coordinator.restoreTurn(persisted, restartedStorage.getMessage(persisted.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(restartedStorage.findByRequestId(session.id, 'history-gap-request')).toMatchObject({
      persistedOutcome: 'completed',
      persistedUsage: { inputTokens: 12, outputTokens: 3 },
      assistantMessage: { content: 'canonical answer', status: 'completed' }
    })
    expect(runtime.getTurn('history-gap-turn')).toMatchObject({
      version: 1, persistedOutcome: 'completed', persistedUsage: { inputTokens: 12, outputTokens: 3 },
      assistantMessage: { status: 'completed' }
    })
    const recoveredHistory = await new SqliteAgentHistory(getDbConnection(reopened), 1, () => 5, session.id).read('history-gap-request')
    expect(recoveredHistory.events[0]).toMatchObject({
      turnId: 'history-gap-turn', sequence: 1,
      kind: 'session-input-committed',
      payload: { sessionId: session.id, messageId: 'history-gap-user', role: 'user', inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }
    })
    expect(recoveredHistory.events[1]).toMatchObject({
      turnId: 'history-gap-turn', kind: 'invocation-context-committed',
      payload: { requiredUserMessage: { id: 'history-gap-user' } }
    })
    expect(recoveredHistory.events.at(-1)).toMatchObject({
      invocationId: 'history-gap-request', turnId: 'history-gap-turn', kind: 'invocation-completed'
    })
    reopened.close()
    temp.cleanup()
  })

  it.each([
    { caseName: 'failed', kind: 'invocation-failed' as const, status: 'failed', expectedOutcome: 'failed', expectedMessageStatus: 'failed' },
    { caseName: 'cancelled', kind: 'invocation-interrupted' as const, status: 'cancelled', expectedOutcome: 'cancelled', expectedMessageStatus: 'cancelled' },
    { caseName: 'unknown-after-dispatch', kind: 'invocation-interrupted' as const, status: 'interrupted', expectedOutcome: 'recovered', expectedMessageStatus: 'failed' }
  ])('重启时以 canonical $caseName terminal 收敛尚未终结的 turn', async ({ caseName, kind, status, expectedOutcome, expectedMessageStatus }) => {
    const temp = createTempDatabase(`sa-history-turn-${caseName}-gap-`)
    const db = temp.db
    const session = createSession(db, { name: `history-turn-${caseName}-gap` })
    const requestId = `terminal-${caseName}-request`
    const turnId = `terminal-${caseName}-turn`
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId, content: 'request' })
    createTurnCoordinatorStorage(db).claimQueuedAtomic?.({
      sessionId: session.id, userMessageId: queued.persisted.message.id, turnId,
      assistantMessageId: `terminal-${caseName}-assistant`, requestId, state: 'executing'
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: requestId, turnId, sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'request' }], requiredUserMessage: { id: queued.persisted.message.id, message: { role: 'user', content: 'request' } } } },
      { invocationId: requestId, turnId, sequence: 3, schemaVersion: 1, eventId: 'canonical-terminal', idempotencyKey: 'canonical-terminal', kind, payload: { status, ...(caseName === 'unknown-after-dispatch' ? { reason: caseName } : {}) } }
    ], 1)
    db.flushSave()
    db.close()

    const reopened = openDatabase(temp.dbPath)
    const storage = createTurnCoordinatorStorage(reopened)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => `recover-${caseName}` } })
    const persisted = listPersistedTurns(reopened, 'executing')[0]!
    runtime.coordinator.restoreTurn(persisted, storage.getMessage(persisted.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.findByRequestId(session.id, `terminal-${caseName}-request`)).toMatchObject({
      persistedOutcome: expectedOutcome,
      assistantMessage: { status: expectedMessageStatus }
    })
    expect(runtime.coordinator.getTerminal(`terminal-${caseName}-turn`)).toMatchObject({ outcome: expectedOutcome })
    expect(getQueueInputReceipt(reopened, session.id, requestId)).toMatchObject({ state: expectedOutcome, turnId })
    const replayed = enqueueQueuedUserMessage(reopened, { sessionId: session.id, requestId, content: 'request' })
    expect(replayed.duplicate).toBe(true)
    expect(replayed.receipt.state).toBe(expectedOutcome)
    expect(() => storage.claimQueuedAtomic?.({
      sessionId: session.id, userMessageId: replayed.persisted.message.id, turnId: `${turnId}-duplicate`,
      assistantMessageId: `${turnId}-duplicate-assistant`, requestId
    })).toThrow('QUEUE_MESSAGE_NOT_CLAIMABLE')
    reopened.close()
    temp.cleanup()
  })

  it('completed recovery 按 ID 合并 partial checkpoint 与 canonical History 工具调用', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history-tool-checkpoint-gap' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'tool-gap-user', sessionId: session.id, role: 'user', content: 'read it', timestamp: 1, status: 'sent' },
      assistant: { id: 'tool-gap-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming', toolCalls: [{ id: 'read-1', toolName: 'read_file', input: { path: 'notes.txt' }, status: 'completed', riskLevel: 'medium', confirmedAt: 7, result: { success: true, data: 'file contents' } }] },
      turn: { turnId: 'tool-gap-turn', requestId: 'tool-gap-request', sessionId: session.id, userMessageId: 'tool-gap-user', assistantMessageId: 'tool-gap-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'read it' }], requiredUserMessage: { id: 'tool-gap-user', message: { role: 'user', content: 'read it' } } } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 3, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ id: 'read-1', name: 'read_file', input: { path: 'notes.txt' } }, { id: 'read-2', name: 'read_file', input: { path: 'other.txt' } }] } } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 4, schemaVersion: 1, eventId: 'approval-wait', idempotencyKey: 'approval-wait', kind: 'approval-waiting', payload: { toolCallId: 'read-1', approvalId: 'confirmation-1', answerer: 'user', reasonCode: 'sensitive-read', requestedAt: 30 } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 5, schemaVersion: 1, eventId: 'approval-resolved', idempotencyKey: 'approval-resolved', kind: 'approval-resolved', payload: { toolCallId: 'read-1', approvalId: 'confirmation-1', approved: true, outcome: 'approved', settledAt: 31 } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 6, schemaVersion: 1, eventId: 'started', idempotencyKey: 'started', kind: 'tool-call-started', payload: { toolCallId: 'read-1', toolName: 'read_file', inputHash: 'a'.repeat(64) } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 7, schemaVersion: 1, eventId: 'finished', idempotencyKey: 'finished', kind: 'tool-call-finished', payload: { toolCallId: 'read-1', success: true, result: { success: true, data: 'file contents' } } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 8, schemaVersion: 1, eventId: 'started-2', idempotencyKey: 'started-2', kind: 'tool-call-started', payload: { toolCallId: 'read-2', toolName: 'read_file', inputHash: 'b'.repeat(64) } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 9, schemaVersion: 1, eventId: 'finished-2', idempotencyKey: 'finished-2', kind: 'tool-call-finished', payload: { toolCallId: 'read-2', success: true, result: { success: true, data: 'other contents' } } },
      { invocationId: 'tool-gap-request', turnId: 'tool-gap-turn', sequence: 10, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'found it' } }
    ], 1)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'tool-gap-recovery' } })
    const turn = listPersistedTurns(db, 'executing')[0]!
    runtime.coordinator.restoreTurn(turn, storage.getMessage(turn.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.getMessage('tool-gap-assistant')).toMatchObject({
      status: 'completed', content: 'found it',
      toolCalls: [
        { id: 'read-1', toolName: 'read_file', input: { path: 'notes.txt' }, status: 'completed', confirmedAt: 7, result: { success: true, data: 'file contents' }, approval: { schemaVersion: 1, approvalId: 'confirmation-1', attemptId: 'tool-gap-request:approval:read-1', toolUseId: 'read-1', answerer: 'user', status: 'approved', reason: { summary: 'sensitive-read' }, requestedAt: 30, settledAt: 31, revision: 2 } },
        { id: 'read-2', toolName: 'read_file', input: { path: 'other.txt' }, status: 'completed', result: { success: true, data: 'other contents' } }
      ]
    })
  })

  it('completed recovery 以 canonical History 的工具状态和结果覆盖过期 checkpoint', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history-stale-tool-checkpoint' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'stale-tool-user', sessionId: session.id, role: 'user', content: 'read it', timestamp: 1, status: 'sent' },
      assistant: { id: 'stale-tool-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming', toolCalls: [
        { id: 'read-1', toolName: 'read_file', input: { path: 'notes.txt' }, status: 'failed', riskLevel: 'medium', confirmedAt: 7, result: { success: false, error: 'stale interruption' } },
        { id: 'orphan-checkpoint-call', toolName: 'run_shell', input: { command: 'echo stale' }, status: 'failed', riskLevel: 'high', result: { success: false, error: 'not in canonical history' } }
      ] },
      turn: { turnId: 'stale-tool-turn', requestId: 'stale-tool-request', sessionId: session.id, userMessageId: 'stale-tool-user', assistantMessageId: 'stale-tool-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: 'stale-tool-request', turnId: 'stale-tool-turn', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'read it' }], requiredUserMessage: { id: 'stale-tool-user', message: { role: 'user', content: 'read it' } } } },
      { invocationId: 'stale-tool-request', turnId: 'stale-tool-turn', sequence: 3, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ id: 'read-1', name: 'read_file', input: { path: 'notes.txt' } }] } } },
      { invocationId: 'stale-tool-request', turnId: 'stale-tool-turn', sequence: 4, schemaVersion: 1, eventId: 'started', idempotencyKey: 'started', kind: 'tool-call-started', payload: { toolCallId: 'read-1', toolName: 'read_file', inputHash: 'a'.repeat(64) } },
      { invocationId: 'stale-tool-request', turnId: 'stale-tool-turn', sequence: 5, schemaVersion: 1, eventId: 'finished', idempotencyKey: 'finished', kind: 'tool-call-finished', payload: { toolCallId: 'read-1', success: true, result: { success: true, data: 'canonical contents' } } },
      { invocationId: 'stale-tool-request', turnId: 'stale-tool-turn', sequence: 6, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'found it' } }
    ], 1)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'stale-tool-recovery' } })
    const turn = listPersistedTurns(db, 'executing')[0]!
    runtime.coordinator.restoreTurn(turn, storage.getMessage(turn.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.getMessage('stale-tool-assistant')?.toolCalls?.map(({ id }) => id)).toEqual(['read-1'])
    expect(storage.getMessage('stale-tool-assistant')?.toolCalls).toMatchObject([
      { id: 'read-1', status: 'completed', riskLevel: 'medium', confirmedAt: 7, result: { success: true, data: 'canonical contents' } }
    ])
  })

  it('completed recovery 清除 canonical History 未记录的 checkpoint 工具调用', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history-empty-tool-checkpoint' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'empty-tool-user', sessionId: session.id, role: 'user', content: 'answer', timestamp: 1, status: 'sent' },
      assistant: { id: 'empty-tool-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming', toolCalls: [{ id: 'stale-call', toolName: 'run_shell', input: { command: 'echo stale' }, status: 'failed', result: { success: false, error: 'stale checkpoint' } }] },
      turn: { turnId: 'empty-tool-turn', requestId: 'empty-tool-request', sessionId: session.id, userMessageId: 'empty-tool-user', assistantMessageId: 'empty-tool-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: 'empty-tool-request', turnId: 'empty-tool-turn', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'answer' }], requiredUserMessage: { id: 'empty-tool-user', message: { role: 'user', content: 'answer' } } } },
      { invocationId: 'empty-tool-request', turnId: 'empty-tool-turn', sequence: 3, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'no tools needed' } } },
      { invocationId: 'empty-tool-request', turnId: 'empty-tool-turn', sequence: 4, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'no tools needed' } }
    ], 1)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'empty-tool-recovery' } })
    const turn = listPersistedTurns(db, 'executing')[0]!
    runtime.coordinator.restoreTurn(turn, storage.getMessage(turn.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.getMessage('empty-tool-assistant')).toMatchObject({ status: 'completed', content: 'no tools needed' })
    expect(storage.getMessage('empty-tool-assistant')?.toolCalls).toBeUndefined()
  })

  it('completed recovery 从 canonical not-dispatched replayContent 重建被拒绝的工具记录', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history-not-dispatched-gap' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'not-dispatched-user', sessionId: session.id, role: 'user', content: 'run it', timestamp: 1, status: 'sent' },
      assistant: { id: 'not-dispatched-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'not-dispatched-turn', requestId: 'not-dispatched-request', sessionId: session.id, userMessageId: 'not-dispatched-user', assistantMessageId: 'not-dispatched-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: 'not-dispatched-request', turnId: 'not-dispatched-turn', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'run it' }], requiredUserMessage: { id: 'not-dispatched-user', message: { role: 'user', content: 'run it' } } } },
      { invocationId: 'not-dispatched-request', turnId: 'not-dispatched-turn', sequence: 3, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ id: 'denied-1', name: 'run_shell', input: { command: 'whoami' } }] } } },
      { invocationId: 'not-dispatched-request', turnId: 'not-dispatched-turn', sequence: 4, schemaVersion: 1, eventId: 'not-dispatched', idempotencyKey: 'not-dispatched', kind: 'tool-call-not-dispatched', payload: { toolCallId: 'denied-1', reason: 'POLICY_DENIED', replayContent: 'Tool call was not dispatched (POLICY_DENIED).', isError: true } },
      { invocationId: 'not-dispatched-request', turnId: 'not-dispatched-turn', sequence: 5, schemaVersion: 1, eventId: 'final-response', idempotencyKey: 'final-response', kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'I could not run it.' } } },
      { invocationId: 'not-dispatched-request', turnId: 'not-dispatched-turn', sequence: 6, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'I could not run it.' } }
    ], 1)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'not-dispatched-recovery' } })
    const turn = listPersistedTurns(db, 'executing')[0]!
    runtime.coordinator.restoreTurn(turn, storage.getMessage(turn.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.getMessage('not-dispatched-assistant')).toMatchObject({
      status: 'completed',
      toolCalls: [{ id: 'denied-1', status: 'rejected', result: { success: false, data: 'Tool call was not dispatched (POLICY_DENIED).', notExecuted: true } }]
    })
  })

  it('拒绝 turnId 不匹配的 completed History terminal，避免恢复串 turn 成功', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history-turn-owner-mismatch' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'owner-mismatch-user', sessionId: session.id, role: 'user', content: 'request', timestamp: 1, status: 'sent' },
      assistant: { id: 'owner-mismatch-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'sqlite-turn-owner', requestId: 'shared-request-id', sessionId: session.id, userMessageId: 'owner-mismatch-user', assistantMessageId: 'owner-mismatch-assistant', state: 'executing' }
    })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
    await history.appendBatch([
      { invocationId: 'shared-request-id', turnId: 'sqlite-turn-owner', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'request' }], requiredUserMessage: { id: 'owner-mismatch-user', message: { role: 'user', content: 'request' } } } },
      { invocationId: 'shared-request-id', turnId: 'sqlite-turn-owner', sequence: 3, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'belongs to another turn' } }
    ], 1)
    getDbConnection(db).prepare('UPDATE agent_history_events SET turn_id = ? WHERE invocation_id = ? AND sequence = 3').run('other-turn-owner', 'shared-request-id')
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'owner-mismatch-recovery' } })
    const turn = listPersistedTurns(db, 'executing')[0]!
    runtime.coordinator.restoreTurn(turn, storage.getMessage(turn.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.findByRequestId(session.id, 'shared-request-id')).toMatchObject({
      persistedOutcome: 'recovered',
      assistantMessage: { content: 'partial', status: 'failed' }
    })
  })

  it('malformed canonical tool proposal 不得被误判为无工具的 completed turn', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'history-malformed-tool-proposal' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'malformed-tool-user', sessionId: session.id, role: 'user', content: 'read', timestamp: 1, status: 'sent' },
      assistant: { id: 'malformed-tool-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'malformed-tool-turn', requestId: 'malformed-tool-request', sessionId: session.id, userMessageId: 'malformed-tool-user', assistantMessageId: 'malformed-tool-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([
      { invocationId: 'malformed-tool-request', turnId: 'malformed-tool-turn', sequence: 2, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'read' }], requiredUserMessage: { id: 'malformed-tool-user', message: { role: 'user', content: 'read' } } } },
      { invocationId: 'malformed-tool-request', turnId: 'malformed-tool-turn', sequence: 3, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ name: 'read_file' }] } } },
      { invocationId: 'malformed-tool-request', turnId: 'malformed-tool-turn', sequence: 4, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'claimed answer' } }
    ], 1)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'malformed-tool-recovery' } })
    const turn = listPersistedTurns(db, 'executing')[0]!
    runtime.coordinator.restoreTurn(turn, storage.getMessage(turn.assistantMessageId)!)

    expect(runtime.recover()).toBe(1)
    expect(storage.findByRequestId(session.id, 'malformed-tool-request')).toMatchObject({
      persistedOutcome: 'recovered',
      assistantMessage: { content: 'partial', status: 'failed' }
    })
  })

  it.each(['prepared', 'executing', 'waiting-confirm'] as const)('跨 SQLite 重启后 %s turn 可恢复并幂等 retry', async (state) => {
    const temp = createTempDatabase(`sa-turn-retry-${state}-`)
    const session = createSession(temp.db, { name: `restart-retry-${state}` })
    const firstStorage = createTurnCoordinatorStorage(temp.db)
    firstStorage.prepareAtomic!({
      user: { id: `restart-${state}-user`, sessionId: session.id, role: 'user', content: 'retry after restart', timestamp: 1, status: 'sent' },
      assistant: {
        id: `restart-${state}-assistant`, sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming',
        toolCalls: [{ id: `restart-${state}-shell`, toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'executing', riskLevel: 'high' }]
      },
      turn: { turnId: `restart-${state}-turn`, requestId: `restart-${state}-request`, sessionId: session.id, userMessageId: `restart-${state}-user`, assistantMessageId: `restart-${state}-assistant`, state, version: 2, startToken: `restart-${state}-token` }
    })
    temp.db.flushSave()
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const secondStorage = createTurnCoordinatorStorage(reopened)
    const runtime = new TurnRuntime({ storage: secondStorage, deps: { now: () => 2, id: () => `recovery-${state}` } })
    for (const persisted of listPersistedTurns(reopened, state)) {
      const assistant = secondStorage.getMessage(persisted.assistantMessageId)
      if (assistant) runtime.coordinator.restoreTurn(persisted, assistant)
    }
    expect(runtime.recover()).toBe(1)
    expect(runtime.recover()).toBe(0)

    const restored = runtime.prepare({ mode: 'create-user', requestId: `restart-${state}-request`, sessionId: session.id, input: { text: 'retry after restart' }, config: {} })
    const source = vi.fn()
    await expect(runtime.execute(restored.turnId, restored.startToken)).resolves.toMatchObject({ outcome: 'recovered' })
    expect(source).not.toHaveBeenCalled()
    expect(restored.assistantMessage.id).toBe(`restart-${state}-assistant`)
    expect(restored.assistantMessage.toolCalls).toEqual([
      expect.objectContaining({
        id: `restart-${state}-shell`,
        toolName: 'run_shell',
        status: 'failed',
        interrupted: true,
        result: { success: false, error: '工具调用因应用退出中断' }
      })
    ])
    reopened.close()
    temp.cleanup()
  })

  it.each([
    ['completed', { status: 'completed' as const, usage: { output_tokens: 3 } }],
    ['failed', { status: 'failed' as const, error: { code: 'REMOTE_FAILED', message: 'provider failed' } }],
    ['cancelled', { status: 'failed' as const }],
    ['timed-out', { status: 'failed' as const, error: { code: 'TURN_TIMEOUT', message: 'timed out' } }]
  ] as const)('跨 SQLite 重启后 %s terminal retry 不重新执行 source', async (outcome, terminal) => {
    const temp = createTempDatabase(`sa-terminal-retry-${outcome}-`)
    const session = createSession(temp.db, { name: `terminal-retry-${outcome}` })
    const firstStorage = createTurnCoordinatorStorage(temp.db)
    firstStorage.prepareAtomic!({
      user: { id: `terminal-${outcome}-user`, sessionId: session.id, role: 'user', content: 'terminal retry', timestamp: 1, status: 'sent' },
      assistant: { id: `terminal-${outcome}-assistant`, sessionId: session.id, role: 'assistant', content: 'final', timestamp: 1, status: terminal.status },
      turn: {
        turnId: `terminal-${outcome}-turn`, requestId: `terminal-${outcome}-request`, sessionId: session.id,
        userMessageId: `terminal-${outcome}-user`, assistantMessageId: `terminal-${outcome}-assistant`, state: 'terminal',
        version: 4, outcome, usage: terminal.usage, error: terminal.error, startToken: `terminal-${outcome}-token`
      }
    })
    temp.db.flushSave()
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const storage = createTurnCoordinatorStorage(reopened)
    const runtime = new TurnRuntime({ storage, deps: { now: () => 2, id: () => `terminal-retry-${outcome}` } })
    const persisted = storage.findByRequestId(session.id, `terminal-${outcome}-request`)
    expect(persisted).toMatchObject({ persistedOutcome: outcome })
    runtime.coordinator.restoreTurn({
      ...persisted!,
      assistantMessageId: persisted!.assistantMessage.id
    }, persisted!.assistantMessage)
    const prepared = runtime.prepare({ mode: 'create-user', requestId: `terminal-${outcome}-request`, sessionId: session.id, input: { text: 'terminal retry' }, config: {} })
    const source = vi.fn().mockResolvedValue({ outcome: 'completed' as const })

    await expect(runtime.execute(prepared.turnId, prepared.startToken, source)).resolves.toMatchObject({
      outcome,
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      ...(terminal.error ? { error: terminal.error } : {})
    })
    expect(source).not.toHaveBeenCalled()
    reopened.close()
    temp.cleanup()
  })

})
