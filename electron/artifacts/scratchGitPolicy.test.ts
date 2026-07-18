import { describe, expect, it } from 'vitest'
import { appendScratchRunsIgnore, isScratchRunsIgnored, resolveScratchGitPolicy, validateSavedScratchGitPolicy } from './scratchGitPolicy'

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

  it('adds only the exact scratch-runs rule and revalidates it', () => {
    const updated = appendScratchRunsIgnore('node_modules/\n')
    expect(updated).toBe('node_modules/\n.spaceassistant/runs/\n')
    expect(isScratchRunsIgnored(updated)).toBe(true)
  })

  it('invalidates a saved add-ignore policy when its external rule disappears', () => {
    expect(validateSavedScratchGitPolicy('add-ignore', '')).toEqual({ valid: false, savedPolicy: undefined })
    expect(validateSavedScratchGitPolicy('keep-visible', '')).toEqual({ valid: true, savedPolicy: 'keep-visible' })
  })

  it('requests add-ignore/keep-visible/cancel on the first scratch create without a saved policy', () => {
    expect(resolveScratchGitPolicy({
      workDir: '/workspace',
      gitRoot: '/workspace',
      gitignoreContents: 'node_modules/\n'
    })).toEqual({
      kind: 'scratch-git-policy',
      choices: ['add-ignore', 'keep-visible', 'cancel']
    })
  })

  it('skips the decision when a valid workspace-level saved policy exists', () => {
    expect(resolveScratchGitPolicy({
      workDir: '/workspace',
      gitRoot: '/workspace',
      gitignoreContents: 'node_modules/\n',
      savedPolicy: 'keep-visible'
    })).toEqual({ kind: 'none' })
    expect(resolveScratchGitPolicy({
      workDir: '/workspace',
      gitRoot: '/workspace',
      gitignoreContents: '.spaceassistant/runs/\n',
      savedPolicy: 'add-ignore'
    })).toEqual({ kind: 'none' })
  })
})
