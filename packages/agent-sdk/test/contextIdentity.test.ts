import { describe, expect, it } from 'vitest'
import { surfaceItemIdentities as hostIdentities, surfaceItemIdentity as hostIdentity } from '../../../src/shared/surfaceReplay'
import { surfaceItemIdentities, surfaceItemIdentity } from '../src/contextIdentity'

describe('SDK context identity', () => {
  it('matches the host replay identity for canonical and tool protocol messages', () => {
    const values = [
      { role: 'user', id: 'u1', content: [{ type: 'text', text: ' question ' }, { type: 'tool_result', content: 'ignored' }] },
      { role: 'assistant', id: 'a1', content: [{ type: 'text', text: ' answer ' }] },
      { role: 'assistant', id: 'a2', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] },
      { id: 'explicit-id' },
      { role: 'user', content: [{ type: 'text', text: 'same' }] },
      { role: 'user', content: [{ type: 'text', text: 'same' }] }
    ]
    expect(values.map((value, index) => surfaceItemIdentity(value, index)))
      .toEqual(values.map((value, index) => hostIdentity(value, index)))
    expect(surfaceItemIdentities(values)).toEqual(hostIdentities(values))
  })
})
