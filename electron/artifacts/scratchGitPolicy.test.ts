import { describe, expect, it } from 'vitest'
import { isScratchRunsIgnored } from './scratchGitPolicy'

describe('isScratchRunsIgnored', () => {
  it.each(['.spaceassistant/runs/\n', '/.spaceassistant/runs/\n'])('recognizes the exact scratch runs ignore rule: %s', (contents) => {
    expect(isScratchRunsIgnored(contents)).toBe(true)
  })

  it('does not treat a broad or unrelated rule as an exact scratch-runs policy', () => {
    expect(isScratchRunsIgnored('.spaceassistant/\n')).toBe(false)
  })
})
