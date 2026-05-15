import { describe, expect, it } from 'vitest'
import chatReducer, { addMessage, setSession } from './chatSlice'
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
})
