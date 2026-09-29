import type { ExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import type { SafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'

/**
 * Bridges the host's synchronous revocation event into the permit, prepared-record,
 * and dispatch-admission state for one invocation. Admission is invalidated first,
 * so a concurrent beginDispatch loses if this revocation listener runs first.
 */
export function bindToolRevocationToExecution(input: {
  registry: { onRevocation(listener: (event: { requestId: string; lane: string; toolName: string }) => void): () => void }
  permits: SafetyPermitStore
  admission: ExecutionAdmissionCoordinator
  prepared: { invalidate(invocationId: string): void }
  requestId: string
  invocationId: string
  toolName: string
}): () => void {
  return input.registry.onRevocation((event) => {
    if (event.requestId !== input.requestId || event.toolName !== input.toolName) return
    input.admission.invalidate({ requestId: input.requestId, invocationId: input.invocationId }, 'revoked')
    input.permits.invalidateBinding(input.requestId, input.invocationId, 'revoked')
    input.prepared.invalidate(input.invocationId)
  })
}
