import { describe, expect, it } from 'vitest'
import { InMemoryExecutionAdmissionCoordinator, type PermitBinding } from '../src/executionAdmission'

const binding: PermitBinding = {
  requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'call', capabilityId: 'file.write',
  inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'v1', phase: 'recheck'
}

describe('InMemoryExecutionAdmissionCoordinator', () => {
  it('blocks dispatch if cancellation linearizes before claim', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    coordinator.invalidate({ requestId: 'req', invocationId: 'inv' }, 'cancelled')
    await expect(coordinator.beginDispatch('permit', binding)).resolves.toMatchObject({ ok: false, reason: 'CANCELLED' })
    expect(coordinator.executorEntries).toBe(0)
  })

  it('allows one claim and propagates a later cancellation through the lease signal', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    const claimed = await coordinator.beginDispatch('permit', binding)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    coordinator.invalidate({ requestId: 'req', invocationId: 'inv' }, 'cancelled')
    expect(claimed.signal.aborted).toBe(true)
    expect((await coordinator.beginDispatch('permit', binding)).ok).toBe(false)
  })

  it('duplicate consume notification cannot reopen an already claimed permit', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    const first = await coordinator.beginDispatch('permit', binding)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    first.lease.close('completed')

    expect(() => coordinator.markPermitConsumed('permit', { ...binding, toolCallId: 'forged-call' }))
      .toThrow('PERMIT_CONSUMPTION_BINDING_CHANGED')
    coordinator.markPermitConsumed('permit', binding)

    await expect(coordinator.beginDispatch('permit', binding)).resolves.toMatchObject({
      ok: false, reason: 'PERMIT_NOT_CONSUMED'
    })
    expect(coordinator.executorEntries).toBe(0)
  })

  it('rechecks cancellation after awaiting trusted prepared-record validation', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    let finishValidation!: (value: boolean) => void
    const pending = coordinator.beginDispatch('permit', binding, () => new Promise<boolean>((resolve) => { finishValidation = resolve }))
    await Promise.resolve()
    coordinator.invalidate({ requestId: 'req', invocationId: 'inv' }, 'cancelled')
    finishValidation(true)
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'CANCELLED' })
    expect(coordinator.executorEntries).toBe(0)
  })

  it.each([
    ['revocation', 'revoked', 'REVOKED'],
    ['authorization version change', 'authorization-changed', 'AUTHORIZATION_STALE']
  ] as const)('lets %s win while trusted prepared-record validation is suspended', async (_label, invalidation, reason) => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    let finishValidation!: (value: boolean) => void
    const pending = coordinator.beginDispatch('permit', binding, () => new Promise<boolean>((resolve) => { finishValidation = resolve }))
    await Promise.resolve()
    coordinator.invalidate({ requestId: 'req', invocationId: 'inv' }, invalidation)
    finishValidation(true)
    await expect(pending).resolves.toMatchObject({ ok: false, reason })
    expect(coordinator.executorEntries).toBe(0)
    expect(coordinator.activeLeaseCount('req', 'inv')).toBe(0)
  })

  it('blocks dispatch when the trusted prepared record changed after consume', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    await expect(coordinator.beginDispatch('permit', binding, async () => false)).resolves.toMatchObject({ ok: false, reason: 'AUTHORIZATION_STALE' })
    expect(coordinator.executorEntries).toBe(0)
  })

  it('scopes a tool revocation to its invocation without cancelling sibling tool calls', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    const sibling = { ...binding, invocationId: 'inv-sibling', toolCallId: 'call-sibling' }
    coordinator.markPermitConsumed('permit-a', binding)
    coordinator.markPermitConsumed('permit-b', sibling)
    coordinator.invalidate({ requestId: 'req', invocationId: 'inv' }, 'revoked')
    await expect(coordinator.beginDispatch('permit-a', binding)).resolves.toMatchObject({ ok: false, reason: 'REVOKED' })
    await expect(coordinator.beginDispatch('permit-b', sibling)).resolves.toMatchObject({ ok: true })
  })

  it('settles consumed permit state and releases invocation invalidation after the last lease', async () => {
    const coordinator = new InMemoryExecutionAdmissionCoordinator()
    coordinator.markPermitConsumed('permit', binding)
    coordinator.invalidate({ requestId: 'req', invocationId: 'inv' }, 'revoked')
    await expect(coordinator.beginDispatch('permit', binding)).resolves.toMatchObject({ ok: false, reason: 'REVOKED' })
    coordinator.settle('permit')

    coordinator.markPermitConsumed('next-permit', binding)
    await expect(coordinator.beginDispatch('next-permit', binding)).resolves.toMatchObject({ ok: true })
  })
})
