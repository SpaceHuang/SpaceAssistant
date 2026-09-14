import { describe, expect, it } from 'vitest'
import { overwriteConflictNames, planGithubInstall } from './planGithubInstall'
import type { GithubSkillCandidate } from '../../shared/domainTypes'

function candidate(subPath: string, status: GithubSkillCandidate['status']): GithubSkillCandidate {
  return { name: subPath.split('/').pop() ?? subPath, description: '', subPath, totalBytes: 0, status }
}

describe('planGithubInstall', () => {
  it('falls back to the whole repository when nothing was probed yet', () => {
    expect(planGithubInstall({ url: 'https://github.com/obra/superpowers', probedUrl: null, candidates: [], selectedPaths: [] }))
      .toEqual({ mode: 'whole-repo' })
  })

  it('plans a single batch call for the selected candidates', () => {
    const candidates = [candidate('skills/alpha', 'ok'), candidate('skills/beta', 'ok')]
    expect(
      planGithubInstall({
        url: 'https://github.com/obra/superpowers',
        probedUrl: 'https://github.com/obra/superpowers',
        candidates,
        selectedPaths: ['skills/alpha', 'skills/beta']
      })
    ).toEqual({ mode: 'batch', subPaths: ['skills/alpha', 'skills/beta'], overwrite: false })
  })

  it('requests overwrite when a selected candidate conflicts by name', () => {
    const candidates = [candidate('skills/alpha', 'ok'), candidate('skills/beta', 'name-conflict')]
    expect(
      planGithubInstall({
        url: 'https://github.com/obra/superpowers',
        probedUrl: 'https://github.com/obra/superpowers',
        candidates,
        selectedPaths: ['skills/alpha', 'skills/beta']
      })
    ).toEqual({ mode: 'batch', subPaths: ['skills/alpha', 'skills/beta'], overwrite: true })
  })

  it('blocks the install when nothing is selected instead of installing the whole repo', () => {
    const candidates = [candidate('skills/alpha', 'name-conflict')]
    expect(
      planGithubInstall({
        url: 'https://github.com/obra/superpowers',
        probedUrl: 'https://github.com/obra/superpowers',
        candidates,
        selectedPaths: []
      })
    ).toEqual({ mode: 'blocked', reason: 'no-selection' })
  })

  it('blocks the install when the url changed after probing', () => {
    expect(
      planGithubInstall({
        url: 'https://github.com/other/repo',
        probedUrl: 'https://github.com/obra/superpowers',
        candidates: [candidate('skills/alpha', 'ok')],
        selectedPaths: ['skills/alpha']
      })
    ).toEqual({ mode: 'blocked', reason: 'stale-probe' })
  })
})

describe('overwriteConflictNames', () => {
  it('lists only the selected conflicting candidates, de-duplicated and in candidate order', () => {
    const candidates = [
      candidate('skills/alpha', 'name-conflict'),
      candidate('skills/beta', 'ok'),
      candidate('skills/gamma', 'name-conflict'),
      candidate('skills/delta', 'name-conflict')
    ]
    expect(overwriteConflictNames(candidates, ['skills/gamma', 'skills/alpha', 'skills/beta'])).toEqual(['alpha', 'gamma'])
  })

  it('returns an empty list when no conflicting candidate is selected', () => {
    expect(overwriteConflictNames([candidate('skills/alpha', 'name-conflict')], ['skills/beta'])).toEqual([])
  })
})
