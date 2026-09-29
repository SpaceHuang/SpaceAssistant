import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate, type SafetyPolicyPort } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore, type SafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import type { InvocationHandle, ToolExecutionContext } from './plannedToolRegistry'
import { PreparedInvocationStore } from './preparedInvocationStore'
import { bindToolRevocationToExecution } from './permitRevocationBridge'
import type { CoordinatorHooks } from './toolInvocationCoordinator'
import type { ExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'

function combineSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  for (const signal of signals) {
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else {
      signal.addEventListener('abort', abort, { once: true })
      listeners.push({ signal, listener: abort })
    }
  }
  return {
    signal: controller.signal,
    dispose: () => { for (const item of listeners) item.signal.removeEventListener('abort', item.listener) }
  }
}

/** Host adapter that binds trusted prepared input to a one-shot SDK permit and dispatch lease. */
export function createPermitBoundCoordinatorDispatch(input: {
  requestId: string
  turnId: string
  canonicalInput: unknown
  authorizationVersion: string
  targetVersion: string
  currentAuthorizationVersion?: () => string
  isAllowed: () => boolean
  phase?: 'initial-compat' | 'recheck'
  initialFactsHash?: string
  recheck?: () => Promise<{ allowed: boolean; authorizationVersion: string; targetVersion: string; factsHash: string }>
  toolRevocations: {
    onRevocation(listener: (event: { requestId: string; lane: string; toolName: string }) => void): () => void
    isToolRevoked(requestId: string, toolName: string): boolean
  }
  admission?: ExecutionAdmissionCoordinator
  permits?: SafetyPermitStore
  safetyPolicy: SafetyPolicyPort
}): NonNullable<CoordinatorHooks['dispatch']> {
  return async (handle: InvocationHandle, context: ToolExecutionContext, execute, onDispatchClaimed) => {
    const prepared = handle.prepared
    if (input.phase !== 'recheck') throw new Error('RECHECK_REQUIRED')
    if (!input.isAllowed()) throw new Error('INITIAL_GATE_NOT_ALLOWED')
    const preparedStore = new PreparedInvocationStore()
    const permits = input.permits ?? new InMemorySafetyPermitStore()
    const admission = input.admission ?? new InMemoryExecutionAdmissionCoordinator()
    const capabilities = new CapabilityRegistry()
    capabilities.define(prepared.invocationId, [prepared.toolName])
    const gate = new SafetyGate({
      capabilities,
      permitStore: permits,
      policy: input.safetyPolicy
    })
    preparedStore.put(prepared, {
      turnId: input.turnId,
      canonicalInput: input.canonicalInput,
      inputMappingVersion: `${prepared.toolName}:canonical-input-v1`,
      targetVersion: input.targetVersion,
      factsHash: input.initialFactsHash
    })
    const rechecked = input.phase === 'recheck' ? await input.recheck?.() : undefined
    if (input.phase === 'recheck' && (!rechecked || !rechecked.allowed)) throw new Error('RECHECK_DENIED')
    const authorizationVersion = rechecked?.authorizationVersion ?? input.authorizationVersion
    const targetVersion = rechecked?.targetVersion ?? input.targetVersion
    const expectedContext = {
      invocationId: prepared.invocationId,
      requestId: input.requestId,
      turnId: input.turnId,
      toolCallId: prepared.toolUseId,
      toolName: prepared.toolName,
      canonicalInput: input.canonicalInput,
      targetVersion,
      factsHash: input.initialFactsHash,
      authorizationVersion,
      phase: input.phase === 'recheck' ? 'recheck' as const : 'initial-compat' as const
    }
    let binding = preparedStore.resolveExpected(expectedContext)
    if (rechecked && rechecked.factsHash !== input.initialFactsHash) throw new Error('BINDING_MISMATCH')
    const authorization = await gate.authorize(binding)
    if (authorization.kind !== 'allow') throw new Error(`SAFETY_GATE_${authorization.kind.toUpperCase()}`)
    // The policy port is authoritative for current facts/rule version; rebuild the host expected binding from that decision.
    if (authorization.authorizationVersion !== binding.authorizationVersion) {
      binding = preparedStore.resolveExpected({ ...expectedContext, authorizationVersion: authorization.authorizationVersion })
    }

    let revokedBeforeClaim = false
    const removeRevocationBridge = bindToolRevocationToExecution({
      registry: input.toolRevocations, permits, admission, prepared: preparedStore,
      requestId: input.requestId, invocationId: prepared.invocationId, toolName: prepared.toolName
    })
    const removeRevocationCheck = input.toolRevocations.onRevocation((event) => {
      if (event.requestId === input.requestId && event.toolName === prepared.toolName) revokedBeforeClaim = true
    })
    if (input.toolRevocations.isToolRevoked(input.requestId, prepared.toolName)) revokedBeforeClaim = true
    const onAbort = () => {
      admission.invalidate({ requestId: input.requestId, invocationId: prepared.invocationId }, 'cancelled')
      permits.invalidateBinding(input.requestId, prepared.invocationId, 'cancelled')
      preparedStore.invalidate(prepared.invocationId)
    }
    if (context.signal.aborted) onAbort()
    else context.signal.addEventListener('abort', onAbort, { once: true })

    const toolExecution = createPermitBoundToolExecutionPort({
      permits,
      admission,
      allowedPhase: input.phase === 'recheck' ? 'recheck' : 'initial-compat',
      resolveExpected: async () => preparedStore.resolveExpected(expectedContext),
      validatePrepared: () => !revokedBeforeClaim && input.isAllowed() && (input.currentAuthorizationVersion?.() ?? input.authorizationVersion) === binding.authorizationVersion && preparedStore.validateExpected(expectedContext, binding),
      execute: async (_call, leaseSignal) => {
        const combined = combineSignals([context.signal, leaseSignal])
        try { return await execute(combined.signal) }
        finally { combined.dispose() }
      }
    })

    try {
      return await toolExecution.execute({
        invocationId: prepared.invocationId,
        toolCallId: prepared.toolUseId,
        toolName: prepared.toolName
      }, authorization.permitId, onDispatchClaimed)
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      removeRevocationCheck()
      removeRevocationBridge()
      preparedStore.settle(prepared.invocationId)
    }
  }
}
