import { describe, expect, it, vi } from 'vitest'
import { TurnRuntime } from './turnRuntime'
import type { TurnStorage } from '../src/shared/turnCoordinator'

function storage(): TurnStorage {
  const user = { id: 'u1', sessionId: 's1', role: 'user' as const, content: 'hi', timestamp: 1, status: 'sent' as const }
  const assistant = { id: 'a1', sessionId: 's1', role: 'assistant' as const, content: '', timestamp: 1, status: 'streaming' as const }
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

describe('TurnRuntime', () => {
  it.each([
    ['no-tools', [{ type: 'content-delta', text: 'answer' }, { type: 'source-completed' }]],
    ['tools', [
      { type: 'content-delta', text: 'before tool' },
      { type: 'tool-use', id: 'tool-1', toolName: 'run_shell', input: {} },
      { type: 'tool-result', id: 'tool-1', result: { success: true, output: 'ok' } },
      { type: 'source-completed' }
    ]]
  ] as const)('同一 Runtime 统一处理 %s 主链路并保持 projection 顺序', (name, events) => {
    const projected: Array<{ version: number; type: string }> = []
    const runtime = new TurnRuntime({
      storage: storage(),
      deps: { now: () => 1, id: (() => { let n = 0; return () => `event-id-${++n}` })() },
      source: vi.fn() as never,
      onEvent: (turn, event) => projected.push({ version: turn.version, type: event.type })
    })
    const turn = runtime.prepare({ mode: 'create-user', requestId: `matrix-${name}`, sessionId: 's1', input: { text: name }, config: {} })
    for (const event of events) runtime.consume(turn.turnId, event)
    expect(projected.map((entry) => entry.type)).toEqual(events.map((event) => event.type))
    expect(projected.map((entry) => entry.version)).toEqual(events.map((_, index) => index + 1))
    expect(runtime.coordinator.getTurn(turn.turnId)?.assistantMessage.status).toBe('completed')
  })

  it('桌面生命周期 fixture 覆盖普通发送、确认、工具结果、terminal 和 projection 顺序', () => {
    const projected: Array<{ version: number; type: string; status: string }> = []
    const runtime = new TurnRuntime({
      storage: storage(),
      deps: { now: () => 1, id: (() => { let n = 0; return () => `desktop-id-${++n}` })() },
      onEvent: (turn, event) => projected.push({ version: turn.version, type: event.type, status: turn.assistantMessage.status })
    })
    const prepared = runtime.prepare({ mode: 'create-user', requestId: 'desktop-lifecycle', sessionId: 's1', input: { text: 'run tool' }, config: {} })
    runtime.bindRequest(prepared.requestId, prepared.turnId)
    runtime.consumeForRequest(prepared.requestId, { type: 'content-delta', text: 'before' })
    runtime.consumeForRequest(prepared.requestId, { type: 'tool-use', id: 'tool-1', toolName: 'run_shell', input: {} })
    runtime.consumeForRequest(prepared.requestId, { type: 'confirm-requested', id: 'tool-1', riskLevel: 'high' })
    runtime.consumeForRequest(prepared.requestId, { type: 'tool-confirmed', id: 'tool-1', approved: true })
    runtime.consumeForRequest(prepared.requestId, { type: 'tool-result', id: 'tool-1', result: { success: true, output: 'ok' } })
    runtime.consumeForRequest(prepared.requestId, { type: 'source-completed' })

    expect(projected.map(({ type }) => type)).toEqual([
      'content-delta', 'tool-use', 'confirm-requested', 'tool-confirmed', 'tool-result', 'source-completed'
    ])
    expect(projected.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6])
    expect(projected.at(-1)).toMatchObject({ status: 'completed', type: 'source-completed' })
    expect(runtime.listActive('s1')).toEqual([])
  })

  it('保持单一 coordinator owner，并把 source 事件交给 projection', async () => {
    const events: unknown[] = []
    const source = vi.fn(async () => {
      return { outcome: 'completed' as const }
    })
    const runtime = new TurnRuntime({
      storage: storage(),
      deps: { now: () => 1, id: (() => { let n = 0; return () => `id-${++n}` })() },
      source: source as never,
      onEvent: (_turn, event) => events.push(event)
    })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'r1', sessionId: 's1', input: { text: 'hi' }, config: {} })
    runtime.consume(turn.turnId, { type: 'content-delta', text: 'hello' })
    await runtime.execute(turn.turnId, turn.startToken)
    expect(events).toEqual([{ type: 'content-delta', text: 'hello' }])
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('按 requestId 路由事件，并在 terminal 后解绑', () => {
    const runtime = new TurnRuntime({ storage: storage(), deps: { now: () => 1, id: () => 'id' }, source: vi.fn() as never })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'request-1', sessionId: 's1', input: { text: 'hi' }, config: {} })
    runtime.bindRequest('request-1', turn.turnId)
    expect(runtime.consumeForRequest('request-1', { type: 'source-completed' }).assistantMessage.status).toBe('completed')
    expect(() => runtime.consumeForRequest('request-1', { type: 'content-delta', text: 'late' })).toThrow(/unknown turn request/)
  })

  it('只允许把 transport request 绑定到同 requestId 的 prepared turn', () => {
    const runtime = new TurnRuntime({ storage: storage(), deps: { now: () => 1, id: () => 'id' }, source: vi.fn() as never })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'prepared-request', sessionId: 's1', input: { text: 'hi' }, config: {} })
    expect(() => runtime.bindRequest('other-request', turn.turnId)).toThrow(/request/i)
    runtime.bindRequest('prepared-request', turn.turnId)
    expect(runtime.consumeForRequest('prepared-request', { type: 'source-completed' }).assistantMessage.status).toBe('completed')
  })

  it('允许每次请求注入已装配的 model source，但仍复用同一 Coordinator', async () => {
    const runtime = new TurnRuntime({ storage: storage(), deps: { now: () => 1, id: () => 'id' }, source: vi.fn() as never })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'request-source', sessionId: 's1', input: { text: 'hi' }, config: {} })
    const source = vi.fn().mockResolvedValue({ outcome: 'completed' as const })
    await runtime.executeWithSource(turn.turnId, turn.startToken, source)
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('source 抛错时也通过 projection 发出 source-failed 终态事实', async () => {
    const onEvent = vi.fn()
    const runtime = new TurnRuntime({ storage: storage(), deps: { now: () => 1, id: () => 'id' }, source: vi.fn() as never, onEvent })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'runtime-failed', sessionId: 's1', input: { text: 'hi' }, config: {} })
    const error = new Error('source failed')
    await expect(runtime.executeWithSource(turn.turnId, turn.startToken, async () => { throw error })).rejects.toBe(error)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ turnId: turn.turnId, version: 1 }), { type: 'source-failed' })
  })

  it('支持多个 projection 订阅者并可独立退订', () => {
    const runtime = new TurnRuntime({ storage: storage(), deps: { now: () => 1, id: () => 'id' }, source: vi.fn() as never })
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = runtime.subscribe(first)
    runtime.subscribe(second)
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'projection-r', sessionId: 's1', input: { text: 'hi' }, config: {} })
    runtime.consume(turn.turnId, { type: 'content-delta', text: 'hello' })
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ turnId: turn.turnId }), expect.objectContaining({ type: 'content-delta' }))
    expect(second).toHaveBeenCalledTimes(1)
    offFirst()
    runtime.consume(turn.turnId, { type: 'source-completed' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('取消 turn 时向生产 source 传播同一个 requestId', () => {
    const onCancel = vi.fn()
    const runtime = new TurnRuntime({
      storage: storage(),
      deps: { now: () => 1, id: () => 'id' },
      source: vi.fn() as never,
      onCancel
    })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'cancel-request', sessionId: 's1', input: { text: 'hi' }, config: {} })
    expect(runtime.cancel(turn.turnId)).toBe(true)
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'cancel-request' }))
  })

  it.each([
    ['cancelled', 'cancel', 'source-cancelled'],
    ['timed-out', 'timeout', 'source-timeout']
  ] as const)('%s 控制动作会通过 projection 产生唯一 terminal fact', (outcome, method, eventType) => {
    const events: string[] = []
    const runtime = new TurnRuntime({
      storage: storage(),
      deps: { now: () => 1, id: () => `control-${outcome}` },
      onEvent: (_turn, event) => events.push(event.type)
    })
    const turn = runtime.prepare({ mode: 'create-user', requestId: `control-${outcome}`, sessionId: 's1', input: { text: 'control' }, config: {} })

    expect(runtime[method](turn.turnId)).toBe(true)
    expect(events).toEqual([eventType])
    expect(runtime.listActive('s1')).toEqual([])
    expect(runtime[method](turn.turnId)).toBe(false)
  })

  it('在途 source 被 cancel 后，finishing finalize 仍通过 Runtime projection 发出 cancelled terminal', async () => {
    let resolveSource!: (value: { outcome: 'completed' }) => void
    const events: string[] = []
    const runtime = new TurnRuntime({
      storage: storage(),
      deps: { now: () => 1, id: () => 'in-flight-cancel' },
      onEvent: (_turn, event) => events.push(event.type)
    })
    const turn = runtime.prepare({ mode: 'create-user', requestId: 'in-flight-cancel', sessionId: 's1', input: { text: 'cancel me' }, config: {} })
    const execution = runtime.executeWithSource(turn.turnId, turn.startToken, () => new Promise((resolve) => { resolveSource = resolve }))
    expect(runtime.cancel(turn.turnId)).toBe(true)
    resolveSource({ outcome: 'completed' })
    await execution

    expect(events).toEqual(['source-cancelled'])
    expect(runtime.listActive('s1')).toEqual([])
  })
})
