import { describe, expect, it } from 'vitest'
import { ConfirmationAuthorizationRegistry, type MemoryWritePermitSubject } from './confirmationAuthorizationRegistry'

const subject: MemoryWritePermitSubject = {
  invocationId: 'inv-1', requestId: 'req-1', toolUseId: 'tool-1', sessionId: 'session-1',
  planDigest: 'plan-1', factsDigest: 'facts-1', revision: 'rev-1'
}

describe('ConfirmationAuthorizationRegistry', () => {
  it('issues an immutable permit bound to invocation identity and digests', () => {
    const registry = new ConfirmationAuthorizationRegistry()
    const permit = registry.issue({ ...subject, now: 1000, ttlMs: 100 })
    expect(Object.isFrozen(permit)).toBe(true)
    expect(Object.isFrozen(permit.subject)).toBe(true)
    expect(permit.subject).toEqual(subject)
    expect(permit.expiresAt).toBe(1100)
  })

  it('consumes only once and rejects identity, digest or revision changes', () => {
    const registry = new ConfirmationAuthorizationRegistry()
    const permit = registry.issue(subject)
    expect(registry.consume(permit, subject)).toEqual(subject)
    expect(() => registry.consume(permit, subject)).toThrow('MEMORY_WRITE_PERMIT_INVALID')

    const second = registry.issue(subject)
    expect(() => registry.consume(second, { ...subject, toolUseId: 'other' })).toThrow('MEMORY_WRITE_PERMIT_MISMATCH')
    expect(registry.size()).toBe(1)
  })

  it('rejects expiry and explicit cancellation/stale/replan invalidation', () => {
    const registry = new ConfirmationAuthorizationRegistry()
    const expiring = registry.issue({ ...subject, now: 1000, ttlMs: 10 })
    expect(() => registry.consume(expiring, subject, 1010)).toThrow('MEMORY_WRITE_PERMIT_EXPIRED')

    for (const reason of ['cancelled', 'timeout', 'rejected', 'settled', 'stale', 'replanned'] as const) {
      const permit = registry.issue(subject)
      registry.invalidate(permit.permitId, reason)
      expect(() => registry.consume(permit, subject)).toThrow('MEMORY_WRITE_PERMIT_INVALID')
    }
  })
})
