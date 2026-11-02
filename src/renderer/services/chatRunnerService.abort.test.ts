import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abortSessionRun, clearLiveSession, finishSessionRun, getLiveMessages, registerSessionRun, resetLiveSessionMessages, routePatchMessage } from './chatRunnerService'
import { pendingConfirmStore } from './pendingConfirmStore'
import { clearRunRequestIndex, resolveRunRequest } from './runRequestIndex'
import { store } from '../store'
import { resetChatUi, setChatStatus, setMessages, setSession } from '../store/chatSlice'
import type { Message } from '../../shared/domainTypes'
import { toTurnDisplay } from '../../shared/turnDisplayProtocol'
import { turnDisplayStore } from './turnDisplayStore'

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
    turnDisplayStore.clear()
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

  it('accepted cancellation settles the active assistant confirmation in the current view', async () => {
    const requestId = 'cancel-current-view'
    const turnId = 'cancel-current-view-turn'
    const assistant = assistantConfirm('session-a')
    vi.mocked(window.api.chatCancelTurn).mockResolvedValue(true)
    store.dispatch(setSession('session-a'))
    store.dispatch(setMessages([assistant]))
    store.dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: 'session-a', turnId }))
    registerSessionRun('session-a', requestId, turnId)
    resetLiveSessionMessages('session-a', [assistant])
    pendingConfirmStore.syncFromProjection({ sessionId: 'session-a', requestId, turnId, turnVersion: 1, message: assistant })

    await abortSessionRun('session-a')

    expect(store.getState().chat.messages[0]).toMatchObject({
      status: 'cancelled',
      toolCalls: [{ id: 'tool-session-a', status: 'failed' }]
    })
  })

  it('清除运行状态前先把 turn display 中的工具步骤和参数接回消息行', async () => {
    const requestId = 'cancel-display-handoff'
    const turnId = 'cancel-display-handoff-turn'
    const assistant: Message = { ...assistantConfirm('session-a'), toolCalls: [] }
    let resolveCancel!: (accepted: boolean) => void
    vi.mocked(window.api.chatCancelTurn).mockImplementation(() => new Promise((resolve) => { resolveCancel = resolve }))
    store.dispatch(setSession('session-a'))
    store.dispatch(setMessages([assistant]))
    store.dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: 'session-a', turnId }))
    registerSessionRun('session-a', requestId, turnId)
    resetLiveSessionMessages('session-a', [assistant])
    turnDisplayStore.enqueue(toTurnDisplay({
      turnId, requestId, version: 4, lifecycle: 'running',
      message: { ...assistant, toolCalls: [{ id: 'shell-step', toolName: 'run_shell', input: { command: 'sleep 90' }, riskLevel: 'high', status: 'executing' }] }
    }))
    turnDisplayStore.flush()

    const abort = abortSessionRun('session-a')
    expect(store.getState().chat.messages[0]?.toolCalls).toEqual([
      expect.objectContaining({ id: 'shell-step', input: { command: 'sleep 90' }, status: 'failed', interrupted: true })
    ])
    resolveCancel(true)
    await abort
    expect(store.getState().chat.messages[0]).toMatchObject({ status: 'cancelled', toolCalls: [expect.objectContaining({ id: 'shell-step' })] })
  })

  it('取消 IPC 迟到时不让旧快照覆盖已接管的终态工具结果', async () => {
    const requestId = 'late-cancel-ack'
    const turnId = 'late-cancel-ack-turn'
    const assistant = assistantConfirm('session-a')
    assistant.toolCalls![0]!.status = 'executing'
    let resolveCancel!: (accepted: boolean) => void
    vi.mocked(window.api.chatCancelTurn).mockImplementation(() => new Promise((resolve) => { resolveCancel = resolve }))
    store.dispatch(setSession('session-a'))
    store.dispatch(setMessages([assistant]))
    store.dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: 'session-a', turnId }))
    registerSessionRun('session-a', requestId, turnId)
    resetLiveSessionMessages('session-a', [assistant])

    const abort = abortSessionRun('session-a')
    routePatchMessage('session-a', assistant.id, {
      status: 'cancelled',
      toolCalls: [{ ...assistant.toolCalls![0]!, status: 'completed', result: { success: true, data: 'late durable result' } }]
    })
    resolveCancel(true)
    await abort

    expect(store.getState().chat.messages[0]?.toolCalls?.[0]).toMatchObject({
      status: 'completed', result: { success: true, data: 'late durable result' }
    })
  })
})
