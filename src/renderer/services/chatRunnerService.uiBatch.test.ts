import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  clearLiveSession,
  flushUiPatch,
  getLiveMessages,
  initLiveSessionFromStore,
  routeStreamPatchMessage
} from './chatRunnerService'

const { dispatchMock, getStateMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  getStateMock: vi.fn()
}))

vi.mock('../store', () => ({
  store: {
    getState: getStateMock,
    dispatch: dispatchMock
  }
}))

vi.mock('../store/chatSlice', () => ({
  patchMessage: (payload: unknown) => ({ type: 'chat/patchMessage', payload }),
  removeRunningSession: vi.fn()
}))

vi.mock('./pendingConfirmStore', () => ({
  pendingConfirmStore: { rejectAllForSession: vi.fn() }
}))

vi.mock('./runRequestIndex', () => ({
  registerRunRequest: vi.fn(),
  unregisterRunRequest: vi.fn(),
  unregisterRunRequestsForSession: vi.fn()
}))

const baseAssistant = (): Message => ({
  id: 'm1',
  sessionId: 's1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  status: 'streaming',
  schemaVersion: 1
})

describe('routeStreamPatchMessage UI batching', () => {
  let rafCb: FrameRequestCallback | null = null
  const chatPatchMessage = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    dispatchMock.mockClear()
    chatPatchMessage.mockClear()
    rafCb = null
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafCb = cb
        return 1
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    window.api = { chatPatchMessage } as unknown as typeof window.api

    getStateMock.mockReturnValue({
      chat: {
        currentSessionId: 's1',
        messages: [baseAssistant()],
        runningSessions: {}
      },
      config: { config: null }
    })
    initLiveSessionFromStore('s1')
  })

  afterEach(() => {
    clearLiveSession('s1')
    vi.unstubAllGlobals()
  })

  it('updates live immediately but batches Redux dispatch to one rAF flush', () => {
    routeStreamPatchMessage('s1', 'm1', { content: 'a' })
    routeStreamPatchMessage('s1', 'm1', { content: 'ab' })

    expect(getLiveMessages('s1')?.find((m) => m.id === 'm1')?.content).toBe('ab')
    expect(dispatchMock).not.toHaveBeenCalled()

    rafCb?.(0)
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'chat/patchMessage',
      payload: { id: 'm1', patch: { content: 'ab' } }
    })
  })

  it('flushUiPatch dispatches merged pending patch immediately', () => {
    routeStreamPatchMessage('s1', 'm1', { content: 'hello' })
    expect(dispatchMock).not.toHaveBeenCalled()

    flushUiPatch('s1', 'm1')
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock.mock.calls[0]?.[0]).toMatchObject({
      payload: { id: 'm1', patch: { content: 'hello' } }
    })
  })

  it('does not dispatch Redux when viewing a different session', () => {
    getStateMock.mockReturnValue({
      chat: {
        currentSessionId: 'other',
        messages: [baseAssistant()],
        runningSessions: {}
      },
      config: { config: null }
    })

    routeStreamPatchMessage('s1', 'm1', { content: 'x' })
    expect(getLiveMessages('s1')?.find((m) => m.id === 'm1')?.content).toBe('x')

    rafCb?.(0)
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('still schedules throttled DB persist on each delta', () => {
    vi.useFakeTimers()
    routeStreamPatchMessage('s1', 'm1', { content: 'a' })
    routeStreamPatchMessage('s1', 'm1', { content: 'ab' })
    expect(chatPatchMessage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(chatPatchMessage).toHaveBeenCalledTimes(1)
    expect(chatPatchMessage.mock.calls[0]?.[0]).toMatchObject({
      messageId: 'm1',
      sessionId: 's1',
      patch: { content: 'ab' }
    })
    vi.useRealTimers()
  })
})
