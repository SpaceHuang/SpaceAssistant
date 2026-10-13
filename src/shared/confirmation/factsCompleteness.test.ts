import { describe, expect, it } from 'vitest'
import { resolveFactsCompleteness } from './factsCompleteness'

describe('facts completeness safety matrix', () => {
  it('evaluates only complete facts', () => {
    expect(resolveFactsCompleteness('complete')).toEqual({ completeness: 'complete', disposition: 'evaluate' })
  })

  it.each(['partial', 'missing', 'authentication-missing', 'capability-description-stale'] as const)(
    'requires a human decision when facts are %s', (completeness) => {
      expect(resolveFactsCompleteness(completeness)).toEqual({ completeness, disposition: 'human-required' })
    }
  )

  it('forbids actions when fact extraction fails and rejects unknown runtime statuses', () => {
    expect(resolveFactsCompleteness('parse-failed')).toEqual({ completeness: 'parse-failed', disposition: 'forbidden' })
    expect(() => resolveFactsCompleteness('unknown' as never)).toThrow(/completeness/i)
  })
})
