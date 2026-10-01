import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patch, sync, dispatch } = vi.hoisted(() => ({ patch: vi.fn(), sync: vi.fn(), dispatch: vi.fn() }))
vi.mock('./chatRunnerService', () => ({ routePatchMessage: patch }))
vi.mock('./pendingConfirmStore', () => ({ pendingConfirmStore: { syncFromProjection: sync } }))
vi.mock('../store', () => ({ store: { getState: vi.fn(() => ({ chat: { currentSessionId: 's1' } })), dispatch } }))

import { initTurnProjectionBridge } from './turnProjectionService'
import { setChatStatus, setTurnFailure } from '../store/chatSlice'

describe('turn projection bridge', () => {
  beforeEach(() => {
    patch.mockReset()
    sync.mockReset()
    dispatch.mockReset()
  })

  it('同一帧只应用同一 turn 的最新 projection', () => {
    let listener: ((data: any) => void) | undefined
    let frame: (() => void) | undefined
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((cb) => { frame = cb; return 1 }),
      cancelAnimationFrame: vi.fn(),
      api: { usageSet: vi.fn().mockResolvedValue(undefined), chatListActiveTurns: vi.fn().mockResolvedValue([]), chatOnTurnProjection: vi.fn((cb) => { listener = cb; return () => undefined }) }
    })
    const off = initTurnProjectionBridge()
    const message = { id: 'a1', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming', schemaVersion: 1 }
    listener?.({ turn: { turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: message, version: 1 }, event: { type: 'content-delta' } })
    listener?.({ turn: { turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: { ...message, content: 'latest' }, version: 2 }, event: { type: 'content-delta' } })
    expect(patch).not.toHaveBeenCalled()
    frame?.()
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('s1', 'a1', expect.objectContaining({ content: 'latest' }))
    off()
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
    expect(sync).not.toHaveBeenCalled()
    off()
  })

  it.each(['commit-uncertain', 'interrupted'] as const)('%s terminal settles the existing chat state as an error with its cause', async (outcome) => {
    let listener: ((data: any) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        chatOnTurnDisplay: vi.fn((cb) => { listener = cb; return () => undefined }),
        chatGetTurnTerminal: vi.fn().mockResolvedValue({ version: 4, committedVersion: 4, outcome, error: { message: 'recovered turn was interrupted' } }),
        chatGetMessagePage: vi.fn().mockResolvedValue({ entries: [{ message: { id: 'uncertain-assistant', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'failed', schemaVersion: 1 } }] })
      }
    })
    const off = initTurnProjectionBridge()
    listener?.({ display: {
      turnId: 'uncertain-turn', requestId: 'uncertain-request', sessionId: 's1', version: 4,
      lifecycle: 'failed', outcome,
      message: { id: 'uncertain-assistant', content: '', contentSegments: [], toolCalls: [], activity: [] }
    } })

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat/setChatStatus', payload: expect.objectContaining({ status: 'error', turnId: 'uncertain-turn' }) }))
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat/setTurnFailure', payload: expect.objectContaining({ messageId: 'uncertain-assistant', reason: 'recovered turn was interrupted' }) }))
    })
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
    ['source-timeout', 'error'],
    ['source-uncertain', 'error']
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

  describe('失败原因投影', () => {
    function stubApi(over: Record<string, unknown> = {}) {
      let listener: ((data: any) => void) | undefined
      const chatGetTurnTerminal = vi.fn()
      vi.stubGlobal('window', { api: {
        usageSet: vi.fn().mockResolvedValue(undefined),
        chatListActiveTurns: vi.fn().mockResolvedValue([]),
        chatGetTurnTerminal,
        chatOnTurnProjection: vi.fn((cb) => { listener = cb; return () => undefined }),
        ...over
      } })
      return { emit: (data: any) => listener?.(data), chatGetTurnTerminal }
    }

    const failedMessage = {
      id: 'a-fail',
      sessionId: 's1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'failed',
      schemaVersion: 1
    }

    it('终态失败时按 turnId 取回真实错误详情并写入失败原因', async () => {
      const { emit, chatGetTurnTerminal } = stubApi()
      chatGetTurnTerminal.mockResolvedValue({
        turnId: 'fail-turn',
        sessionId: 's1',
        assistantMessageId: 'a-fail',
        outcome: 'failed',
        error: { code: 'source-failed', message: '会话模型「claude-sonnet-4-20250514」当前不可用' }
      })
      const off = initTurnProjectionBridge()
      emit({ turn: { turnId: 'fail-turn', requestId: 'r1', sessionId: 's1', assistantMessage: failedMessage, version: 1 }, event: { type: 'source-failed' } })
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(setTurnFailure({
        messageId: 'a-fail',
        reason: '会话模型「claude-sonnet-4-20250514」当前不可用'
      })))
      expect(chatGetTurnTerminal).toHaveBeenCalledWith('fail-turn')
      off()
    })

    it('事实自带原因时直接采用，不再额外回查终态', () => {
      const { emit, chatGetTurnTerminal } = stubApi()
      const off = initTurnProjectionBridge()
      emit({
        turn: { turnId: 'fact-turn', requestId: 'r1', sessionId: 's1', assistantMessage: failedMessage, version: 1 },
        event: { type: 'source-failed', message: '会话模型「x」当前不可用' }
      })
      expect(dispatch).toHaveBeenCalledWith(setTurnFailure({
        messageId: 'a-fail',
        reason: '会话模型「x」当前不可用'
      }))
      expect(chatGetTurnTerminal).not.toHaveBeenCalled()
      off()
    })

    it('终态没有错误详情时不写入失败原因，保留通用提示', async () => {
      const { emit, chatGetTurnTerminal } = stubApi()
      chatGetTurnTerminal.mockResolvedValue({ turnId: 'timeout-turn', sessionId: 's1', assistantMessageId: 'a-fail', outcome: 'timed-out' })
      const off = initTurnProjectionBridge()
      emit({ turn: { turnId: 'timeout-turn', requestId: 'r1', sessionId: 's1', assistantMessage: failedMessage, version: 1 }, event: { type: 'source-timeout' } })
      await vi.waitFor(() => expect(chatGetTurnTerminal).toHaveBeenCalledWith('timeout-turn'))
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat/setTurnFailure' }))
      off()
    })

    it('成功终态不查询失败详情', () => {
      const { emit, chatGetTurnTerminal } = stubApi()
      const off = initTurnProjectionBridge()
      emit({ turn: { turnId: 'ok-turn', requestId: 'r1', sessionId: 's1', assistantMessage: { ...failedMessage, status: 'completed' }, version: 1 }, event: { type: 'source-completed' } })
      expect(chatGetTurnTerminal).not.toHaveBeenCalled()
      off()
    })
  })

  describe('display 通道失败原因投递', () => {
    function stubDisplayApi(over: Record<string, unknown> = {}) {
      let listener: ((data: any) => void) | undefined
      const chatGetTurnTerminal = vi.fn()
      const chatGetMessagePage = vi.fn()
      const chatRetryTurnCheckpoint = vi.fn()
      vi.stubGlobal('window', {
        // 终态接管的重试路径用 window.setTimeout 排程；引用全局以兼容 fake timers。
        setTimeout: (cb: (...args: unknown[]) => void, ms: number) => setTimeout(cb, ms),
        api: {
        usageSet: vi.fn().mockResolvedValue(undefined),
        chatListActiveTurns: vi.fn().mockResolvedValue([]),
        chatOnTurnDisplay: vi.fn((cb: any) => { listener = cb; return () => undefined }),
        chatGetTurnTerminal,
        chatGetMessagePage,
        chatRetryTurnCheckpoint,
        ...over
      } })
      return { emit: (display: any) => listener?.({ display }), chatGetTurnTerminal, chatGetMessagePage, chatRetryTurnCheckpoint }
    }

    // display 消息是 bounded 格式：turnDisplayToMessage 会无条件 map toolCalls
    const failedMessage = { id: 'a-fail', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'failed', schemaVersion: 1, toolCalls: [] }
    const committed = { commitStatus: 'committed', committedVersion: 1, version: 1, requestId: 'r1', sessionId: 's1', assistantMessageId: 'a-fail' }

    it('display 终态失败时把 terminal 错误详情写入失败原因（402 余额不足场景）', async () => {
      const { emit, chatGetTurnTerminal, chatGetMessagePage } = stubDisplayApi()
      const reason = '402 {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}'
      chatGetTurnTerminal.mockResolvedValue({ turnId: 'd-fail-turn', outcome: 'failed', error: { code: 'source-failed', message: reason }, ...committed })
      chatGetMessagePage.mockResolvedValue({ entries: [{ message: failedMessage, sequence: 1 }] })
      const off = initTurnProjectionBridge()
      emit({ turnId: 'd-fail-turn', requestId: 'r1', sessionId: 's1', version: 1, lifecycle: 'failed', outcome: 'failed', message: failedMessage })
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(setTurnFailure({ messageId: 'a-fail', reason })))
      off()
    })

    it('display 终态没有错误详情时不写入失败原因，保留通用提示', async () => {
      const { emit, chatGetTurnTerminal, chatGetMessagePage } = stubDisplayApi()
      chatGetTurnTerminal.mockResolvedValue({ turnId: 'd-timeout-turn', outcome: 'timed-out', ...committed })
      chatGetMessagePage.mockResolvedValue({ entries: [{ message: failedMessage, sequence: 1 }] })
      const off = initTurnProjectionBridge()
      emit({ turnId: 'd-timeout-turn', requestId: 'r1', sessionId: 's1', version: 1, lifecycle: 'failed', outcome: 'timed-out', message: failedMessage })
      await vi.waitFor(() => expect(chatGetMessagePage).toHaveBeenCalled())
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat/setTurnFailure' }))
      off()
    })

    it('display 成功终态不写入失败原因', async () => {
      const { emit, chatGetTurnTerminal, chatGetMessagePage } = stubDisplayApi()
      const completedMessage = { ...failedMessage, status: 'completed' }
      chatGetTurnTerminal.mockResolvedValue({ turnId: 'd-ok-turn', outcome: 'completed', ...committed })
      chatGetMessagePage.mockResolvedValue({ entries: [{ message: completedMessage, sequence: 1 }] })
      const off = initTurnProjectionBridge()
      emit({ turnId: 'd-ok-turn', requestId: 'r1', sessionId: 's1', version: 1, lifecycle: 'completed', outcome: 'completed', message: completedMessage })
      await vi.waitFor(() => expect(chatGetMessagePage).toHaveBeenCalled())
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat/setTurnFailure' }))
      off()
    })

    // 评审 2.4：terminal committed 但 60 条消息窗口内找不到该 assistant 消息——移除 display 的
    // 同时必须落终态，否则会话永久卡在 running（中止按钮失效），直到同会话下一 turn 才自愈。
    it('display 终态 committed 但消息页找不到目标消息时仍落终态，不卡 running', async () => {
      const { emit, chatGetTurnTerminal, chatGetMessagePage } = stubDisplayApi()
      chatGetTurnTerminal.mockResolvedValue({ turnId: 'd-miss-turn', outcome: 'completed', ...committed })
      chatGetMessagePage.mockResolvedValue({ entries: [{ message: { ...failedMessage, id: 'a-other', status: 'completed' }, sequence: 1 }] })
      const off = initTurnProjectionBridge()
      emit({ turnId: 'd-miss-turn', requestId: 'r1', sessionId: 's1', version: 1, lifecycle: 'completed', outcome: 'completed', message: failedMessage })
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(setChatStatus({ status: 'completed', requestId: null, sessionId: 's1', turnId: 'd-miss-turn' })))
      off()
    })

    // 评审 2.4：主进程 checkpoint 既不 commit 也不置 failed 时，重试耗尽按 TURN_CHECKPOINT_FAILED
    // 落终态——不允许无限退避重试。
    it('checkpoint 持续不就绪时重试耗尽按 TURN_CHECKPOINT_FAILED 落终态', async () => {
      vi.useFakeTimers()
      try {
        const { emit, chatGetTurnTerminal, chatRetryTurnCheckpoint } = stubDisplayApi()
        // terminal 持续「version 落后」（既不 commit 也不 failed）——重试永不收敛的前提。
        chatGetTurnTerminal.mockResolvedValue({ turnId: 'd-stuck-turn', outcome: 'completed', version: 0 })
        const off = initTurnProjectionBridge()
        emit({ turnId: 'd-stuck-turn', requestId: 'r1', sessionId: 's1', version: 1, lifecycle: 'completed', outcome: 'completed', message: failedMessage })
        // 退避序列 100ms*2^n（封顶 30s），10 次累计约 87s；一次快进覆盖全部重试后应落失败终态。
        await vi.advanceTimersByTimeAsync(120_000)
        expect(chatRetryTurnCheckpoint).toHaveBeenCalledTimes(10)
        expect(dispatch).toHaveBeenCalledWith(setChatStatus({ status: 'error', error: 'TURN_CHECKPOINT_FAILED', requestId: null, sessionId: 's1', turnId: 'd-stuck-turn' }))
        off()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
