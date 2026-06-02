import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useChatMessageEnter } from './useChatMessageEnter'

describe('useChatMessageEnter', () => {
  it('does not animate on session switch with full history', () => {
    const { result, rerender } = renderHook(
      ({ sessionId, ids }: { sessionId: string; ids: string[] }) => useChatMessageEnter(sessionId, ids),
      { initialProps: { sessionId: 's1', ids: ['a', 'b', 'c'] } }
    )
    expect(result.current).toBeNull()
    rerender({ sessionId: 's2', ids: ['x', 'y'] })
    expect(result.current).toBeNull()
  })

  it('returns last id when a message is appended', () => {
    const { result, rerender } = renderHook(
      ({ sessionId, ids }: { sessionId: string; ids: string[] }) => useChatMessageEnter(sessionId, ids),
      { initialProps: { sessionId: 's1', ids: ['a'] } }
    )
    expect(result.current).toBeNull()
    rerender({ sessionId: 's1', ids: ['a', 'b'] })
    expect(result.current).toBe('b')
  })
})
