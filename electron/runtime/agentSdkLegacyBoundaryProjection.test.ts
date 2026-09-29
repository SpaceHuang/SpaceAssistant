import { describe, expect, it } from 'vitest'
import { toLegacyBoundaryMessages } from './canonicalHistory'

describe('SDK canonical turn-boundary legacy projection', () => {
  it('preserves a pending tool proposal and annotates the exact required user message identity', () => {
    const projected = toLegacyBoundaryMessages([
      { role: 'user', content: 'earlier request' },
      { role: 'user', content: 'current request' },
      { role: 'assistant', toolCalls: [{ id: 'tool-1', name: 'write_file', input: { path: 'a.txt' } }] }
    ], { id: 'user-current', message: { role: 'user', content: 'current request' } })
    expect(projected).toEqual([
      { role: 'user', content: 'earlier request' },
      { role: 'user', id: 'user-current', content: 'current request' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'write_file', input: { path: 'a.txt' } }] }
    ])
  })

  it('binds the required user identity to the last exact match when identical user text repeats', () => {
    const projected = toLegacyBoundaryMessages([
      { role: 'user', content: 'repeat' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'repeat' },
      { role: 'assistant', content: 'second answer' }
    ], { id: 'user-latest', message: { role: 'user', content: 'repeat' } })
    expect(projected.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'repeat' },
      { role: 'user', id: 'user-latest', content: 'repeat' }
    ])
  })

  it('rejects a required message binding absent from the canonical transcript', () => {
    expect(() => toLegacyBoundaryMessages([
      { role: 'user', content: 'different request' },
      { role: 'assistant', content: 'answer' }
    ], { id: 'user-current', message: { role: 'user', content: 'current request' } }))
      .toThrow('boundary transcript omitted required message: user-current')
  })
})
