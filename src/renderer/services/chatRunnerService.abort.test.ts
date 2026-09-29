import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  abortSessionRun,
  registerSessionRun,
  routeAddMessage,
  getLiveMessages,
  clearLiveSession
} from './chatRunnerService'
import { pendingConfirmStore } from './pendingConfirmStore'
import { resolveSessionIdForRequest, clearRunRequestIndex } from './runRequestIndex'
import { store } from '../store'
import { setChatStatus, removeRunningSession } from '../store/chatSlice'
import type { Message } from '../../shared/domainTypes'

// abortSessionRun 对确认 stores 的操作经 mock 边界断言（参考 SessionListPane.ownership.test.tsx 方式）
vi.mock('./pendingConfirmStore', () => ({
  pendingConfirmStore: {
    rejectAllForSession: vi.fn(),
    removeAllForRequest: vi.fn(),
    find: vi.fn(),
    respond: vi.fn(),
    removeAllForSession: vi.fn()
  }
}))

const baseMsg = (over: Partial<Message>): Message => ({
  id: 'm1',
  sessionId: 's',
  role: 'user',
  content: 'x',
  timestamp: 1,
  status: 'sent',
  schemaVersion: 1,
  ...over
})

const chatCancelTurn = vi.fn(async () => undefined)

function seedRunning(sessionId: string, requestId: string, turnId?: string) {
  store.dispatch(setChatStatus({
    status: 'streaming',
    requestId,
    sessionId,
    ...(turnId ? { turnId } : {})
  }))
}

describe('abortSessionRun 本地止血分支（chat-abort-latency 方案 Phase 2 回归钉）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRunRequestIndex()
    for (const id of ['s1', 's2', 's3']) {
      store.dispatch(removeRunningSession(id))
      clearLiveSession(id)
    }
    Object.assign(window.api, { chatCancelTurn })
  })

  it('meta 带 turnId：chatCancelTurn(turnId) + 本地立即清理（running 移除 / live 清空 / 确认拒绝）', () => {
    seedRunning('s1', 'req-1', 'turn-1')
    routeAddMessage('s1', baseMsg({ id: 'm-live-1', sessionId: 's1' }))

    abortSessionRun('s1')

    expect(chatCancelTurn).toHaveBeenCalledWith('turn-1')
    expect(store.getState().chat.runningSessions['s1']).toBeUndefined()
    expect(getLiveMessages('s1')).toBeUndefined()
    expect(pendingConfirmStore.rejectAllForSession).toHaveBeenCalledWith('s1')
  })

  it('meta 存在但 turnId 缺失：不发取消 IPC，运行索引与本地清理照常执行', () => {
    seedRunning('s2', 'req-2')
    registerSessionRun('s2', 'req-2')
    routeAddMessage('s2', baseMsg({ id: 'm-live-2', sessionId: 's2' }))

    abortSessionRun('s2')

    expect(chatCancelTurn).not.toHaveBeenCalled()
    expect(resolveSessionIdForRequest('req-2')).toBeUndefined()
    expect(store.getState().chat.runningSessions['s2']).toBeUndefined()
    expect(getLiveMessages('s2')).toBeUndefined()
    expect(pendingConfirmStore.rejectAllForSession).toHaveBeenCalledWith('s2')
  })

  it('runningSessions 无该会话：走 unregisterRunRequestsForSession 兜底，清理照常不抛错', () => {
    registerSessionRun('s3', 'req-3')
    routeAddMessage('s3', baseMsg({ id: 'm-live-3', sessionId: 's3' }))

    expect(() => abortSessionRun('s3')).not.toThrow()

    expect(chatCancelTurn).not.toHaveBeenCalled()
    expect(resolveSessionIdForRequest('req-3')).toBeUndefined()
    expect(getLiveMessages('s3')).toBeUndefined()
    expect(pendingConfirmStore.rejectAllForSession).toHaveBeenCalledWith('s3')
  })
})
