import type { PermitBinding } from './safetyPermit'
export type { PermitBinding } from './safetyPermit'

export type ExecutionDispatchLease = {
  markEntered(): void
  close(outcome: 'completed' | 'failed' | 'cancelled' | 'unknown-after-dispatch'): void
}
export type BeginDispatchResult =
  | { ok: true; lease: ExecutionDispatchLease; signal: AbortSignal }
  | { ok: false; reason: 'CANCELLED' | 'REVOKED' | 'AUTHORIZATION_STALE' | 'PERMIT_NOT_CONSUMED' | 'BINDING_MISMATCH' }
export type ExecutionAdmissionCoordinator = {
  /** Record only after SafetyPermitStore.consume returned ok; claim cannot be derived from permit appearance. */
  markPermitConsumed(permitId: string, binding: PermitBinding): void
  beginDispatch(permitId: string, expected: PermitBinding, validatePrepared?: () => boolean | Promise<boolean>): Promise<BeginDispatchResult>
  invalidate(binding: Pick<PermitBinding, 'requestId' | 'invocationId'>, reason: 'cancelled' | 'revoked' | 'authorization-changed'): void
  settle(permitId: string): void
}

type ConsumedPermit = { binding: PermitBinding; claimed: boolean }

/** In-memory linearization reference implementation; invalidate and claim share a synchronous critical section. */
export class InMemoryExecutionAdmissionCoordinator implements ExecutionAdmissionCoordinator {
  private readonly permits = new Map<string, ConsumedPermit>()
  private readonly invalidations = new Map<string, 'CANCELLED' | 'REVOKED' | 'AUTHORIZATION_STALE'>()
  private readonly active = new Map<string, Map<string, Set<AbortController>>>()
  executorEntries = 0
  readonly closedOutcomes = new Map<string, 'completed' | 'failed' | 'cancelled' | 'unknown-after-dispatch'>()

  activeLeaseCount(requestId: string, invocationId?: string): number {
    const invocations = this.active.get(requestId)
    if (!invocations) return 0
    if (invocationId !== undefined) return invocations.get(invocationId)?.size ?? 0
    return [...invocations.values()].reduce((total, leases) => total + leases.size, 0)
  }

  markPermitConsumed(permitId: string, binding: PermitBinding): void {
    const existing = this.permits.get(permitId)
    if (existing) {
      if (!sameBinding(existing.binding, binding)) throw new Error('PERMIT_CONSUMPTION_BINDING_CHANGED')
      // Consume notifications are monotonic: an idempotent duplicate must not reset a claimed permit.
      return
    }
    this.permits.set(permitId, { binding: Object.freeze({ ...binding }), claimed: false })
  }

  async beginDispatch(permitId: string, expected: PermitBinding, validatePrepared?: () => boolean | Promise<boolean>): Promise<BeginDispatchResult> {
    let permit = this.permits.get(permitId)
    if (!permit) return { ok: false, reason: 'PERMIT_NOT_CONSUMED' }
    if (!sameBinding(permit.binding, expected)) return { ok: false, reason: 'BINDING_MISMATCH' }
    const bindingKey = invocationKey(expected.requestId, expected.invocationId)
    const initialInvalidReason = this.invalidations.get(bindingKey)
    if (initialInvalidReason) return { ok: false, reason: initialInvalidReason }
    if (validatePrepared && !(await validatePrepared())) return { ok: false, reason: 'AUTHORIZATION_STALE' }
    // Re-read invalidation and claim state after async trusted-record validation. From here to claim
    // there is no await, so cancel/revoke and dispatch have one synchronous linearization order.
    permit = this.permits.get(permitId)
    if (!permit) return { ok: false, reason: 'PERMIT_NOT_CONSUMED' }
    if (!sameBinding(permit.binding, expected)) return { ok: false, reason: 'BINDING_MISMATCH' }
    const requestKey = expected.requestId
    const invalidReason = this.invalidations.get(bindingKey)
    if (invalidReason) return { ok: false, reason: invalidReason }
    if (permit.claimed) return { ok: false, reason: 'PERMIT_NOT_CONSUMED' }

    // Linearization point: after claimed flips, subsequent invalidation targets this lease.
    permit.claimed = true
    const controller = new AbortController()
    const invocationLeases = this.active.get(requestKey) ?? new Map<string, Set<AbortController>>()
    const leases = invocationLeases.get(expected.invocationId) ?? new Set<AbortController>()
    leases.add(controller)
    invocationLeases.set(expected.invocationId, leases)
    this.active.set(requestKey, invocationLeases)
    let closed = false
    const lease: ExecutionDispatchLease = {
      markEntered: () => { if (!closed) this.executorEntries += 1 },
      close: (outcome) => {
        if (closed) return
        closed = true
        this.closedOutcomes.set(permitId, outcome)
        leases.delete(controller)
        if (leases.size === 0) invocationLeases.delete(expected.invocationId)
        if (invocationLeases.size === 0) this.active.delete(requestKey)
      }
    }
    return { ok: true, lease, signal: controller.signal }
  }

  invalidate(binding: Pick<PermitBinding, 'requestId' | 'invocationId'>, reason: 'cancelled' | 'revoked' | 'authorization-changed'): void {
    const value = reason === 'cancelled' ? 'CANCELLED' : reason === 'revoked' ? 'REVOKED' : 'AUTHORIZATION_STALE'
    this.invalidations.set(invocationKey(binding.requestId, binding.invocationId), value)
    for (const permit of this.permits.values()) {
      if (permit.binding.requestId === binding.requestId && permit.binding.invocationId === binding.invocationId && !permit.claimed) {
        permit.claimed = true
      }
    }
    for (const controller of this.active.get(binding.requestId)?.get(binding.invocationId) ?? []) controller.abort(reason)
  }

  settle(permitId: string): void {
    const permit = this.permits.get(permitId)
    if (!permit) return
    this.permits.delete(permitId)
    const { requestId, invocationId } = permit.binding
    const hasSiblingPermit = [...this.permits.values()].some((entry) => entry.binding.requestId === requestId && entry.binding.invocationId === invocationId)
    const hasActiveLease = (this.active.get(requestId)?.get(invocationId)?.size ?? 0) > 0
    if (!hasSiblingPermit && !hasActiveLease) this.invalidations.delete(invocationKey(requestId, invocationId))
  }
}

function invocationKey(requestId: string, invocationId: string): string { return JSON.stringify([requestId, invocationId]) }

function sameBinding(a: PermitBinding, b: PermitBinding): boolean {
  return Object.keys(a).every((key) => a[key as keyof PermitBinding] === b[key as keyof PermitBinding])
}
