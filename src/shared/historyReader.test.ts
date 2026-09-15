import { describe, expect, it } from 'vitest'
import { readHistory } from './historyReader'

const facts = [{ id: 'a', sessionId: 's1', windowId: 'w1', text: 'old message', tokens: 10 }, { id: 'b', sessionId: 's1', windowId: 'w1', text: 'second', tokens: 8 }, { id: 'x', sessionId: 's2', windowId: 'w1', text: 'private', tokens: 5 }]

describe('history reader', () => {
  it('reads authorized window entries with pagination and a token cap', () => {
    expect(readHistory(facts, { sessionId: 's1', windowId: 'w1', limit: 1 })).toMatchObject({ entries: [facts[0]], nextCursor: '1' })
    expect(readHistory(facts, { sessionId: 's1', windowId: 'w1', cursor: '1', limit: 5 })).toMatchObject({ entries: [facts[1]], nextCursor: null })
    expect(readHistory(facts, { sessionId: 's1', windowId: 'w1', maxTokens: 5 }).entries).toEqual([])
  })
  it('rejects cross-session entry lookup', () => {
    expect(() => readHistory(facts, { sessionId: 's1', windowId: 'w1', entryId: 'x' })).toThrow(/not found|not authorized/i)
  })
  it('applies the default single-entry token limit', () => {
    expect(() => readHistory([{ id: 'huge', sessionId: 's1', windowId: 'w1', text: 'huge', tokens: 4001 }], { sessionId: 's1', entryId: 'huge' })).toThrow(/budget/i)
  })
  it('advances past an oversized entry instead of returning a stuck cursor', () => {
    const result = readHistory([
      { id: 'huge', sessionId: 's1', windowId: 'w1', text: 'huge', tokens: 5_000 },
      { id: 'small', sessionId: 's1', windowId: 'w1', text: 'small', tokens: 1 }
    ], { sessionId: 's1', windowId: 'w1', maxTokens: 4_000 })
    expect(result.entries.map((entry) => entry.id)).toEqual(['small'])
    expect(result.nextCursor).toBeNull()
  })
})
