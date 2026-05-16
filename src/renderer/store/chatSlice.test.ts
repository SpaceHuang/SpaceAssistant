import { describe, expect, it } from 'vitest'
import chatReducer, { addMessage, setChatStatus, setSession, removeRunningSession } from './chatSlice'
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
})
