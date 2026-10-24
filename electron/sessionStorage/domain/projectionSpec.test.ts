import { describe, expect, it } from 'vitest'
import { encodeChatBodyV1 } from './projectionSpec'

describe('ProjectionSpec.chatBodyV1', () => {
  it('excludes non-body Message fields from the stable digest', () => {
    const base = [{ id: 'm1', sessionId: 's1', role: 'assistant' as const, content: 'body', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }]
    expect(encodeChatBodyV1([{ ...base[0]!, status: 'failed' }])).toBe(encodeChatBodyV1(base))
    expect(encodeChatBodyV1([{ ...base[0]!, content: 'edited' }])).not.toBe(encodeChatBodyV1(base))
  })
})
