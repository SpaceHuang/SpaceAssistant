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
})
