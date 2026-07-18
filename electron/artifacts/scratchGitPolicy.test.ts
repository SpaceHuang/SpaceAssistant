import { describe, expect, it } from 'vitest'
import { isScratchRunsIgnored, resolveScratchGitPolicy } from './scratchGitPolicy'

describe('isScratchRunsIgnored', () => {
  it.each(['.spaceassistant/runs/\n', '/.spaceassistant/runs/\n'])('recognizes the exact scratch runs ignore rule: %s', (contents) => {
    expect(isScratchRunsIgnored(contents)).toBe(true)
  })

  it('does not treat a broad or unrelated rule as an exact scratch-runs policy', () => {
    expect(isScratchRunsIgnored('.spaceassistant/\n')).toBe(false)
  })

  it('does not allow editing an external Git root and offers only continue or cancel', () => {
    expect(resolveScratchGitPolicy({ workDir: '/repo/subproject', gitRoot: '/repo', gitignoreContents: '' })).toEqual({
      kind: 'scratch-git-policy', choices: ['keep-visible', 'cancel']
    })
  })
})
