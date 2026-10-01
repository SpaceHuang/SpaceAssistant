import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abortSessionRun, clearLiveSession, finishSessionRun, getLiveMessages, registerSessionRun, resetLiveSessionMessages } from './chatRunnerService'
import { pendingConfirmStore } from './pendingConfirmStore'
import { clearRunRequestIndex, resolveRunRequest } from './runRequestIndex'
import { store } from '../store'
import { resetChatUi, setChatStatus } from '../store/chatSlice'
import type { Message } from '../../shared/domainTypes'

function assistantConfirm(sessionId: string): Message {
  return {
    id: `assistant-${sessionId}`, sessionId, role: 'assistant', content: '', timestamp: 1,
    status: 'streaming', schemaVersion: 1,
    toolCalls: [{ id: `tool-${sessionId}`, toolName: 'run_shell', input: {}, riskLevel: 'high', status: 'confirming' }]
  }
}

describe('abortSessionRun turn-scoped cleanup', () => {
  beforeEach(() => {
    clearRunRequestIndex()
    clearLiveSession('session-a')
    clearLiveSession('session-b')
    pendingConfirmStore.reset()
    store.dispatch(resetChatUi())
    window.api = { ...(window.api ?? {}), chatCancelTurn: vi.fn(), toolConfirmResponse: vi.fn() } as typeof window.api
  })

  it('aborts A immediately without clearing B when distinct turns share requestId', () => {
    const requestId = 'shared-request'
    const turnA = 'turn-a'
    const turnB = 'turn-b'
    store.dispatch(setChatStatus({ status: 'streaming', sessionId: 'session-a', requestId, turnId: turnA }))
    store.dispatch(setChatStatus({ status: 'streaming', sessionId: 'session-b', requestId, turnId: turnB }))
    registerSessionRun('session-a', requestId, turnA)
    registerSessionRun('session-b', requestId, turnB)
    resetLiveSessionMessages('session-a', [assistantConfirm('session-a')])
    resetLiveSessionMessages('session-b', [assistantConfirm('session-b')])
    pendingConfirmStore.syncFromProjection({ sessionId: 'session-a', requestId, turnId: turnA, turnVersion: 1, message: assistantConfirm('session-a') })
    pendingConfirmStore.syncFromProjection({ sessionId: 'session-b', requestId, turnId: turnB, turnVersion: 1, message: assistantConfirm('session-b') })

    abortSessionRun('session-a')

    expect(window.api.chatCancelTurn).toHaveBeenCalledOnce()
    expect(window.api.chatCancelTurn).toHaveBeenCalledWith(turnA)
    expect(store.getState().chat.runningSessions['session-a']).toBeUndefined()
    expect(store.getState().chat.runningSessions['session-b']).toMatchObject({ requestId, turnId: turnB })
    expect(getLiveMessages('session-a')).toBeUndefined()
    expect(getLiveMessages('session-b')).toEqual([assistantConfirm('session-b')])
    expect(window.api.toolConfirmResponse).toHaveBeenCalledWith({ requestId, toolUseId: 'tool-session-a', approved: false, sessionId: 'session-a' })
    expect(pendingConfirmStore.find('session-a', 'tool-session-a')).toBeUndefined()
    expect(pendingConfirmStore.find('session-b', 'tool-session-b')).toMatchObject({ sessionId: 'session-b', requestId })
    expect(resolveRunRequest('session-a', requestId)).toBeUndefined()
    expect(resolveRunRequest('session-b', requestId)).toMatchObject({ sessionId: 'session-b', requestId, turnId: turnB })

    finishSessionRun('session-a', requestId)
    expect(resolveRunRequest('session-b', requestId)).toMatchObject({ turnId: turnB })
    expect(store.getState().chat.runningSessions['session-b']).toMatchObject({ turnId: turnB })
  })
})
