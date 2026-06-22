import { describe, expect, it } from 'vitest'
import { stripThinkingBlocksFromAssistantMessages } from './stripThinkingFromApiMessages'

describe('stripThinkingBlocksFromAssistantMessages', () => {
  it('removes thinking blocks when thinking is disabled for the session', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} }
        ]
      }
    ]

    const stripped = stripThinkingBlocksFromAssistantMessages(messages)
    expect(stripped[0]?.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} }
    ])
  })

  it('leaves user messages unchanged', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    expect(stripThinkingBlocksFromAssistantMessages(messages)).toEqual(messages)
  })

  it('uses text placeholder when assistant message only contained thinking', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'internal only' }]
      }
    ]
    expect(stripThinkingBlocksFromAssistantMessages(messages)[0]?.content).toEqual([
      { type: 'text', text: ' ' }
    ])
  })
})
