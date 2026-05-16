import { describe, expect, it } from 'vitest'
import chatReducer, { addMessage, setChatStatus, setSession } from './chatSlice'
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

  it('tracks running session while streaming', () => {
    const streaming = chatReducer(
      undefined,
      setChatStatus({ status: 'streaming', requestId: 'req-1', sessionId: 's1' })
    )
    expect(streaming.runningSessionId).toBe('s1')

    const completed = chatReducer(streaming, setChatStatus({ status: 'completed', requestId: null }))
    expect(completed.runningSessionId).toBeNull()
  })
})
