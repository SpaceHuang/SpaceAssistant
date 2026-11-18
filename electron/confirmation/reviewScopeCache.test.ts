import { describe, expect, it } from 'vitest'
import { ReviewScopeCache } from './reviewScopeCache'

const scope = (overrides: Partial<Parameters<ReviewScopeCache['candidateDigest']>[0]> = {}) => ({
  lane: 'desktop' as const,
  sessionId: 'session-a',
  subjectId: 'profile-a',
  authorizationDomain: { id: 'desktop-policy', revision: 3, epoch: 4 },
  toolName: 'edit_file',
  operation: 'edit',
  objects: [{ role: 'target', value: '/work/a.txt' }],
  environment: '/work',
  policyVersion: 'policy-v7',
  taskConstraint: 'Update the requested document.',
  exactParameters: { replace: 'first text', options: { b: 2, a: 1 } },
  ...overrides
})

describe('ReviewScopeCache', () => {
  it('inherits recursive grep grants only for semantically contained child roots and identical query constraints', () => {
    const cache = new ReviewScopeCache()
    const parent = scope({ toolName: 'grep', operation: 'search', objects: [{ role: 'root', value: '/work/docs' }], exactParameters: { pattern: 'needle', includeIgnored: false, engine: 'walk', engineFingerprint: 'e'.repeat(64), ignoreDigest: 'c'.repeat(64) } })
    const digest = cache.candidateDigest(parent)
    expect(cache.grant({ scope: parent, source: 'user', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.lookup(scope({ ...parent, objects: [{ role: 'root', value: '/work/docs/design' }] }))).toMatchObject({
      source: 'user', inheritedParentScope: { root: '/work/docs', ignoreDigest: 'c'.repeat(64) }
    })
    expect(cache.lookup(scope({ ...parent, objects: [{ role: 'root', value: '/work/docs-old' }] }))).toBeNull()
    expect(cache.lookup(scope({ ...parent, objects: [{ role: 'root', value: '/work/docs/design' }], exactParameters: { pattern: 'different', includeIgnored: false, ignoreDigest: 'c'.repeat(64) } }))).toBeNull()
    expect(cache.lookup(scope({ ...parent, objects: [{ role: 'root', value: '/work/docs/.private' }] }))).toBeNull()
    expect(cache.lookup(scope({ ...parent, objects: [{ role: 'root', value: '/work/docs/node_modules' }] }))).toBeNull()
    expect(cache.lookup(scope({ ...parent, objects: [{ role: 'root', value: '/work/docs/design' }], exactParameters: { ...parent.exactParameters, glob: 'src/*.ts' } }))).toBeNull()
    const ignoredParent = scope({ toolName: 'grep', operation: 'search', objects: [{ role: 'root', value: '/work/docs' }], exactParameters: { pattern: 'needle', includeIgnored: true, engine: 'walk', engineFingerprint: 'e'.repeat(64), ignoreDigest: 'c'.repeat(64) } })
    expect(cache.grant({ scope: ignoredParent, source: 'user', scopeCandidateDigest: cache.candidateDigest(ignoredParent) })).toBe(true)
    expect(cache.lookup(scope({ ...ignoredParent, objects: [{ role: 'root', value: '/work/docs/.private' }] }))).toMatchObject({ source: 'user' })
  })
  it('makes a valid file grant usable immediately without waiting for a successful first write', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)

    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.lookup(candidate)).toMatchObject({ state: 'active', source: 'agent' })
  })

  it('binds candidates to lane, session, verified subject, policy generation, tool, operation and all objects', () => {
    const cache = new ReviewScopeCache()
    const digest = cache.candidateDigest(scope())
    expect(cache.candidateDigest(scope({ exactParameters: { replace: 'first text', options: { a: 1, b: 2 } } }))).toBe(digest)
    expect(cache.candidateDigest(scope({ exactParameters: { replace: 'first text', options: { a: 1, b: 3 } } }))).toBe(digest)
    expect(cache.candidateDigest(scope({ objects: [{ role: 'source', value: '/work/a.txt' }] }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ lane: 'feishu' }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ subjectId: 'profile-b' }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ toolName: 'write_file', operation: 'write' }))).toBe(digest)
    expect(() => cache.candidateDigest(scope({ operation: 'overwrite' }))).toThrow('REVIEW_SCOPE_CAPABILITY_INVALID')
    expect(cache.candidateDigest(scope({ policyVersion: 'policy-v8' }))).not.toBe(digest)
  })

  it('normalizes edit and write grants to the same path scope and ignores task or body changes', () => {
    const cache = new ReviewScopeCache()
    const digest = cache.candidateDigest(scope())
    expect(cache.candidateDigest(scope({
      toolName: 'write_file', operation: 'write', taskConstraint: 'Different follow-up task.',
      exactParameters: { content: 'a much larger replacement body' }
    }))).toBe(digest)
  })

  it('never treats missing, empty, malformed, or unserializable object coverage as a wildcard', () => {
    const cache = new ReviewScopeCache()
    expect(() => cache.candidateDigest(scope({ objects: [] }))).toThrow('REVIEW_SCOPE_OBJECTS_REQUIRED')
    expect(() => cache.candidateDigest(scope({ objects: [{ role: '', value: '/work/a.txt' }] }))).toThrow('REVIEW_SCOPE_OBJECT_INVALID')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => cache.candidateDigest(scope({ exactParameters: cyclic }))).toThrow('REVIEW_SCOPE_PARAMETERS_INVALID')
  })

  it('registers an Agent grant only when the exact host candidate digest is returned', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: `${digest}x` })).toBe(false)
    expect(cache.lookup(candidate)).toBeNull()
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.lookup(candidate)).toMatchObject({ state: 'active', source: 'agent' })
  })

  it('allows a newly approved agent source after the same candidate was approved by the user', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    expect(cache.grant({ scope: candidate, source: 'user', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.lookup(candidate)).toMatchObject({ source: 'agent' })
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(false)
  })

  it('keeps sessions isolated and clearing a session destroys its lookup key', () => {
    const cache = new ReviewScopeCache()
    const first = scope()
    const digest = cache.candidateDigest(first)
    cache.grant({ scope: first, source: 'agent', scopeCandidateDigest: digest })
    expect(cache.lookup(scope({ sessionId: 'session-b' }))).toBeNull()
    cache.clearSession('desktop', 'session-a')
    expect(cache.lookup(first)).toBeNull()
    expect(cache.candidateDigest(first)).not.toBe(digest)
  })

  it('rejects a late digest-only grant after the host cleared the session secret', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    cache.clearSession(candidate.lane, candidate.sessionId)
    expect(cache.grantDigest({ lane: candidate.lane, sessionId: candidate.sessionId, source: 'agent',
      scopeCandidateDigest: digest })).toBe(false)
  })

  it('evicts the oldest approved record when capacity is reached', () => {
    const cache = new ReviewScopeCache({ maxEntriesPerSession: 1, maxEntriesTotal: 1, maxEntryBytes: 16_384 })
    const first = scope()
    const firstDigest = cache.candidateDigest(first)
    cache.grant({ scope: first, source: 'agent', scopeCandidateDigest: firstDigest })
    const second = scope({ objects: [{ role: 'target', value: '/work/b.txt' }] })
    const secondDigest = cache.candidateDigest(second)
    expect(cache.grant({ scope: second, source: 'agent', scopeCandidateDigest: secondDigest })).toBe(true)
    expect(cache.lookup(first)).toBeNull()
    expect(cache.size).toBe(1)
  })

  it('keeps an approved write scope active without storing execution results', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.lookup(candidate)).toMatchObject({ state: 'active', source: 'agent' })
    for (let resultIndex = 0; resultIndex < 5; resultIndex += 1) {
      expect(cache.lookup(candidate)).toMatchObject({ state: 'active', source: 'agent' })
    }
  })
})

describe('ReviewScopeCache randomized state invariants', () => {
  it('preserves capacity and active-grant invariants under seeded operation sequences', () => {
    let seed = 0x6d2b79f5
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const cache = new ReviewScopeCache({ maxEntriesPerSession: 3, maxEntriesTotal: 3 })
    const scopes = Array.from({ length: 5 }, (_, index) => scope({
      sessionId: `random-${index % 2}`, objects: [{ role: 'target', value: `/work/${index}.txt` }],
      exactParameters: { oldText: `old-${index}`, replaceAll: false }, taskConstraint: `Task ${index}`
    }))
    for (let step = 0; step < 300; step++) {
      const index = random() % scopes.length
      const current = scopes[index]!
      const operation = random() % 4
      const digest = cache.candidateDigest(current)
      if (operation === 0) cache.grant({ scope: current, source: 'agent', scopeCandidateDigest: digest })
      else if (operation === 1) cache.revoke(current)
      else if (operation === 2) cache.clearSession(current.lane, current.sessionId)
      else cache.clearAll()

      expect(cache.size).toBeLessThanOrEqual(3)
      for (const candidate of scopes) {
        const state = cache.state(candidate)
        if (!state) continue
        expect(state.state).toBe('active')
      }
    }
    cache.clearAll()
    expect(cache.size).toBe(0)
    for (const candidate of scopes) expect(cache.state(candidate)).toBeNull()
  })
})
