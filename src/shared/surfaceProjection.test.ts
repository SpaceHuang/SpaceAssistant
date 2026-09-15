import { describe, expect, it } from 'vitest'
import { projectSurface } from './surfaceProjection'

const msg = (id: string, tokens: number, role: 'user' | 'assistant' = 'user') => ({ id, role, tokens })

describe('surface projection', () => {
  it('always retains current input exactly once and bounds historical users by tokens and count', () => {
    const result = projectSurface({ facts: [msg('old-1', 300), msg('old-2', 300), msg('current', 700)], currentUserMessageId: 'current', prefixTokens: 100, bodyBudget: 1000, maxRetainedUserMessages: 1 })
    expect(result.required.map((m) => m.id)).toEqual(['current'])
    expect(result.history.map((m) => m.id)).toEqual(['old-2'])
    expect(result.all.filter((m) => m.id === 'current')).toHaveLength(1)
  })

  it('returns uncompressible_input when required content exceeds body budget', () => {
    expect(projectSurface({ facts: [msg('current', 101)], currentUserMessageId: 'current', prefixTokens: 0, bodyBudget: 100, maxRetainedUserMessages: 10 }).status).toBe('uncompressible_input')
  })
  it('uses the plan defaults when history limits are omitted', () => {
    const facts = Array.from({ length: 130 }, (_, i) => msg(`old-${i}`, 1))
    const result = projectSurface({ facts: [...facts, msg('current', 1)], currentUserMessageId: 'current', prefixTokens: 0, bodyBudget: 300 })
    expect(result.history).toHaveLength(128)
    expect(result.history.reduce((sum, item) => sum + item.tokens, 0)).toBe(128)
  })
})
