import type { ExecutionAdmissionCoordinator } from './executionAdmission'
import type { PermitBinding, PermitConsumeResult, SafetyPermitStore } from './safetyPermit'

export type PermitBoundToolCall = Readonly<{ invocationId: string; toolCallId: string; toolName: string; signal?: AbortSignal }>
const permitBoundToolExecutionPortBrand: unique symbol = Symbol('PermitBoundToolExecutionPort')
export type PermitBoundToolExecutionPort<TCall extends PermitBoundToolCall, TResult> = Readonly<{
  [permitBoundToolExecutionPortBrand]: true
  execute(call: TCall, permitId: string, onDispatchClaimed?: (cancel: () => void) => void | Promise<void>): Promise<TResult>
}>
export type ToolExecutionRejectReason =
  | Extract<PermitConsumeResult, { ok: false }>['reason']
  | 'REVOKED'
  | 'PERMIT_NOT_CONSUMED'

export class ToolExecutionRejectedError extends Error {
  readonly code = 'TOOL_EXECUTION_REJECTED'
  constructor(readonly reason: ToolExecutionRejectReason) { super(`tool execution rejected: ${reason}`); this.name = 'ToolExecutionRejectedError' }
}

/** The executor was entered, so a thrown error cannot prove that no side effect occurred. */
export class ToolExecutionAfterDispatchError extends Error {
  readonly code = 'TOOL_EXECUTION_UNKNOWN_AFTER_DISPATCH'
  constructor(readonly originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError)
    super(`tool execution failed after dispatch: ${detail}`)
    this.name = 'ToolExecutionAfterDispatchError'
  }
}

/**
 * Wrap a host executor with the consume → dispatch-claim barrier.
 * resolveExpected must read the host-private prepared record and current invocation context;
 * it must not derive expected values from the permit ID or public permit fields.
 * The execute callback must map the same prepared record to the actual builtin/MCP input.
 */
export function createPermitBoundToolExecutionPort<TCall extends PermitBoundToolCall, TResult>(deps: {
  permits: SafetyPermitStore
  admission: ExecutionAdmissionCoordinator
  /** V1 hosts must explicitly opt into initial-compat until their lane is upgraded to recheck. */
  allowedPhase?: PermitBinding['phase']
  resolveExpected(call: TCall): Promise<PermitBinding>
  validatePrepared?(call: TCall, expected: PermitBinding): boolean | Promise<boolean>
  /** Distinguish a capability revoked before dispatch-listener registration from stale host binding. */
  isRevoked?(call: TCall): boolean
  /** Subscribe before permit consumption so host revocation invalidates queued work and aborts active leases. */
  subscribeRevocation?(call: TCall, onRevocation: () => void): () => void
  /** Subscribe before permit consumption so policy changes invalidate queued work and abort active leases. */
  subscribeAuthorizationChange?(call: TCall, onChange: () => void): () => void
  currentAuthorizationVersion?(call: TCall): string | undefined
  execute(call: TCall, signal: AbortSignal): Promise<TResult>
}): PermitBoundToolExecutionPort<TCall, TResult> {
  return {
    [permitBoundToolExecutionPortBrand]: true as const,
    async execute(call, permitId, onDispatchClaimed) {
      const expected = await deps.resolveExpected(call)
      if (expected.invocationId !== call.invocationId || expected.toolCallId !== call.toolCallId || expected.capabilityId !== call.toolName || expected.phase !== (deps.allowedPhase ?? 'recheck')) {
        throw new ToolExecutionRejectedError('BINDING_MISMATCH')
      }
      const onAbort = () => {
        deps.permits.invalidateBinding(expected.requestId, expected.invocationId, 'cancelled')
        deps.admission.invalidate(expected, 'cancelled')
      }
      let removeRevocationListener: () => void = () => undefined
      let removeAuthorizationListener: () => void = () => undefined
      let authorizationStale = false
      const invalidateAuthorization = () => {
        authorizationStale = true
        deps.permits.invalidateBinding(expected.requestId, expected.invocationId, 'authorization-changed')
        deps.admission.invalidate(expected, 'authorization-changed')
      }
      const invalidateAuthorizationIfChanged = () => {
        if (!deps.currentAuthorizationVersion) return
        let current: string | undefined
        try { current = deps.currentAuthorizationVersion(call) }
        catch (error) {
          invalidateAuthorization()
          throw error
        }
        if (current === expected.authorizationVersion) return
        invalidateAuthorization()
        if (current === undefined) throw new Error('CURRENT_AUTHORIZATION_VERSION_UNAVAILABLE')
      }
      try {
        removeRevocationListener = deps.subscribeRevocation?.(call, () => {
          deps.permits.invalidateBinding(expected.requestId, expected.invocationId, 'revoked')
          deps.admission.invalidate(expected, 'revoked')
        }) ?? (() => undefined)
        removeAuthorizationListener = deps.subscribeAuthorizationChange?.(call, invalidateAuthorizationIfChanged) ?? (() => undefined)
        if (deps.isRevoked?.(call)) throw new ToolExecutionRejectedError('REVOKED')
        invalidateAuthorizationIfChanged()
        if (call.signal?.aborted) onAbort()
        else call.signal?.addEventListener('abort', onAbort, { once: true })
        const consumed = await deps.permits.consume(permitId, expected)
        if (!consumed.ok) throw new ToolExecutionRejectedError(consumed.reason)
        deps.admission.markPermitConsumed(permitId, expected)
        const dispatch = await deps.admission.beginDispatch(permitId, expected, async () =>
          !authorizationStale && (deps.validatePrepared ? await deps.validatePrepared(call, expected) : true)
        )
        if (!dispatch.ok) throw new ToolExecutionRejectedError(dispatch.reason)

        try {
        await onDispatchClaimed?.(() => deps.admission.invalidate(expected, 'cancelled'))
        } catch (error) {
          dispatch.lease.close('failed')
          throw error
        }

        dispatch.lease.markEntered()
        let outcome: 'completed' | 'failed' | 'cancelled' | 'unknown-after-dispatch' = 'unknown-after-dispatch'
        try {
          const result = await deps.execute(call, dispatch.signal)
          if (dispatch.signal.aborted) throw new Error('Execution lease aborted before acknowledgement')
          outcome = 'completed'
          return result
        } catch (error) {
          outcome = dispatch.signal.aborted ? 'unknown-after-dispatch' : 'failed'
          // Once the executor has entered, an exception cannot prove that its side effect did not happen.
          // Preserve the uncertain outcome even when cancellation/revocation also aborted the lease.
          throw new ToolExecutionAfterDispatchError(error)
        } finally {
          dispatch.lease.close(outcome)
        }
      } finally {
        call.signal?.removeEventListener('abort', onAbort)
        removeRevocationListener()
        removeAuthorizationListener()
        deps.admission.settle(permitId)
        deps.permits.settle(permitId)
      }
    }
  }
}
