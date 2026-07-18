import { describe, expect, it } from 'vitest'
import { validateDecisionDirectory, validateDecisionRename } from './pathDecisionInput'

describe('artifact decision path input', () => {
  it('accepts only a single filename for rename', () => {
    expect(validateDecisionRename('review-v2.md')).toBe('review-v2.md')
    expect(() => validateDecisionRename('../escape.md')).toThrow(/filename/i)
  })

  it('accepts only a relative traversal-free directory for change-directory', () => {
    expect(validateDecisionDirectory('reports/final')).toBe('reports/final')
    expect(() => validateDecisionDirectory('/tmp')).toThrow(/directory/i)
    expect(() => validateDecisionDirectory('../outside')).toThrow(/directory/i)
  })
})
