import { describe, expect, it } from 'vitest'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from './claudeToolHistory'
import type { Message } from './domainTypes'

function userMsg(id: string, content: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content,
    timestamp: 1,
    status: 'completed'
  }
}

function assistantMsg(id: string, content: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    content,
    timestamp: 2,
    status: 'completed'
  }
}

describe('trimClaudeToolChatMessages', () => {
  it('returns all messages when under limit', () => {
    const messages = [userMsg('u1', 'hello'), assistantMsg('a1', 'hi')]
    const api = buildClaudeToolChatMessages(messages)
    expect(trimClaudeToolChatMessages(api, 10)).toEqual(api)
  })

  it('keeps the most recent messages when over limit', () => {
    const api = Array.from({ length: 5 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`
    }))
    const trimmed = trimClaudeToolChatMessages(api, 3)
    expect(trimmed).toHaveLength(3)
    expect(trimmed.map((m) => m.content)).toEqual(['m2', 'm3', 'm4'])
  })

  it('drops leading assistant and orphaned tool_result after slice', () => {
    const api = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant' as const, content: 'done' },
      { role: 'user' as const, content: 'next' }
    ]
    const trimmed = trimClaudeToolChatMessages(api, 2)
    expect(trimmed).toHaveLength(1)
    expect(trimmed[0].role).toBe('user')
    expect(trimmed[0].content).toBe('next')
  })

  it('starts with a plain user message after trimming tool_result orphans', () => {
    const api = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'user' as const, content: 'continue' },
      { role: 'assistant' as const, content: 'sure' }
    ]
    const trimmed = trimClaudeToolChatMessages(api, 2)
    expect(trimmed).toHaveLength(2)
    expect(trimmed[0].content).toBe('continue')
  })

  it('uses placeholder for completed assistant with empty content and no tools', () => {
    const messages = [
      userMsg('u1', 'hello'),
      {
        ...assistantMsg('a1', ''),
        status: 'completed' as const,
        toolCalls: undefined
      }
    ]
    const api = buildClaudeToolChatMessages(messages)
    expect(api).toHaveLength(2)
    expect(api[1].content).toBe(' ')
  })
})
