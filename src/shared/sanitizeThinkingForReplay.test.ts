import { describe, expect, it } from 'vitest'
import { sanitizeThinkingForReplay } from './sanitizeThinkingForReplay'

describe('sanitizeThinkingForReplay', () => {
  it('removes unsigned thinking blocks and preserves signed blocks and other content', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'gateway' }, { type: 'thinking', thinking: 'signed', signature: 'sig' }, { type: 'tool_use', id: 't' }] }]
    expect(sanitizeThinkingForReplay(messages)[0]?.content).toEqual([{ type: 'thinking', thinking: 'signed', signature: 'sig' }, { type: 'tool_use', id: 't' }])
  })
})
