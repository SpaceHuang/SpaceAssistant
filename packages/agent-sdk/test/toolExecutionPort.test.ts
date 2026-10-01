import { describe, expect, it, vi } from 'vitest'
import { createPermitBoundToolExecutionPort, ToolExecutionAfterDispatchError } from '../src/toolExecutionPort'
import { InMemoryExecutionAdmissionCoordinator } from '../src/executionAdmission'
import { InMemorySafetyPermitStore, type PermitBinding } from '../src/safetyPermit'

const binding: PermitBinding = {
  requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'tc', capabilityId: 'lookup',
  inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth-v1', phase: 'recheck'
}
const call = { invocationId: 'inv', toolCallId: 'tc', toolName: 'lookup', input: { q: 'x' } }

describe('permit-bound ToolExecutionPort', () => {
  it('resolves trusted binding, consumes once, claims dispatch and closes the lease around execution', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const order: string[] = []
    const port = createPermitBoundToolExecutionPort({
      permits,
      admission,
      resolveExpected: async () => { order.push('resolve-trusted'); return binding },
      execute: async (_call, signal) => { order.push('execute'); expect(signal.aborted).toBe(false); return { output: 'ok' } },
    })

    await expect(port.execute(call, permitId)).resolves.toEqual({ output: 'ok' })
    expect(order).toEqual(['resolve-trusted', 'execute'])
    expect(admission.executorEntries).toBe(1)
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it('commits the dispatch-start callback only after a successful claim and before executor entry', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const order: string[] = []
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      execute: async () => { order.push('execute'); return { output: 'ok' } }
    })

    await expect(port.execute(call, permitId, () => { order.push('dispatch-claimed') })).resolves.toEqual({ output: 'ok' })
    expect(order).toEqual(['dispatch-claimed', 'execute'])
    expect(admission.executorEntries).toBe(1)
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it('does not enter executor and closes the claimed lease when dispatch-start persistence fails', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({ permits, admission, resolveExpected: async () => binding, execute })

    await expect(port.execute(call, permitId, () => { throw new Error('History unavailable') })).rejects.toThrow('History unavailable')
    expect(execute).not.toHaveBeenCalled()
    expect(admission.closedOutcomes.get(permitId)).toBe('failed')
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it.each(['cancelled', 'revoked', 'authorization-changed'] as const)(
    'does not enter executor when %s invalidates the claimed lease while dispatch-start is pending',
    async (invalidation) => {
      const permits = new InMemorySafetyPermitStore()
      const admission = new InMemoryExecutionAdmissionCoordinator()
      const permitId = permits.issue(binding, Date.now() + 10_000)
      const controller = new AbortController()
      let releaseDispatchStart!: () => void
      let onRevocation!: () => void
      let onAuthorizationChange!: () => void
      let authorizationVersion = 'auth-v1'
      const dispatchStartPending = new Promise<void>((resolve) => { releaseDispatchStart = resolve })
      const execute = vi.fn(async () => ({ output: 'should not execute' }))
      const port = createPermitBoundToolExecutionPort({
        permits,
        admission,
        resolveExpected: async () => binding,
        currentAuthorizationVersion: () => authorizationVersion,
        subscribeRevocation: (_call, listener) => { onRevocation = listener; return () => undefined },
        subscribeAuthorizationChange: (_call, listener) => { onAuthorizationChange = listener; return () => undefined },
        execute
      })

      const pending = port.execute({ ...call, signal: controller.signal }, permitId, () => dispatchStartPending)
      await vi.waitFor(() => expect(admission.activeLeaseCount(binding.requestId)).toBe(1))

      if (invalidation === 'cancelled') controller.abort()
      if (invalidation === 'revoked') onRevocation()
      if (invalidation === 'authorization-changed') {
        authorizationVersion = 'auth-v2'
        onAuthorizationChange()
      }
      releaseDispatchStart()

      await expect(pending).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED' })
      expect(execute).not.toHaveBeenCalled()
      expect(admission.executorEntries).toBe(0)
      expect(admission.closedOutcomes.get(permitId)).toBe('cancelled')
      expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
    }
  )

  it('fails before executor entry when permit consumption rejects', async () => {
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({
      permits: new InMemorySafetyPermitStore(),
      admission: new InMemoryExecutionAdmissionCoordinator(),
      resolveExpected: async () => binding,
      execute
    })
    await expect(port.execute(call, 'forged')).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED', reason: 'UNKNOWN' })
    expect(execute).not.toHaveBeenCalled()
  })


  it('rejects initial-compat permits unless the host explicitly enables that phase', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const legacyBinding = { ...binding, phase: 'initial-compat' as const }
    const permitId = permits.issue(legacyBinding, Date.now() + 10_000)
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({ permits, admission, resolveExpected: async () => legacyBinding, execute })
    await expect(port.execute(call, permitId)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED', reason: 'BINDING_MISMATCH' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('lets cancellation linearize after consume but before beginDispatch', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const baseMark = admission.markPermitConsumed.bind(admission)
    vi.spyOn(admission, 'markPermitConsumed').mockImplementation((id, expected) => {
      baseMark(id, expected)
      admission.invalidate({ requestId: expected.requestId, invocationId: expected.invocationId }, 'cancelled')
    })
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({ permits, admission, resolveExpected: async () => binding, execute })

    await expect(port.execute(call, permitId)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED', reason: 'CANCELLED' })
    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
  })

  it('revalidates the private prepared snapshot after consume before claiming dispatch', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      validatePrepared: () => false,
      execute
    })
    await expect(port.execute(call, permitId)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED', reason: 'AUTHORIZATION_STALE' })
    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
  })

  it('reports REVOKED when the capability was revoked before the dispatch listener was installed', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      isRevoked: () => true,
      subscribeRevocation: () => () => undefined,
      execute
    })

    await expect(port.execute(call, permitId)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED', reason: 'REVOKED' })
    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it('propagates cancellation through the claimed lease after executor entry', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    let releaseExecutor!: (error?: Error) => void
    let executorSignal!: AbortSignal
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      execute: async (_call, signal) => {
        executorSignal = signal
        await new Promise<void>((resolve, reject) => { releaseExecutor = (error) => error ? reject(error) : resolve() })
        if (signal.aborted) throw new Error('executor cancelled after dispatch')
        return { output: 'settled' }
      }
    })

    const pending = port.execute(call, permitId)
    await vi.waitFor(() => expect(executorSignal).toBeDefined())
    admission.invalidate({ requestId: binding.requestId, invocationId: binding.invocationId }, 'revoked')
    expect(executorSignal.aborted).toBe(true)
    releaseExecutor()
    await expect(pending).rejects.toThrow('executor cancelled after dispatch')
    expect(admission.closedOutcomes.get(permitId)).toBe('unknown-after-dispatch')
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it('treats an executor acknowledgement after host revocation as unknown after dispatch', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    let onRevocation!: () => void
    let unsubscribed = false
    let executorSignal!: AbortSignal
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      subscribeRevocation: (_call: typeof call, listener: () => void) => { onRevocation = listener; return () => { unsubscribed = true } },
      execute: async (_call, signal) => {
        executorSignal = signal
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { output: 'aborted by host revocation' }
      }
    })

    const pending = port.execute(call, permitId)
    await vi.waitFor(() => expect(executorSignal).toBeDefined())
    onRevocation()
    expect(executorSignal.aborted).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(unsubscribed).toBe(true)
    expect(admission.closedOutcomes.get(permitId)).toBe('unknown-after-dispatch')
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it('treats an executor acknowledgement after authorization change as unknown after dispatch', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    let onAuthorizationChange!: () => void
    let executorSignal!: AbortSignal
    let authorizationVersion = 'auth-v1'
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      currentAuthorizationVersion: () => authorizationVersion,
      subscribeAuthorizationChange: (_call, listener) => { onAuthorizationChange = listener; return () => undefined },
      execute: async (_call, signal) => {
        executorSignal = signal
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { output: 'aborted by policy update' }
      }
    })

    const pending = port.execute(call, permitId)
    await vi.waitFor(() => expect(executorSignal).toBeDefined())
    onAuthorizationChange()
    expect(executorSignal.aborted).toBe(false)
    authorizationVersion = 'auth-v2'
    onAuthorizationChange()
    expect(executorSignal.aborted).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(admission.closedOutcomes.get(permitId)).toBe('unknown-after-dispatch')
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })

  it('rechecks the current authorization version immediately after subscribing before permit consumption', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      currentAuthorizationVersion: () => 'auth-v2',
      subscribeAuthorizationChange: () => () => undefined,
      execute
    })

    await expect(port.execute(call, permitId)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED', reason: 'AUTHORIZATION_STALE' })
    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
  })

  it('cleans authorization and revocation subscriptions when the live authorization resolver fails', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    const removeRevocation = vi.fn()
    const removeAuthorization = vi.fn()
    const execute = vi.fn()
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      subscribeRevocation: () => removeRevocation,
      subscribeAuthorizationChange: () => removeAuthorization,
      currentAuthorizationVersion: () => { throw new Error('policy store unavailable') },
      execute
    })

    await expect(port.execute(call, permitId)).rejects.toThrow('policy store unavailable')
    expect(removeRevocation).toHaveBeenCalledOnce()
    expect(removeAuthorization).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
  })

  it('invalidates an active lease when the live authorization resolver fails after claim', async () => {
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permitId = permits.issue(binding, Date.now() + 10_000)
    let onAuthorizationChange!: () => void
    let executorSignal!: AbortSignal
    let resolverFails = false
    const port = createPermitBoundToolExecutionPort({
      permits, admission, resolveExpected: async () => binding,
      subscribeAuthorizationChange: (_call, listener) => { onAuthorizationChange = listener; return () => undefined },
      currentAuthorizationVersion: () => {
        if (resolverFails) throw new Error('policy store unavailable')
        return 'auth-v1'
      },
      execute: async (_call, signal) => {
        executorSignal = signal
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')) , { once: true }))
        return { output: 'unreachable' }
      }
    })

    const pending = port.execute(call, permitId)
    await vi.waitFor(() => expect(executorSignal).toBeDefined())
    const pendingAssertion = expect(pending).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    resolverFails = true
    try { onAuthorizationChange() } catch { /* Runtime registry isolates listener failures after lease invalidation. */ }
    expect(executorSignal.aborted).toBe(true)
    await pendingAssertion
    expect(admission.closedOutcomes.get(permitId)).toBe('unknown-after-dispatch')
    expect(admission.activeLeaseCount(binding.requestId)).toBe(0)
  })
})
