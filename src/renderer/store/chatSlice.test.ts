import { describe, expect, it } from 'vitest'
import chatReducer, { addMessage, setChatStatus, setSession, removeRunningSession, setLastUsage, resetChatUi, setProjectMemoryEnabled, setScrollToMessageId } from './chatSlice'
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
    const next = chatReducer(base, setLastUsage({ input_tokens: 5000, output_tokens: 3000 }))
    expect(next.lastUsage).toEqual({ input_tokens: 5000, output_tokens: 3000 })
  })

  it('setLastUsage(null) clears usage', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const withData = chatReducer(base, setLastUsage({ input_tokens: 5000 }))
    const cleared = chatReducer(withData, setLastUsage(null))
    expect(cleared.lastUsage).toBeNull()
  })

  it('setSession resets lastUsage', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const withData = chatReducer(base, setLastUsage({ input_tokens: 5000 }))
    const switched = chatReducer(withData, setSession('s2'))
    expect(switched.lastUsage).toBeNull()
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
    state = chatReducer(state, setLastUsage({ input_tokens: 5000 }))
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
})
