import { describe, expect, it, vi } from 'vitest'
import type { Message } from './domainTypes'
import { normalizeTurnExecutionConfig, TurnCoordinator, type TurnStorage, type TurnStarted } from './turnCoordinator'
import type { AssistantFactEvent } from './assistantFactAggregator'
import { canonicalQueueInput } from './queueInputFingerprint'

const user: Message = { id: 'u1', sessionId: 's1', role: 'user', content: 'hi', timestamp: 1, status: 'sent', schemaVersion: 1 }
const assistant: Message = { id: 'a1', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming', schemaVersion: 1 }

function storage(): TurnStorage {
  const append = vi.fn().mockReturnValue({ message: assistant, sequence: 2 })
  const prepareAtomic = vi.fn(() => ({ user: { message: user, sequence: 1 }, assistant: { message: assistant, sequence: 2 } }))
  const update = vi.fn()
  return {
    findByRequestId: vi.fn(),
    getMessage: vi.fn().mockReturnValue(user),
    append,
    appendMany: vi.fn(() => [append(user), append(assistant)]),
    prepareAtomic,
    update,
    updateIfStreaming: update,
    claimQueuedAtomic: vi.fn(() => ({ user: { message: user, sequence: 1 }, assistant: { message: assistant, sequence: 2 } })),
    checkpoint: vi.fn().mockReturnValue(true),
    listUnfinishedTurns: vi.fn(() => []),
    recoverTurn: vi.fn().mockReturnValue(false),
    saveTurn: vi.fn(),
    updateTurnState: vi.fn()
  }
}

describe('TurnCoordinator', () => {
  it('冻结配置规范化时丢弃 API key 等未声明凭据字段', () => {
    const config = normalizeTurnExecutionConfig({ model: ' deepseek-chat ', baseUrl: 'https://api.deepseek.com/', apiKey: 'secret' } as never)
    expect(config).toEqual({ model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' })
    expect(config).not.toHaveProperty('apiKey')
  })

  it('create-user prepare 原子追加 user 和 streaming assistant', () => {
    const db = storage()
    const started = new TurnCoordinator(db, { now: () => 1, id: (() => { let n = 0; return () => `id-${++n}` })() }).prepare({ mode: 'create-user', requestId: 'r1', sessionId: 's1', input: { text: 'hi' }, config: {} })
    expect(db.prepareAtomic).toHaveBeenCalledTimes(1)
    expect(db.saveTurn).not.toHaveBeenCalled()
    expect(started).toMatchObject({ requestId: 'r1', sessionId: 's1', userMessage: user, assistantMessage: assistant, version: 0 })
  })

  it('create-user 将图片附件作为受信输入一起原子持久化', () => {
    const db = storage()
    db.prepareAtomic = vi.fn((input) => ({ user: { message: { ...input.user, schemaVersion: 1 } as Message, sequence: 1 }, assistant: { message: { ...input.assistant, schemaVersion: 1 } as Message, sequence: 2 } }))
    const attachment = { id: 'img-1', stagingKey: 'chat-attachments/s1/img-1.png', fileName: 'a.png', mimeType: 'image/png', byteLength: 10 }
    const started = new TurnCoordinator(db, { now: () => 1, id: (() => { let n = 0; return () => `id-${++n}` })() }).prepare({ mode: 'create-user', requestId: 'r-image', sessionId: 's1', input: { text: 'look', attachments: [attachment] }, config: {} })
    expect(started.userMessage?.attachments).toEqual([attachment])
  })

  it('同一 requestId 重复 prepare/execute 返回同一 turn，不重复启动 source', async () => {
    const db = storage()
    const source = vi.fn().mockResolvedValue({ outcome: 'completed' as const, message: { ...assistant, content: 'done' } })
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'turn-1' })
    const intent = { mode: 'create-user' as const, requestId: 'r1', sessionId: 's1', input: { text: 'hi' }, config: {} }
    const first = coordinator.prepare(intent)
    expect(coordinator.prepare(intent)).toBe(first)
    await Promise.all([coordinator.execute(first.turnId, first.startToken, source), coordinator.execute(first.turnId, first.startToken, source)])
    expect(source).toHaveBeenCalledTimes(1)
    expect(db.checkpoint).toHaveBeenCalledWith('turn-1', 0, expect.objectContaining({ content: '', status: 'completed' }))
  })

  it.each([
    ['create 文本变化', { mode: 'create-user' as const, requestId: 'conflict-r', sessionId: 's1', input: { text: 'changed' }, config: {} }],
    ['create 附件变化', { mode: 'create-user' as const, requestId: 'conflict-r', sessionId: 's1', input: { text: 'original', attachments: [{ id: 'changed-image', stagingKey: 'chat-attachments/s1/changed-image.png', fileName: 'changed.png', mimeType: 'image/png', byteLength: 10 }] }, config: {} }],
    ['create 改为 reuse', { mode: 'reuse-user' as const, requestId: 'conflict-r', sessionId: 's1', userMessageId: 'u1', excludeMessageIds: [], config: {} }],
    ['exclusions 变化', { mode: 'create-user' as const, requestId: 'conflict-r', sessionId: 's1', input: { text: 'original' }, excludeMessageIds: ['a1'], config: {} }]
  ])('同一幂等键遇到%s时拒绝且不产生新写入', (_label, conflictingIntent) => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'conflict-id' })
    coordinator.prepare({ mode: 'create-user', requestId: 'conflict-r', sessionId: 's1', input: { text: 'original' }, config: {} })

    expect(() => coordinator.prepare(conflictingIntent)).toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')
    expect(db.prepareAtomic).toHaveBeenCalledTimes(1)
    expect(db.append).not.toHaveBeenCalled()
  })

  it('legacy turn 缺少 fingerprint 时保持只读兼容并返回原 turn', () => {
    const db = storage()
    const legacy = { turnId: 'legacy-turn', requestId: 'legacy-r', sessionId: 's1', userMessage: user, assistantMessage: assistant, version: 0, startToken: 'legacy-token' }
    db.findByRequestId = vi.fn().mockReturnValue(legacy)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'unused' })

    expect(coordinator.prepare({ mode: 'create-user', requestId: 'legacy-r', sessionId: 's1', input: { text: 'unknown legacy payload' }, config: {} })).toBe(legacy)
    expect(db.prepareAtomic).not.toHaveBeenCalled()
  })

  it('legacy turn 有旧指纹但无执行快照时忽略配置漂移，只核对消息意图', () => {
    const db = storage()
    const originalIntent = { mode: 'create-user' as const, requestId: 'legacy-fingerprint-r', sessionId: 's1', input: { text: 'hi' }, excludeMessageIds: [], config: { model: 'old-model', maxTokens: 4096 } }
    const firstCoordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'unused' })
    const intentFingerprint = JSON.stringify({ mode: originalIntent.mode, input: canonicalQueueInput(originalIntent.input), excludeMessageIds: [], config: originalIntent.config })
    const legacy = { turnId: 'legacy-fingerprint-turn', requestId: originalIntent.requestId, sessionId: 's1', userMessage: user, assistantMessage: assistant, version: 0, startToken: 'legacy-token', intentFingerprint }
    db.findByRequestId = vi.fn().mockReturnValue(legacy)

    expect(firstCoordinator.prepare({ ...originalIntent, config: { model: 'new-model', maxTokens: 8192 } })).toBe(legacy)
    expect(() => firstCoordinator.prepare({ ...originalIntent, input: { text: 'changed' }, config: { model: 'new-model' } }))
      .toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')
    expect(db.prepareAtomic).not.toHaveBeenCalled()
  })

  it.each([
    ['model', { model: 'deepseek-chat' }, { model: 'deepseek-reasoner' }],
    ['options', { maxTokens: 4096, enableThinking: false }, { maxTokens: 8192, enableThinking: true }],
    ['system', { system: 'trusted system' }, { system: 'changed system' }]
  ])('同一幂等键的 %s 配置变化在 prepare 阶段冲突', (_field, originalConfig, changedConfig) => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'config-id' })
    coordinator.prepare({ mode: 'create-user', requestId: 'config-r', sessionId: 's1', input: { text: 'same' }, config: originalConfig })

    expect(() => coordinator.prepare({ mode: 'create-user', requestId: 'config-r', sessionId: 's1', input: { text: 'same' }, config: changedConfig }))
      .toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')
    expect(db.prepareAtomic).toHaveBeenCalledTimes(1)
  })

  it('terminal 后重复 execute 返回同一终态，不重新调用 source', async () => {
    const db = storage()
    const source = vi.fn().mockResolvedValue({ outcome: 'completed' as const, usage: { output_tokens: 2 } })
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'terminal-id' })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'terminal-repeat', sessionId: 's1', input: { text: 'hi' }, config: {} })
    const first = await coordinator.execute(started.turnId, started.startToken, source)
    const second = await coordinator.execute(started.turnId, started.startToken, source)
    expect(first).toMatchObject({ outcome: 'completed', usage: { output_tokens: 2 } })
    expect(second).toEqual(first)
    expect(source).toHaveBeenCalledOnce()
  })

  it('从持久化终态恢复后重复 execute 直接返回结果，不再次执行 source', async () => {
    const db = storage()
    const restored: TurnStarted = {
      turnId: 'restored-terminal', requestId: 'r-restored-terminal', sessionId: 's1', userMessage: user,
      assistantMessage: { ...assistant, status: 'completed', content: 'already done' }, version: 4,
      startToken: 'restored-token', persistedOutcome: 'completed', persistedUsage: { output_tokens: 3 }
    }
    db.findByRequestId = vi.fn().mockReturnValue(restored)
    const source = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const prepared = coordinator.prepare({ mode: 'create-user', requestId: restored.requestId, sessionId: 's1', input: { text: 'hi' }, config: {} })
    await expect(coordinator.execute(prepared.turnId, prepared.startToken, source)).resolves.toMatchObject({ outcome: 'completed', usage: { output_tokens: 3 } })
    expect(source).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled', 'timed-out'] as const)('恢复 %s turn 后 retry 不会再次执行 source', async (outcome) => {
    const db = storage()
    const restored: TurnStarted = {
      turnId: `restored-${outcome}`, requestId: `r-${outcome}`, sessionId: 's1',
      assistantMessage: { ...assistant, status: outcome === 'failed' ? 'failed' : 'completed' }, version: 2,
      startToken: `${outcome}-token`, persistedOutcome: outcome
    }
    db.findByRequestId = vi.fn().mockReturnValue(restored)
    const source = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const prepared = coordinator.prepare({ mode: 'create-user', requestId: restored.requestId, sessionId: restored.sessionId, input: { text: 'retry' }, config: {} })
    await expect(coordinator.execute(prepared.turnId, prepared.startToken, source)).resolves.toMatchObject({ outcome })
    expect(source).not.toHaveBeenCalled()
  })

  it('恢复失败 turn 后 retry 返回持久化 error，不重新执行 source', async () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const restored = coordinator.restoreTurn({ turnId: 'failed-error-turn', requestId: 'failed-error-request', sessionId: 's1', assistantMessageId: 'a1', state: 'terminal', version: 4, outcome: 'failed', usage: { input_tokens: 1 }, error: { code: 'REMOTE_FAILED', message: 'persisted failure' }, startToken: 'persisted-token' }, { ...assistant, status: 'failed' })
    const source = vi.fn()
    await expect(coordinator.execute(restored.turnId, restored.startToken, source)).resolves.toMatchObject({ outcome: 'failed', usage: { input_tokens: 1 }, error: { code: 'REMOTE_FAILED', message: 'persisted failure' } })
    expect(source).not.toHaveBeenCalled()
  })

  it('恢复 turn 时按持久化因果关联恢复 user fact', () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })

    const restored = coordinator.restoreTurn({
      turnId: 'restore-user-turn',
      requestId: 'restore-user-request',
      sessionId: 's1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      state: 'executing',
      version: 2,
      startToken: 'restore-user-token',
      excludeMessageIds: ['excluded-assistant']
    }, assistant)

    expect(db.getMessage).toHaveBeenCalledWith('u1')
    expect(restored.userMessage).toEqual(user)
    expect(restored.excludeMessageIds).toEqual(['excluded-assistant'])
  })

  it('同一 session 已有活动 turn 时拒绝新的 create-user prepare', () => {
    const db = storage()
    db.hasActiveTurn = vi.fn().mockReturnValue(true)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    expect(() => coordinator.prepare({ mode: 'create-user', requestId: 'r-busy', sessionId: 's1', input: { text: 'second' }, config: {} })).toThrow('SESSION_TURN_BUSY')
    expect(db.append).not.toHaveBeenCalled()
  })

  it('listActive 只返回当前内存中的非终态 turn', () => {
    const db = storage()
    let sequence = 0
    db.append = vi.fn((message) => ({ message: { ...message, schemaVersion: 1 } as Message, sequence: sequence++ }))
    db.prepareAtomic = vi.fn((input) => ({
      user: db.append(input.user),
      assistant: db.append(input.assistant)
    }))
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: (() => { let n = 0; return () => `id-${++n}` })() })
    const active = coordinator.prepare({ mode: 'create-user', requestId: 'r-active', sessionId: 's1', input: { text: 'active' }, config: {} })
    const done = coordinator.prepare({ mode: 'create-user', requestId: 'r-done', sessionId: 's2', input: { text: 'done' }, config: {} })
    coordinator.consume(done.turnId, { type: 'source-completed' })
    expect(coordinator.listActive()).toEqual([expect.objectContaining({ turnId: active.turnId })])
  })

  it('reuse-user 只追加 assistant，并拒绝跨 session 或非 user 目标', () => {
    const db = storage()
    const excludedAssistant = { ...assistant, id: 'failed-a', status: 'failed' as const }
    db.getMessage = vi.fn((id) => id === 'u1' ? user : id === 'failed-a' ? excludedAssistant : undefined)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'a2' })
    const result = coordinator.prepare({ mode: 'reuse-user', requestId: 'r2', sessionId: 's1', userMessageId: 'u1', excludeMessageIds: ['failed-a'], config: {} })
    expect(db.append).toHaveBeenCalledTimes(1)
    expect(result.userMessage).toBe(user)
    expect(result.excludeMessageIds).toEqual(['failed-a'])
    expect(db.saveTurn).toHaveBeenCalledWith(expect.objectContaining({
      userMessageId: 'u1',
      excludeMessageIds: ['failed-a']
    }))
    expect(() => coordinator.prepare({ mode: 'reuse-user', requestId: 'r3', sessionId: 's2', userMessageId: 'u1', excludeMessageIds: [], config: {} })).toThrow(/session/i)
  })

  it('queued reuse 认领时传递完整 exclusions', () => {
    const db = storage()
    const queuedUser = { ...user, status: 'queued' as const }
    const excludedAssistant = { ...assistant, id: 'failed-a', status: 'failed' as const }
    db.getMessage = vi.fn((id) => id === 'u1' ? queuedUser : id === 'failed-a' ? excludedAssistant : undefined)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: (() => { let n = 0; return () => `queued-${++n}` })() })

    const result = coordinator.prepare({
      mode: 'reuse-user', requestId: 'queued-r', sessionId: 's1',
      userMessageId: 'u1', excludeMessageIds: ['failed-a'], config: {}
    })

    expect(result.excludeMessageIds).toEqual(['failed-a'])
    expect(db.claimQueuedAtomic).toHaveBeenCalledWith(expect.objectContaining({
      userMessageId: 'u1',
      excludeMessageIds: ['failed-a']
    }))
  })

  it('prepare 拒绝跨 session exclude，并禁止排除 required user', () => {
    const db = storage()
    db.getMessage = vi.fn((id) => id === 'u1' ? user : id === 'other' ? { ...user, id: 'other', sessionId: 's2' } : undefined)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    expect(() => coordinator.prepare({ mode: 'reuse-user', requestId: 'r-exclude-1', sessionId: 's1', userMessageId: 'u1', excludeMessageIds: ['other'], config: {} })).toThrow(/exclude.*session/i)
    expect(() => coordinator.prepare({ mode: 'reuse-user', requestId: 'r-exclude-2', sessionId: 's1', userMessageId: 'u1', excludeMessageIds: ['u1'], config: {} })).toThrow(/required.*user/i)
  })

  it('consume 通过同一 reducer 生成递增版本，并在终态边界立即 checkpoint', () => {
    const db = storage()
    const checkpoint = vi.fn()
    vi.useFakeTimers()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r4', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'hello' })
    expect(checkpoint).not.toHaveBeenCalled()
    coordinator.consume(started.turnId, { type: 'source-completed' })
    vi.useRealTimers()
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(started.turnId, 2, expect.objectContaining({ content: 'hello', status: 'completed' }))
  })

  it('重复/倒退 eventSeq 幂等忽略，正文序号缺口拒绝继续消费', () => {
    const db = storage()
    const checkpoint = vi.fn()
    vi.useFakeTimers()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-seq', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'a', eventSeq: 1 })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'duplicate', eventSeq: 1 })
    expect(() => coordinator.consume(started.turnId, { type: 'content-delta', text: 'gap', eventSeq: 3 })).toThrow('TURN_EVENT_SEQUENCE_GAP')
    expect(coordinator.consume(started.turnId, { type: 'content-delta', text: 'b', eventSeq: 2 }).assistantMessage.content).toBe('ab')
    vi.advanceTimersByTime(2_000)
    vi.useRealTimers()
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })

  it('忽略终态后的迟到事件，并使用 expectedVersion checkpoint', () => {
    const db = storage()
    const checkpoint = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r5', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'source-completed' })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'late' })
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(started.turnId, 1, expect.objectContaining({ status: 'completed', content: '' }))
  })

  it('checkpoint 优先使用条件更新端口', () => {
    const db = storage()
    db.checkpoint = vi.fn().mockReturnValue(true)
    vi.useFakeTimers()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r6', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'x' })
    vi.advanceTimersByTime(2_000)
    vi.useRealTimers()
    expect(db.checkpoint).toHaveBeenCalledWith('id', 1, expect.objectContaining({ content: 'x' }))
    expect(db.update).not.toHaveBeenCalled()
  })

  it('checkpoint 写入失败后保留最新 snapshot 并重试，成功后不重复写入', () => {
    vi.useFakeTimers()
    const db = storage()
    const checkpoint = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-checkpoint-retry', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'latest' })
    vi.advanceTimersByTime(2_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenLastCalledWith(started.turnId, 1, expect.objectContaining({ content: 'latest' }))
    vi.advanceTimersByTime(100)
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(checkpoint).toHaveBeenLastCalledWith(started.turnId, 1, expect.objectContaining({ content: 'latest' }))
    vi.advanceTimersByTime(2_000)
    expect(checkpoint).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('checkpoint adapter 抛出 DB error 时不泄漏到 timer，并按相同策略重试', () => {
    vi.useFakeTimers()
    const db = storage()
    const checkpoint = vi.fn().mockImplementationOnce(() => { throw new Error('SQLITE_BUSY') }).mockReturnValueOnce(true)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-checkpoint-db-error', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'safe retry' })
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow()
    expect(checkpoint).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(checkpoint).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('异步 checkpoint 在同一 turn 内串行化，不允许重叠写入', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const versions: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const checkpoint = vi.fn(async (_turnId: string, version: number) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      versions.push(version)
      if (version === 2) await firstGate
      inFlight--
      return true
    })
    const coordinator = new TurnCoordinator(storage(), { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-async-checkpoint', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'tool-use', id: 'tool-1', toolName: 'run_shell', input: {} })
    coordinator.consume(started.turnId, { type: 'confirm-requested', id: 'tool-1', riskLevel: 'high' })
    coordinator.consume(started.turnId, { type: 'tool-result', id: 'tool-1', result: { success: true, output: 'ok' } })
    expect(maxInFlight).toBe(1)
    releaseFirst()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(maxInFlight).toBe(1)
    expect(versions).toEqual([2, 3])
  })

  it('异步 timer 写入失败晚于 terminal 时不再安排旧 retry timer', async () => {
    vi.useFakeTimers()
    let rejectTimer!: (error: Error) => void
    let resolveTerminal!: (value: boolean) => void
    const timerWrite = new Promise<boolean>((_, reject) => { rejectTimer = reject })
    const terminalWrite = new Promise<boolean>((resolve) => { resolveTerminal = resolve })
    const checkpoint = vi.fn()
      .mockReturnValueOnce(timerWrite)
      .mockReturnValueOnce(terminalWrite)
    const coordinator = new TurnCoordinator(storage(), { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-async-late', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'partial' })
    vi.advanceTimersByTime(2_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)

    coordinator.consume(started.turnId, { type: 'source-completed' })
    rejectTimer(new Error('late SQLITE_BUSY'))
    await Promise.resolve()
    await Promise.resolve()
    expect(checkpoint).toHaveBeenCalledTimes(2)
    resolveTerminal(true)
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(10_000)
    expect(checkpoint).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('checkpoint 连续失败达到上限后停止重试，但保留最新内存 snapshot', () => {
    vi.useFakeTimers()
    const db = storage()
    const checkpoint = vi.fn().mockReturnValue(false)
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-checkpoint-limit', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'must remain in memory' })
    vi.advanceTimersByTime(2_000)
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(100)
    expect(checkpoint).toHaveBeenCalledTimes(4)
    expect(coordinator.getTurn(started.turnId)?.assistantMessage.content).toBe('must remain in memory')
    vi.advanceTimersByTime(10_000)
    expect(checkpoint).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it.each([
    ['confirm-requested', { type: 'confirm-requested', id: 'tool-1', riskLevel: 'high' as const }],
    ['tool-confirmed', { type: 'tool-confirmed', id: 'tool-1', approved: true }],
    ['tool-result', { type: 'tool-result', id: 'tool-1', result: { success: true, output: 'ok' } }]
  ] as const)('%s 在 2 秒 timer 到期前立即 checkpoint 最新 snapshot', (_name, boundary) => {
    vi.useFakeTimers()
    const db = storage()
    const checkpoint = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: `r-${_name}`, sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'tool-use', id: 'tool-1', toolName: 'run_shell', input: {} })
    coordinator.consume(started.turnId, boundary)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(started.turnId, 2, expect.objectContaining({ toolCalls: expect.any(Array) }))
    vi.advanceTimersByTime(2_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('source 抛错时统一 finalize assistant 为 failed，并继续抛出原错误', async () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r7', sessionId: 's1', input: { text: 'hi' }, config: {} })
    const error = new Error('provider failed')
    await expect(coordinator.execute(started.turnId, started.startToken, async () => { throw error })).rejects.toBe(error)
    expect(db.checkpoint).toHaveBeenCalledWith('id', 0, expect.objectContaining({ status: 'failed' }))
  })

  it('source 抛错时 finalize 使用最新 reducer snapshot，不覆盖已消费的正文', async () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r7-latest', sessionId: 's1', input: { text: 'hi' }, config: {} })
    await expect(coordinator.execute(started.turnId, started.startToken, async () => {
      coordinator.consume(started.turnId, { type: 'content-delta', text: '已经到达的正文' })
      throw new Error('provider failed')
    })).rejects.toThrow('provider failed')
    expect(db.checkpoint).toHaveBeenLastCalledWith('id', 1, expect.objectContaining({ content: '已经到达的正文', status: 'failed' }))
  })

  it('source 返回的旧式 Message 不得覆盖 reducer 已产生的事实', async () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-message', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: '事实正文' })
    coordinator.consume(started.turnId, { type: 'source-completed' })
    await coordinator.execute(started.turnId, started.startToken, async () => ({
      outcome: 'completed' as const,
      message: { ...assistant, content: 'source 伪造正文', status: 'completed' as const }
    }))
    expect(db.update).not.toHaveBeenCalledWith('a1', expect.objectContaining({ content: 'source 伪造正文' }))
  })

  it('source 直接返回 terminal 时立即 checkpoint 最新终态并取消 late timer', async () => {
    vi.useFakeTimers()
    const db = storage()
    const checkpoint = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-direct-terminal', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'latest' })
    await coordinator.execute(started.turnId, started.startToken, async () => ({ outcome: 'completed' as const }))
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(started.turnId, 1, expect.objectContaining({ content: 'latest', status: 'completed' }))
    vi.advanceTimersByTime(2_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('cancel 会进入 finishing，窗口到期后才 finalize assistant', async () => {
    const db = storage()
    const cancel = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, undefined, cancel)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r8', sessionId: 's1', input: { text: 'hi' }, config: {} })
    const source = vi.fn(() => new Promise<never>(() => undefined))
    vi.useFakeTimers()
    void coordinator.execute(started.turnId, started.startToken, source)
    coordinator.cancel(started.turnId)
    expect(cancel).toHaveBeenCalledWith(started.turnId)
    expect(db.update).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    vi.useRealTimers()
    expect(db.checkpoint).toHaveBeenCalledWith('id', 1, expect.objectContaining({ status: 'failed' }))
    expect(coordinator.cancel(started.turnId)).toBe(false)
  })

  it('cancel race 在普通 checkpoint timer 到期前也会刷出最新终态 snapshot', () => {
    vi.useFakeTimers()
    const db = storage()
    const checkpoint = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id', finishingWindowMs: 5_000 }, checkpoint, vi.fn())
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-cancel-checkpoint', sessionId: 's1', input: { text: 'hi' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'before cancel' })
    expect(coordinator.cancel(started.turnId)).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(started.turnId, 2, expect.objectContaining({ content: 'before cancel', status: 'failed' }))
    vi.advanceTimersByTime(2_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('timeout 会中止活动 source 并只 finalize 一次', () => {
    const db = storage()
    const cancel = vi.fn()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, undefined, cancel)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r9', sessionId: 's1', input: { text: 'hi' }, config: {} })
    expect(coordinator.timeout(started.turnId)).toBe(true)
    expect(coordinator.timeout(started.turnId)).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(db.checkpoint).toHaveBeenCalledTimes(1)
    expect(db.checkpoint).toHaveBeenCalledWith('id', 1, expect.objectContaining({ status: 'failed' }))
    expect(coordinator.getTerminal(started.turnId)).toMatchObject({ outcome: 'timed-out', version: 1 })
  })

  it('取消先被接受后，迟到的 source completed 不得覆盖 cancelled outcome', async () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-race', sessionId: 's1', input: { text: 'hi' }, config: {} })
    let resolveSource!: (value: { outcome: 'completed' }) => void
    void coordinator.execute(started.turnId, started.startToken, () => new Promise((resolve) => { resolveSource = resolve }))
    expect(coordinator.cancel(started.turnId)).toBe(true)
    resolveSource({ outcome: 'completed' })
    await Promise.resolve()
    expect(coordinator.getTerminal(started.turnId)).toMatchObject({ outcome: 'cancelled' })
  })

  it('finishing 窗口只接受在途工具结果，屏蔽新的 tool-use 和 source completed', () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id', finishingWindowMs: 5_000 }, undefined, vi.fn())
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-finishing', sessionId: 's1', input: { text: 'hi' }, config: {} })
    const source = vi.fn(() => new Promise<never>(() => undefined))
    vi.useFakeTimers()
    void coordinator.execute(started.turnId, started.startToken, source)
    coordinator.cancel(started.turnId)
    coordinator.consume(started.turnId, { type: 'tool-use', id: 'new-tool', toolName: 'run_shell', input: {} })
    coordinator.consume(started.turnId, { type: 'tool-result', id: 'old-tool', result: { success: false, error: 'interrupted' } })
    expect(coordinator.getTurn(started.turnId)?.assistantMessage.toolCalls ?? []).toHaveLength(0)
    vi.advanceTimersByTime(5_000)
    vi.useRealTimers()
  })

  it('性能基准：10000 个 rawDelta 保持单调版本且只安排一个最长 2 秒 checkpoint', () => {
    const db = storage()
    let checkpointDurationMs = 0
    const checkpoint = vi.fn(() => {
      const startedAt = performance.now()
      const duration = performance.now() - startedAt
      checkpointDurationMs += duration
    })
    vi.useFakeTimers()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' }, checkpoint)
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-perf', sessionId: 's1', input: { text: 'long' }, config: {} })
    const start = performance.now()
    for (let i = 1; i <= 10_000; i++) {
      coordinator.consume(started.turnId, { type: 'content-delta', text: 'x'.repeat(32), eventSeq: i })
    }
    const elapsedMs = performance.now() - start
    const current = coordinator.getTurn(started.turnId)!
    expect(current.version).toBe(10_000)
    expect(current.assistantMessage.content).toHaveLength(320_000)
    expect(checkpoint).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_999)
    expect(checkpoint).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(elapsedMs).toBeLessThan(2_000)
    // 保留本机门槛所需的最小可观测指标：事件处理、checkpoint 次数、持久化回调耗时。
    console.log('[turn-coordinator-perf]', JSON.stringify({ rawDeltaCount: 10_000, elapsedMs, checkpointCount: checkpoint.mock.calls.length, checkpointDurationMs }))
  })

  it('为同一 turn 输出事件处理与 checkpoint 持久化指标', () => {
    const db = storage()
    const metrics: Array<{ kind: string; turnId: string; version: number }> = []
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id', onMetric: (metric) => metrics.push(metric as never) })
    const started = coordinator.prepare({ mode: 'create-user', requestId: 'r-metrics', sessionId: 's1', input: { text: 'metrics' }, config: {} })
    coordinator.consume(started.turnId, { type: 'content-delta', text: 'hello', eventSeq: 1 })
    coordinator.consume(started.turnId, { type: 'source-completed' })
    expect(metrics.filter((metric) => metric.kind === 'event').map((metric) => metric.version)).toEqual([1, 2])
    expect(metrics.filter((metric) => metric.kind === 'checkpoint').map((metric) => metric.version)).toEqual([2])
    expect(metrics.every((metric) => metric.turnId === started.turnId)).toBe(true)
  })

  it('recover 会关闭孤儿 streaming turn，并重复执行保持幂等', () => {
    const db = storage()
    db.listStreaming = vi.fn().mockReturnValue([assistant])
    db.update = vi.fn().mockReturnValue({ message: { ...assistant, status: 'failed' }, sequence: 1 })
    db.updateIfStreaming = db.update
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: () => 'id' })
    expect(coordinator.recover()).toBe(1)
    expect(coordinator.recover()).toBe(0)
    expect(db.update).toHaveBeenCalledWith('a1', expect.objectContaining({ status: 'failed' }))
  })

  it('restoreTurn 保留持久 turn 的 version 和 startToken', () => {
    const db = storage()
    const coordinator = new TurnCoordinator(db, { now: () => 1, id: (() => { let n = 0; return () => `new-${++n}` })() })
    const restored = coordinator.restoreTurn({ turnId: 'old-turn', requestId: 'old-request', sessionId: 's1', assistantMessageId: 'a1', state: 'executing', version: 8, startToken: 'persisted-token' }, assistant)
    expect(restored.startToken).toBe('persisted-token')
    expect(restored.version).toBe(8)
    expect(restored.assistantMessage).toBe(assistant)
    expect(coordinator.getTerminal(restored.turnId)).toBeUndefined()
  })
})
