import { describe, expect, it } from 'vitest'
import { ReviewScopeCache, type ReviewScopeCandidate } from './reviewScopeCache'
import { beginReviewScopeWrite } from './reviewScopeWrite'
import type { ToolExecutionContext } from '../tools/types'

const scope: ReviewScopeCandidate = {
  lane: 'desktop', sessionId: 's', subjectId: 'profile', authorizationDomain: { id: 'desktop', revision: 1, epoch: 2 },
  toolName: 'edit_file', operation: 'edit', objects: [{ role: 'target', value: '/work/a.txt' }],
  environment: '/work', policyVersion: 'v1', exactParameters: { oldText: 'old', replaceAll: false }, taskConstraint: 'Update a.txt.'
}
const receipt = { dev: 1, ino: 2, mode: 0o100600, size: 4, nlink: 1, sha256: 'a'.repeat(64) }
const context = (cache: ReviewScopeCache): ToolExecutionContext => ({
  workDir: '/work', userDataDir: '/profile', requestId: 'r', toolUseId: 't', sessionId: 's', sendProgress: () => undefined,
  signal: new AbortController().signal, fileStateCache: {} as never, toolsConfig: {} as never,
  reviewScopeCache: cache, reviewScopeCandidateScope: scope, reviewScopeCandidateDigest: cache.candidateDigest(scope)
})

describe('review scope controlled writes', () => {
  it('activates only after first trusted receipt and advances active generations', () => {
    const cache = new ReviewScopeCache()
    const digest = cache.candidateDigest(scope)
    expect(cache.grant({ scope, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    const first = beginReviewScopeWrite(context(cache))
    expect(first.captureReceipt).toBe(true)
    first.complete(receipt)
    expect(cache.lookup(scope)?.receipt).toEqual(receipt)
    const second = beginReviewScopeWrite(context(cache))
    expect(second.captureReceipt).toBe(true)
    second.complete({ ...receipt, ino: 3, sha256: 'b'.repeat(64) })
    expect(cache.lookup(scope)?.receipt).toMatchObject({ ino: 3, sha256: 'b'.repeat(64) })
  })

  it('revokes a pending grant on a failed or missing receipt and never captures ungranted writes', () => {
    const cache = new ReviewScopeCache()
    const digest = cache.candidateDigest(scope)
    cache.grant({ scope, source: 'agent', scopeCandidateDigest: digest })
    const failed = beginReviewScopeWrite(context(cache))
    failed.fail()
    expect(cache.lookup(scope)).toBeNull()
    const empty = beginReviewScopeWrite(context(cache))
    expect(empty.captureReceipt).toBe(false)
    const otherDigest = cache.candidateDigest(scope)
    cache.grant({ scope, source: 'agent', scopeCandidateDigest: otherDigest })
    beginReviewScopeWrite(context(cache)).complete({ ...receipt, nlink: 2 })
    expect(cache.state(scope)).toBeNull()
  })
})
