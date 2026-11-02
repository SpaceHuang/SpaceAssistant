import { describe, expect, it } from 'vitest'
import { assistantMessage, thinking, toolUse, userMessage } from './message'

describe('message factories', () => {
  it('builds typed messages with deterministic defaults and allows overrides', () => {
    expect(userMessage()).toMatchObject({ role: 'user', status: 'sent', content: '', schemaVersion: 1 })
    expect(assistantMessage({ content: 'reply', status: 'completed' })).toMatchObject({
      role: 'assistant', status: 'completed', content: 'reply', schemaVersion: 1
    })
    expect(toolUse()).toMatchObject({ id: 'tool-1', toolName: 'read_file', input: {}, status: 'completed' })
    expect(thinking()).toMatchObject({ content: 'thinking', isVisible: true, startTime: 1 })
  })
})
