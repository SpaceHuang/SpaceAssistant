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
  it('binds candidates to lane, session, verified subject, policy generation, tool, operation and all objects', () => {
    const cache = new ReviewScopeCache()
    const digest = cache.candidateDigest(scope())
    expect(cache.candidateDigest(scope({ exactParameters: { replace: 'first text', options: { a: 1, b: 2 } } }))).toBe(digest)
    expect(cache.candidateDigest(scope({ exactParameters: { replace: 'first text', options: { a: 1, b: 3 } } }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ objects: [{ role: 'source', value: '/work/a.txt' }] }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ lane: 'feishu' }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ subjectId: 'profile-b' }))).not.toBe(digest)
    expect(cache.candidateDigest(scope({ toolName: 'write_file', operation: 'write' }))).not.toBe(digest)
    expect(() => cache.candidateDigest(scope({ operation: 'overwrite' }))).toThrow('REVIEW_SCOPE_CAPABILITY_INVALID')
    expect(cache.candidateDigest(scope({ policyVersion: 'policy-v8' }))).not.toBe(digest)
  })

  it('never treats missing, empty, malformed, or unserializable object coverage as a wildcard', () => {
    const cache = new ReviewScopeCache()
    expect(() => cache.candidateDigest(scope({ objects: [] }))).toThrow('REVIEW_SCOPE_OBJECTS_REQUIRED')
    expect(() => cache.candidateDigest(scope({ objects: [{ role: '', value: '/work/a.txt' }] }))).toThrow('REVIEW_SCOPE_OBJECT_INVALID')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => cache.candidateDigest(scope({ exactParameters: cyclic }))).toThrow('REVIEW_SCOPE_PARAMETERS_INVALID')
  })

  it('does not store an Agent grant until the exact host candidate digest is returned', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: `${digest}x` })).toBe(false)
    expect(cache.lookup(candidate)).toBeNull()
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.lookup(candidate)).toBeNull()
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
      scopeCandidateDigest: digest, firstWrite: true })).toBe(false)
  })

  it('rejects over-capacity records and only evicts active entries, never pending writes', () => {
    const cache = new ReviewScopeCache({ maxEntriesPerSession: 1, maxEntriesTotal: 1, maxEntryBytes: 16_384 })
    const first = scope()
    const firstDigest = cache.candidateDigest(first)
    cache.grant({ scope: first, source: 'agent', scopeCandidateDigest: firstDigest })
    const second = scope({ objects: [{ role: 'target', value: '/work/b.txt' }] })
    const secondDigest = cache.candidateDigest(second)
    expect(cache.grant({ scope: second, source: 'agent', scopeCandidateDigest: secondDigest })).toBe(false)
    expect(cache.lookup(first)).toBeNull()
    expect(cache.size).toBe(1)
  })

  it('activates a write scope only from a valid receipt and advances its generation after a committed write', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    const receipt = { dev: 1, ino: 2, mode: 0o100644, size: 20, nlink: 1, sha256: 'a'.repeat(64) }
    expect(cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })).toBe(true)
    expect(cache.activateFirstWrite(candidate, digest, { ...receipt, nlink: 2 })).toBe(false)
    expect(cache.lookup(candidate)).toBeNull()
    expect(cache.activateFirstWrite(candidate, digest, receipt)).toBe(true)
    const first = cache.lookup(candidate)
    expect(first).toMatchObject({ state: 'active', source: 'agent', receipt })
    const lease = cache.beginWrite(candidate)
    expect(lease).toBeTruthy()
    expect(cache.lookup(candidate)).toBeNull()
    expect(cache.completeWrite(lease!, { ...receipt, ino: 3, sha256: 'b'.repeat(64) })).toBe(true)
    expect(cache.lookup(candidate)).toMatchObject({ state: 'active', receipt: { ino: 3, sha256: 'b'.repeat(64) } })
    expect(cache.completeWrite(lease!, receipt)).toBe(false)
  })

  it('revokes a pending write lease on failure so a later lookup falls back', () => {
    const cache = new ReviewScopeCache()
    const candidate = scope()
    const digest = cache.candidateDigest(candidate)
    const receipt = { dev: 1, ino: 2, mode: 0o100644, size: 20, nlink: 1, sha256: 'a'.repeat(64) }
    cache.grant({ scope: candidate, source: 'agent', scopeCandidateDigest: digest })
    cache.activateFirstWrite(candidate, digest, receipt)
    const lease = cache.beginWrite(candidate)!
    expect(cache.failWrite(lease)).toBe(true)
    expect(cache.lookup(candidate)).toBeNull()
  })
})

describe('ReviewScopeCache randomized state invariants', () => {
  it('preserves capacity, receipt, and generation invariants under seeded operation sequences', () => {
    let seed = 0x6d2b79f5
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const cache = new ReviewScopeCache({ maxEntriesPerSession: 3, maxEntriesTotal: 3 })
    const scopes = Array.from({ length: 5 }, (_, index) => scope({
      sessionId: `random-${index % 2}`, objects: [{ role: 'target', value: `/work/${index}.txt` }],
      exactParameters: { oldText: `old-${index}`, replaceAll: false }, taskConstraint: `Task ${index}`
    }))
    const staleLeases: Array<{ scopeIndex: number; lease: ReturnType<ReviewScopeCache['beginWrite']> }> = []
    for (let step = 0; step < 300; step++) {
      const index = random() % scopes.length
      const current = scopes[index]!
      const operation = random() % 7
      const digest = cache.candidateDigest(current)
      if (operation === 0) cache.grant({ scope: current, source: 'agent', scopeCandidateDigest: digest })
      else if (operation === 1) cache.activateFirstWrite(current, digest, {
        dev: 1, ino: index + 10, mode: 0o100600, size: index, nlink: 1, sha256: (index.toString(16).padStart(2, '0')).repeat(32)
      })
      else if (operation === 2) {
        const lease = cache.beginWrite(current)
        if (lease) staleLeases.push({ scopeIndex: index, lease })
      } else if (operation === 3) {
        const held = staleLeases.splice(0, 1)[0]
        if (held) cache.completeWrite(held.lease!, {
          dev: 1, ino: held.scopeIndex + 30, mode: 0o100600, size: held.scopeIndex, nlink: 1,
          sha256: 'c'.repeat(64)
        })
      } else if (operation === 4) {
        const held = staleLeases.splice(0, 1)[0]
        if (held?.lease) cache.failWrite(held.lease)
      } else if (operation === 5) cache.revoke(current)
      else if (random() % 2) cache.clearSession(current.lane, current.sessionId)
      else cache.clearAll()

      expect(cache.size).toBeLessThanOrEqual(3)
      for (const candidate of scopes) {
        const state = cache.state(candidate)
        if (!state) continue
        if (state.state === 'active') expect(state.receipt).toMatchObject({ nlink: 1, sha256: /^[a-f0-9]{64}$/ })
        else expect(state.receipt).toBeUndefined()
      }
    }
    cache.clearAll()
    expect(cache.size).toBe(0)
    for (const candidate of scopes) expect(cache.state(candidate)).toBeNull()
  })
})
