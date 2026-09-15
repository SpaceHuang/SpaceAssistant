import { describe, expect, it } from 'vitest'
import chatReducer, { addMessage, setChatStatus, setSession, removeRunningSession, setLastUsage, restoreLastUsage, resetChatUi, setProjectMemoryEnabled, setScrollToMessageId, setTurnFailure } from './chatSlice'
import type { Message } from '../../shared/domainTypes'

describe('chatSlice', () => {
  it('adds a message', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const msg: Message = {
      id: 'm1',
      sessionId: 's1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'sent',
      schemaVersion: 1
    }
    const next = chatReducer(base, addMessage(msg))
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]?.content).toBe('hi')
  })

  it('tracks running sessions while streaming', () => {
    const streaming = chatReducer(
      undefined,
      setChatStatus({ status: 'streaming', requestId: 'req-1', sessionId: 's1' })
    )
    expect(streaming.runningSessions['s1']?.requestId).toBe('req-1')

    const completed = chatReducer(streaming, setChatStatus({ status: 'completed', requestId: null, sessionId: 's1' }))
    expect(completed.runningSessions['s1']).toBeUndefined()
  })

  it('保留 prepare 返回的 turnId，且 reducer 不访问未解构变量', () => {
    const state = chatReducer(
      undefined,
      setChatStatus({ status: 'streaming', requestId: 'req-1', sessionId: 's1', turnId: 'turn-1' })
    )
    expect(state.runningSessions['s1']?.turnId).toBe('turn-1')
  })

  it('supports multiple concurrent running sessions', () => {
    let s = chatReducer(undefined, setChatStatus({ status: 'streaming', requestId: 'r1', sessionId: 'a' }))
    s = chatReducer(s, setChatStatus({ status: 'streaming', requestId: 'r2', sessionId: 'b' }))
    expect(Object.keys(s.runningSessions)).toHaveLength(2)
    s = chatReducer(s, setChatStatus({ status: 'completed', requestId: null, sessionId: 'a' }))
    expect(s.runningSessions['a']).toBeUndefined()
    expect(s.runningSessions['b']?.requestId).toBe('r2')
  })

  it('removeRunningSession clears one entry', () => {
    let s = chatReducer(undefined, setChatStatus({ status: 'streaming', requestId: 'r1', sessionId: 'x' }))
    s = chatReducer(s, removeRunningSession('x'))
    expect(Object.keys(s.runningSessions)).toHaveLength(0)
  })

  it('setLastUsage stores usage data', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const next = chatReducer(base, setLastUsage({ sessionId: 's1', usage: { input_tokens: 5000, output_tokens: 3000 } }))
    expect(next.lastUsage).toEqual({ input_tokens: 5000, output_tokens: 3000 })
  })

  it('restoreLastUsage(null) clears usage', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const withData = chatReducer(base, setLastUsage({ sessionId: 's1', usage: { input_tokens: 5000 } }))
    const cleared = chatReducer(withData, restoreLastUsage(null))
    expect(cleared.lastUsage).toBeNull()
  })

  it('setSession does not reset lastUsage', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const withData = chatReducer(base, setLastUsage({ sessionId: 's1', usage: { input_tokens: 5000 } }))
    const switched = chatReducer(withData, setSession('s2'))
    expect(switched.lastUsage).toEqual({ input_tokens: 5000 })
  })

  it('restoreLastUsage restores usage from persistence', () => {
    const base = chatReducer(undefined, setSession('s2'))
    const restored = chatReducer(base, restoreLastUsage({ input_tokens: 8000, cache_read_input_tokens: 2000 }))
    expect(restored.lastUsage).toEqual({ input_tokens: 8000, cache_read_input_tokens: 2000 })
  })

  it('setScrollToMessageId stores pending scroll target', () => {
    const state = chatReducer(undefined, setScrollToMessageId('m42'))
    expect(state.scrollToMessageId).toBe('m42')
    const cleared = chatReducer(state, setScrollToMessageId(null))
    expect(cleared.scrollToMessageId).toBeNull()
  })

  it('setSession clears scrollToMessageId', () => {
    let state = chatReducer(undefined, setScrollToMessageId('m42'))
    state = chatReducer(state, setSession('s2'))
    expect(state.scrollToMessageId).toBeNull()
  })

  it('resetChatUi resets lastUsage', () => {
    let state = chatReducer(undefined, setSession('s1'))
    state = chatReducer(state, setLastUsage({ sessionId: 's1', usage: { input_tokens: 5000 } }))
    state = chatReducer(state, resetChatUi())
    expect(state.lastUsage).toBeNull()
  })

  describe('projectMemoryEnabled', () => {
    it('defaults to true', () => {
      const state = chatReducer(undefined, { type: '' })
      expect(state.projectMemoryEnabled).toBe(true)
    })

    it('can be toggled', () => {
      const state = chatReducer(undefined, setProjectMemoryEnabled(false))
      expect(state.projectMemoryEnabled).toBe(false)
    })

    it('resets to true on resetChatUi', () => {
      let state = chatReducer(undefined, setProjectMemoryEnabled(false))
      state = chatReducer(state, resetChatUi())
      expect(state.projectMemoryEnabled).toBe(true)
    })
  })

  describe('turnFailures', () => {
    it('记录每个会话最近一次失败的 assistant 消息与真实原因', () => {
      const state = chatReducer(
        undefined,
        setTurnFailure({ sessionId: 's1', messageId: 'a1', reason: '会话模型「x」当前不可用' })
      )
      expect(state.turnFailures['s1']).toEqual({
        messageId: 'a1',
        reason: '会话模型「x」当前不可用'
      })
    })

    it('同一会话再次失败时覆盖为新消息，避免旧原因串到新气泡', () => {
      let state = chatReducer(undefined, setTurnFailure({ sessionId: 's1', messageId: 'a1', reason: 'old' }))
      state = chatReducer(state, setTurnFailure({ sessionId: 's1', messageId: 'a2', reason: 'new' }))
      expect(state.turnFailures['s1']).toEqual({ messageId: 'a2', reason: 'new' })
    })

    it('按会话隔离，不跨会话串原因', () => {
      let state = chatReducer(undefined, setTurnFailure({ sessionId: 's1', messageId: 'a1', reason: 'r1' }))
      state = chatReducer(state, setTurnFailure({ sessionId: 's2', messageId: 'b1', reason: 'r2' }))
      expect(state.turnFailures['s1']?.reason).toBe('r1')
      expect(state.turnFailures['s2']?.reason).toBe('r2')
    })
  })
})
