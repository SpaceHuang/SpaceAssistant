import { describe, expect, it, vi } from 'vitest'
import { createDeferredApprovalCloseCoordinator } from './deferredApprovalCloseCoordinator'
import { createMemoryAppDb } from '../database/testHelpers'
import { createRemoteAuthorizationEpochStore } from './remoteAuthorizationEpochStore'

const expectedOrder = [
  'blockNewDispatch', 'persistClosureFacts', 'invalidatePendingTodos', 'cancelResumeRequests',
  'revokeConsumedPermits', 'reconcile', 'rollbackToUser'
]

function createPort(failAt?: string) {
  const calls: string[] = []
  const port = Object.fromEntries(expectedOrder.map((step) => [step, vi.fn(async () => {
    calls.push(step)
    if (step === failAt) throw new Error(`injected-${step}`)
    return { ok: true }
  })]))
  return { calls, port }
}

describe('deferred async approval close coordinator contract', () => {
  it('executes shutdown, durable revoke, reconciliation and fallback in the required order', async () => {
    const { calls, port } = createPort()
    const db = createMemoryAppDb()
    const coordinator = createDeferredApprovalCloseCoordinator({ db, port })
    await expect(coordinator.close({ channel: 'wechat', identityKey: 'identity', ownerId: 'owner', sessionId: 'session' }))
      .resolves.toMatchObject({ status: 'closed' })
    expect(calls).toEqual(expectedOrder)
    expect(coordinator.getClosure({ channel: 'wechat', identityKey: 'identity', ownerId: 'owner', sessionId: 'session' }))
      .toMatchObject({ state: 'closed', authorizationEpoch: 2 })
    db.close()
  })

  it.each(expectedOrder)('does not run later stages or report closed when %s fails', async (failAt) => {
    const { calls, port } = createPort(failAt)
    const db = createMemoryAppDb()
    const coordinator = createDeferredApprovalCloseCoordinator({ db, port })
    await expect(coordinator.close({ channel: 'wechat', identityKey: 'identity', ownerId: 'owner', sessionId: 'session' }))
      .resolves.toMatchObject({ status: 'reconciliation_required', failedAt: failAt })
    expect(calls).toEqual(expectedOrder.slice(0, expectedOrder.indexOf(failAt) + 1))
    if (failAt !== 'rollbackToUser') expect(calls).not.toContain('rollbackToUser')
    if (failAt !== 'blockNewDispatch') expect(coordinator.getClosure({ channel: 'wechat', identityKey: 'identity', ownerId: 'owner', sessionId: 'session' }))
      .toMatchObject({ state: 'reconciliation_required' })
    db.close()
  })

  it('advances the durable authority epoch and creates a fresh tombstone for every completed close', async () => {
    const db = createMemoryAppDb()
    const epochs = createRemoteAuthorizationEpochStore(db)
    const { port } = createPort()
    const scope = { channel: 'feishu' as const, identityKey: 'chat', ownerId: 'owner', sessionId: 'session' }
    const coordinator = createDeferredApprovalCloseCoordinator({ db, port })
    await coordinator.close(scope)
    const first = coordinator.getClosure(scope)!
    await coordinator.close(scope)
    const second = coordinator.getClosure(scope)!
    expect(epochs.current('feishu')).toBe(3)
    expect(second.authorizationEpoch).toBe(3)
    expect(second.tombstone).not.toBe(first.tombstone)
    db.close()
  })
})
