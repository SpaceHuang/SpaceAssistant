import { describe, expect, it, vi } from 'vitest'
import { computeBoundedDiffLineStats, diffLineStats, buildUnifiedDiffLines } from './writeDiffStats'

describe('computeBoundedDiffLineStats', () => {
  it('computes a small edit in a large file after trimming the shared prefix and suffix', () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index}`)
    const before = lines.join('\n')
    const after = `${before}\nextra`

    expect(computeBoundedDiffLineStats(before, after)).toEqual({ kind: 'available', add: 1, remove: 0 })
  })

  it('returns unavailable before diff work when the unmatched region exceeds its cell budget', () => {
    const before = Array.from({ length: 2_000 }, (_, index) => `before ${index}`).join('\n')
    const after = Array.from({ length: 2_000 }, (_, index) => `after ${index}`).join('\n')

    expect(computeBoundedDiffLineStats(before, after)).toEqual({ kind: 'unavailable', reason: 'work-budget-exceeded' })
  })

  it('matches the existing LCS line counts for short duplicate and reordered sequences', () => {
    const sequences = ['']
    for (let length = 1; length <= 3; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        sequences.push(Array.from({ length }, (_, index) => (bits & (1 << index)) === 0 ? 'a' : 'b').join('\n'))
      }
    }
    for (const before of sequences) {
      for (const after of sequences) {
        const expected = diffLineStats(buildUnifiedDiffLines(before, after))
        expect(computeBoundedDiffLineStats(before, after), `${JSON.stringify({ before, after })}`)
          .toEqual({ kind: 'available', ...expected })
      }
    }
  })

  it('turns a statistics exception into unavailable instead of propagating it', () => {
    const originalSplit = String.prototype.split
    const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator?: string | RegExp, limit?: number) {
      if (this === 'before\nline' && separator === '\n') throw new Error('simulated allocation failure')
      return originalSplit.call(this, separator, limit)
    })
    try {
      expect(computeBoundedDiffLineStats('before\nline', 'after\nline'))
        .toEqual({ kind: 'unavailable', reason: 'computation-failed' })
    } finally {
      split.mockRestore()
    }
  })
})
