import { describe, expect, it } from 'vitest'
import { InMemorySafetyPermitStore, type PermitBinding } from '../src/safetyPermit'

const binding: PermitBinding = {
  requestId: 'req-1', turnId: 'turn-1', invocationId: 'inv-1', toolCallId: 'tool-1', capabilityId: 'file.write',
  inputSnapshotHash: 'input-hash', planDigest: 'plan-hash', factsDigest: 'facts-hash', authorizationVersion: 'auth-1', phase: 'recheck'
}

describe('InMemorySafetyPermitStore', () => {
  it('issues an opaque id and atomically consumes exactly once with exact binding', async () => {
    const store = new InMemorySafetyPermitStore()
    const permitId = store.issue(binding, Date.now() + 10_000)
    expect(await store.consume(permitId, binding)).toEqual({ ok: true })
    expect(await store.consume(permitId, binding)).toEqual({ ok: false, reason: 'CONSUMED' })
  })

  it('rejects unknown ids, mismatched bindings, expiration, and invalidation', async () => {
    const store = new InMemorySafetyPermitStore()
    expect(await store.consume('forged', binding)).toEqual({ ok: false, reason: 'UNKNOWN' })
    const permit = store.issue(binding, Date.now() + 10_000)
    expect(await store.consume(permit, { ...binding, inputSnapshotHash: 'changed' })).toEqual({ ok: false, reason: 'BINDING_MISMATCH' })
    store.invalidateInvocation(binding.requestId, 'cancelled')
    expect(await store.consume(permit, binding)).toEqual({ ok: false, reason: 'CANCELLED' })
    const expired = store.issue(binding, Date.now() + 5)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await store.consume(expired, binding)).toEqual({ ok: false, reason: 'EXPIRED' })
  })

  it('settles one permit without deleting a sibling permit in the same request', async () => {
    const store = new InMemorySafetyPermitStore()
    const first = store.issue(binding, Date.now() + 10_000)
    const siblingBinding = { ...binding, invocationId: 'inv-2', toolCallId: 'tool-2' }
    const sibling = store.issue(siblingBinding, Date.now() + 10_000)
    store.settle(first)
    expect(await store.consume(first, binding)).toEqual({ ok: false, reason: 'UNKNOWN' })
    expect(await store.consume(sibling, siblingBinding)).toEqual({ ok: true })
  })
})
