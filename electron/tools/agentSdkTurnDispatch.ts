import { createHash } from 'node:crypto'
import { createAgentSdkRecheckPort } from '../confirmation/agentSdkSafetyPolicy'
import type { ToolCallGateResult } from '../confirmation/toolCallGate'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import type { CoordinatorHooks } from './toolInvocationCoordinator'

type PermitDispatchInput = Parameters<typeof createPermitBoundCoordinatorDispatch>[0]

/** Build the shared recheck → SDK permit → admission claim adapter for a planned tool call. */
export function createAgentSdkTurnDispatch(input: Omit<PermitDispatchInput, 'phase' | 'initialFactsHash' | 'recheck' | 'safetyPolicy'> & {
  initialRuleId: string
  initialFacts: unknown
  previouslyConfirmed: boolean
  resolveAuthorizationVersion(): string | undefined
  isRevoked(): boolean
  evaluate(): Promise<ToolCallGateResult>
}): NonNullable<CoordinatorHooks['dispatch']> {
  const initialFactsHash = createHash('sha256').update(JSON.stringify(input.initialFacts)).digest('hex')
  const recheck = createAgentSdkRecheckPort({
    initialRuleId: input.initialRuleId,
    initialFacts: input.initialFacts,
    previouslyConfirmed: input.previouslyConfirmed,
    resolveAuthorizationVersion: input.resolveAuthorizationVersion,
    isRevoked: input.isRevoked,
    evaluate: input.evaluate
  })
  return createPermitBoundCoordinatorDispatch({
    requestId: input.requestId,
    turnId: input.turnId,
    canonicalInput: input.canonicalInput,
    authorizationVersion: input.authorizationVersion,
    currentAuthorizationVersion: input.currentAuthorizationVersion,
    targetVersion: input.targetVersion,
    isAllowed: input.isAllowed,
    phase: 'recheck',
    initialFactsHash,
    recheck: recheck.recheck,
    safetyPolicy: recheck.safetyPolicy,
    toolRevocations: input.toolRevocations,
    admission: input.admission,
    permits: input.permits
  })
}
