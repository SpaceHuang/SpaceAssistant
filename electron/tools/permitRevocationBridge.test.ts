import { describe, expect, it, vi } from 'vitest'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { InMemorySafetyPermitStore, type PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { bindToolRevocationToExecution } from './permitRevocationBridge'

const binding: PermitBinding = {
  requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'tc', capabilityId: 'lookup',
  inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth-v1', phase: 'recheck'
}

describe('permit revocation bridge', () => {
  it('invalidates issued permits, prepared state and unclaimed dispatch for the revoked invocation', async () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('req', 'automation', 'req')
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const prepared = { invalidate: vi.fn() }
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const siblingBinding = { ...binding, invocationId: 'sibling', toolCallId: 'sibling-call' }
    const siblingPermit = permits.issue(siblingBinding, Date.now() + 10_000)
    expect(await permits.consume(permitId, binding)).toEqual({ ok: true })
    admission.markPermitConsumed(permitId, binding)
    const disconnect = bindToolRevocationToExecution({ registry, permits, admission, prepared, requestId: 'req', invocationId: 'inv', toolName: 'lookup' })

    registry.revokeToolForAllLanes('lookup')

    await expect(admission.beginDispatch(permitId, binding)).resolves.toMatchObject({ ok: false, reason: 'REVOKED' })
    expect(prepared.invalidate).toHaveBeenCalledWith('inv')
    expect(await permits.consume(permitId, binding)).toEqual({ ok: false, reason: 'CONSUMED' })
    expect(await permits.consume(siblingPermit, siblingBinding)).toEqual({ ok: true })
    disconnect()
  })

  it('ignores revocations for another request or capability', () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('req', 'desktop', 'req')
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const prepared = { invalidate: vi.fn() }
    const disconnect = bindToolRevocationToExecution({ registry, permits, admission, prepared, requestId: 'req', invocationId: 'inv', toolName: 'lookup' })
    registry.revokeToolForLane('desktop', 'write_file')
    expect(prepared.invalidate).not.toHaveBeenCalled()
    disconnect()
  })
})
