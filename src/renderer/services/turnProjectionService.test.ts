import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patch, sync, dispatch } = vi.hoisted(() => ({ patch: vi.fn(), sync: vi.fn(), dispatch: vi.fn() }))
vi.mock('./chatRunnerService', () => ({ routePatchMessage: patch }))
vi.mock('./pendingConfirmStore', () => ({ pendingConfirmStore: { syncFromProjection: sync } }))
vi.mock('../store', () => ({ store: { getState: vi.fn(() => ({ chat: { currentSessionId: 's1' } })), dispatch } }))

import { initTurnProjectionBridge } from './turnProjectionService'

describe('turn projection bridge', () => {
  beforeEach(() => {
    patch.mockReset()
    sync.mockReset()
    dispatch.mockReset()
  })

  it('只投影单调版本的完整 assistant snapshot', () => {
    let listener: ((data: any) => void) | undefined
    vi.stubGlobal('window', { api: { usageSet: vi.fn().mockResolvedValue(undefined), chatListActiveTurns: vi.fn().mockResolvedValue([]), chatOnTurnProjection: vi.fn((cb) => { listener = cb; return () => undefined }) } })
    const off = initTurnProjectionBridge()
    const message = { id: 'a1', sessionId: 's1', role: 'assistant', content: 'hello', timestamp: 1, status: 'streaming', schemaVersion: 1 }
    listener?.({ turn: { turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: message, version: 2 }, event: { type: 'content-delta' } })
    listener?.({ turn: { turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: { ...message, content: 'old' }, version: 1 }, event: { type: 'content-delta' } })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('s1', 'a1', message)
    expect(sync).toHaveBeenCalledWith({ sessionId: 's1', requestId: 'r1', message })
    off()
  })

  it('为成功投影输出可关联到 turn/version 的处理耗时指标', () => {
    let listener: ((data: any) => void) | undefined
    const metrics: Array<{ kind: string; turnId: string; version: number }> = []
    vi.stubGlobal('window', { api: { usageSet: vi.fn().mockResolvedValue(undefined), chatListActiveTurns: vi.fn().mockResolvedValue([]), chatOnTurnProjection: vi.fn((cb) => { listener = cb; return () => undefined }) } })
    const off = initTurnProjectionBridge((metric) => metrics.push(metric))
    listener?.({ turn: { turnId: 'metric-turn', requestId: 'r1', sessionId: 's1', assistantMessage: { id: 'a1', sessionId: 's1', role: 'assistant', content: 'x', timestamp: 1, status: 'streaming', schemaVersion: 1 }, version: 7 }, event: { type: 'content-delta' } })
    expect(metrics).toEqual([{ kind: 'projection', turnId: 'metric-turn', version: 7, eventType: 'content-delta', durationMs: expect.any(Number) }])
    off()
  })

  it('将 usage fact 投影到会话用量，而不是重新监听 legacy usage IPC', () => {
    let listener: ((data: any) => void) | undefined
    vi.stubGlobal('window', { api: { usageSet: vi.fn().mockResolvedValue(undefined), chatListActiveTurns: vi.fn().mockResolvedValue([]), chatOnTurnProjection: vi.fn((cb) => { listener = cb; return () => undefined }) } })
    const off = initTurnProjectionBridge()
    const message = { id: 'a1', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming', schemaVersion: 1 }
    listener?.({ turn: { turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: message, version: 3 }, event: { type: 'usage-updated', usage: { input_tokens: 10 } } })
    expect(dispatch).toHaveBeenCalled()
    off()
  })

  it.each([
    ['source-completed', 'completed'],
    ['source-cancelled', 'completed'],
    ['source-failed', 'error'],
    ['source-timeout', 'error']
  ] as const)('%s projection 清理 renderer running session', (eventType, status) => {
    let listener: ((data: any) => void) | undefined
    vi.stubGlobal('window', { api: {
      usageSet: vi.fn().mockResolvedValue(undefined),
      chatListActiveTurns: vi.fn().mockResolvedValue([]),
      chatOnTurnProjection: vi.fn((cb) => { listener = cb; return () => undefined })
    } })
    const off = initTurnProjectionBridge()
    const message = { id: 'a-terminal', sessionId: 's1', role: 'assistant', content: 'done', timestamp: 1, status: status === 'completed' ? 'completed' : 'failed', schemaVersion: 1 }
    listener?.({ turn: { turnId: 'terminal-turn', requestId: 'terminal-request', sessionId: 's1', assistantMessage: message, version: 1 }, event: { type: eventType } })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat/setChatStatus',
      payload: expect.objectContaining({ status, requestId: null, sessionId: 's1' })
    }))
    off()
  })

  it('窗口销毁后，迟到的 active-turn snapshot 不得再投影', async () => {
    let resolveActiveTurns: ((turns: any[]) => void) | undefined
    vi.stubGlobal('window', { api: {
      usageSet: vi.fn().mockResolvedValue(undefined),
      chatListActiveTurns: vi.fn(() => new Promise((resolve) => { resolveActiveTurns = resolve })),
      chatOnTurnProjection: vi.fn(() => () => undefined)
    } })
    const off = initTurnProjectionBridge()
    off()
    resolveActiveTurns?.([{
      turnId: 'late-turn', requestId: 'late-request', sessionId: 's1', version: 1,
      assistantMessage: { id: 'late-assistant', sessionId: 's1', role: 'assistant', content: 'late', timestamp: 1, status: 'streaming', schemaVersion: 1 }
    }])
    await Promise.resolve()
    expect(patch).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('重新连接时以 authoritative active-turn snapshot 重建，不重复应用旧 listener 事件', async () => {
    const listeners: Array<(data: any) => void> = []
    const snapshot = {
      turnId: 'reconnect-turn', requestId: 'reconnect-request', sessionId: 's1', version: 4,
      assistantMessage: { id: 'reconnect-assistant', sessionId: 's1', role: 'assistant', content: 'authoritative', timestamp: 1, status: 'streaming', schemaVersion: 1 }
    }
    vi.stubGlobal('window', { api: {
      usageSet: vi.fn().mockResolvedValue(undefined),
      chatListActiveTurns: vi.fn().mockResolvedValue([snapshot]),
      chatOnTurnProjection: vi.fn((cb) => {
        listeners.push(cb)
        return () => {
          const index = listeners.indexOf(cb)
          if (index >= 0) listeners.splice(index, 1)
        }
      })
    } })

    const firstOff = initTurnProjectionBridge()
    await Promise.resolve()
    firstOff()
    const secondOff = initTurnProjectionBridge()
    await Promise.resolve()

    listeners[0]?.({ turn: { ...snapshot, version: 5, assistantMessage: { ...snapshot.assistantMessage, content: 'new event' } }, event: { type: 'content-delta' } })
    expect(patch).toHaveBeenCalledTimes(3)
    expect(patch).toHaveBeenNthCalledWith(1, 's1', 'reconnect-assistant', snapshot.assistantMessage)
    expect(patch).toHaveBeenNthCalledWith(2, 's1', 'reconnect-assistant', snapshot.assistantMessage)
    expect(patch).toHaveBeenNthCalledWith(3, 's1', 'reconnect-assistant', expect.objectContaining({ content: 'new event' }))
    secondOff()
  })

  it('snapshot 请求期间到达的 projection 事件不能丢失', async () => {
    let emit: ((data: any) => void) | undefined
    let resolveSnapshot: ((turns: any[]) => void) | undefined
    const event = {
      turn: {
        turnId: 'race-turn', requestId: 'race-request', sessionId: 's1', version: 2,
        assistantMessage: { id: 'race-assistant', sessionId: 's1', role: 'assistant', content: 'event', timestamp: 1, status: 'streaming', schemaVersion: 1 }
      },
      event: { type: 'content-delta' }
    }
    vi.stubGlobal('window', { api: {
      usageSet: vi.fn().mockResolvedValue(undefined),
      chatListActiveTurns: vi.fn(() => {
        emit?.(event)
        return new Promise((resolve) => { resolveSnapshot = resolve })
      }),
      chatOnTurnProjection: vi.fn((cb) => { emit = cb; return () => undefined })
    } })

    const off = initTurnProjectionBridge()
    expect(patch).toHaveBeenCalledWith('s1', 'race-assistant', event.turn.assistantMessage)
    resolveSnapshot?.([{ ...event.turn, version: 1, assistantMessage: { ...event.turn.assistantMessage, content: 'older snapshot' } }])
    await Promise.resolve()
    expect(patch).toHaveBeenCalledTimes(1)
    off()
  })
})
