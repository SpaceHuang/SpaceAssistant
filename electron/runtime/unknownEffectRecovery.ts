import { createHash } from 'node:crypto'
import type { HistoryPort, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { createSessionCommitService } from '../sessionStorage/host/sessionCommitService'

export type UnknownEffectRecoveryState = Readonly<{
  targetInvocationId: string
  mode: 'clear' | 'verify-only' | 'risk-accepted'
  unresolvedEffects: readonly Readonly<{ id: string; originInvocationId: string; toolCallId: string; toolName?: string; inputHash?: string }>[]
  verification: 'not-needed' | 'unavailable'
  checkerAvailable: boolean
  reason?: 'NO_REVIEWED_READ_ONLY_CAPABILITY'
}>

export function createUnknownEffectBeforeDispatchLease(history: HistoryPort): NonNullable<import('../../packages/agent-sdk/src/turn').AgentTurnPorts['beforeDispatchLease']> {
  return async (call) => {
    const snapshot = await history.read(call.invocationId)
    const state = readUnknownEffectRecoveryState(snapshot, new Set(), { includeUnsettledStarted: false })
    if (state.mode === 'risk-accepted') return { kind: 'dispatch' }
    if (state.mode === 'verify-only') {
      const inputHash = createHash('sha256').update(JSON.stringify(call.input)).digest('hex')
      const approvalEventId = await findOneTimeUnknownEffectRetryApproval({ history, targetInvocationId: call.invocationId, toolName: call.toolName, inputHash })
      if (approvalEventId) return { kind: 'dispatch', retryApprovalEventId: approvalEventId }
      const reasonCode = state.checkerAvailable ? 'VERIFY_ONLY_UNREVIEWED_CAPABILITY' : 'RECOVERY_CHECKER_UNAVAILABLE'
      return { kind: 'reject', reasonCode, message: state.checkerAvailable
        ? 'A prior operation is still unresolved. This tool is not approved for read-only recovery checks, so it was not dispatched.'
        : 'A prior operation is still unresolved and no reviewed read-only checker is available. No tool was dispatched.' }
    }
    return { kind: 'dispatch' }
  }
}

/** Recovery policy is derived only from canonical context fields and reviewed code capability IDs. */
export function readUnknownEffectRecoveryState(
  snapshot: HistorySnapshot,
  reviewedReadOnlyToolNames: ReadonlySet<string> = new Set(),
  options: Readonly<{ includeUnsettledStarted?: boolean }> = {}
): UnknownEffectRecoveryState {
  const context = snapshot.events.find((event) => event.kind === 'invocation-context-committed')?.payload
  const effects = context && typeof context === 'object' && !Array.isArray(context)
    ? (context as { unresolvedEffects?: unknown }).unresolvedEffects : undefined
  const inheritedEffects = Array.isArray(effects) ? effects.filter((effect): effect is UnknownEffectRecoveryState['unresolvedEffects'][number] =>
    Boolean(effect && typeof effect === 'object' && !Array.isArray(effect) && typeof (effect as { id?: unknown }).id === 'string' &&
      typeof (effect as { originInvocationId?: unknown }).originInvocationId === 'string' && typeof (effect as { toolCallId?: unknown }).toolCallId === 'string')) : []
  const started = new Map<string, Record<string, unknown>>()
  const settled = new Set<string>()
  const explicitUnknown = new Set<string>()
  for (const event of snapshot.events) {
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) continue
    const payload = event.payload as Record<string, unknown>
    if (event.kind === 'tool-call-started' && typeof payload.toolCallId === 'string') started.set(payload.toolCallId, payload)
    if (event.kind === 'tool-call-finished' && payload.executionOutcome === 'unknown-after-dispatch' && typeof payload.toolCallId === 'string') explicitUnknown.add(payload.toolCallId)
    if (((event.kind === 'tool-call-finished' && payload.executionOutcome !== 'unknown-after-dispatch') || event.kind === 'tool-call-not-dispatched' || event.kind === 'tool-call-deferred') && typeof payload.toolCallId === 'string') settled.add(payload.toolCallId)
  }
  const localUnknown = [...started].filter(([toolCallId]) => explicitUnknown.has(toolCallId) || (!settled.has(toolCallId) && options.includeUnsettledStarted !== false)).map(([toolCallId, payload]) => ({
    id: `${snapshot.invocationId}:${toolCallId}`, originInvocationId: snapshot.invocationId, toolCallId,
    ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}), ...(typeof payload.inputHash === 'string' ? { inputHash: payload.inputHash } : {})
  }))
  const unresolvedEffects = [...new Map([...inheritedEffects, ...localUnknown].map((effect) => [effect.id, effect])).values()]
  if (!unresolvedEffects.length) return { targetInvocationId: snapshot.invocationId, mode: 'clear', unresolvedEffects: [], verification: 'not-needed', checkerAvailable: false }
  const riskAcceptance = [...snapshot.events].reverse().find((event) => event.kind === 'unknown-effect-risk-accepted')?.payload as { targetInvocationId?: unknown; unresolvedEffectIds?: unknown } | undefined
  if (riskAcceptance?.targetInvocationId === snapshot.invocationId && Array.isArray(riskAcceptance.unresolvedEffectIds) &&
    isUnknownEffectDecisionCurrent({ targetInvocationId: snapshot.invocationId, mode: 'verify-only', unresolvedEffects, verification: 'unavailable', checkerAvailable: false }, snapshot.invocationId, riskAcceptance.unresolvedEffectIds as string[])) {
    return { targetInvocationId: snapshot.invocationId, mode: 'risk-accepted', unresolvedEffects, verification: 'unavailable', checkerAvailable: false }
  }
  const hasApplicableChecker = unresolvedEffects.some((effect) => effect.toolName && reviewedReadOnlyToolNames.has(effect.toolName))
  return { targetInvocationId: snapshot.invocationId, mode: 'verify-only', unresolvedEffects, verification: 'unavailable', checkerAvailable: hasApplicableChecker, reason: 'NO_REVIEWED_READ_ONLY_CAPABILITY' }
}

export function isUnknownEffectDecisionCurrent(state: UnknownEffectRecoveryState, invocationId: string, acceptedIds: readonly string[]): boolean {
  if ((state.mode !== 'verify-only' && state.mode !== 'risk-accepted') || !invocationId.trim() || invocationId !== state.targetInvocationId || !state.unresolvedEffects.length) return false
  const expected = [...new Set(state.unresolvedEffects.map(({ id }) => id))].sort()
  const accepted = [...new Set(acceptedIds)].sort()
  return expected.length === accepted.length && expected.every((id, index) => id === accepted[index])
}

export async function recordUnknownEffectRiskAcceptance(input: { history: HistoryPort; sessionId: string; targetInvocationId: string; acceptedIds: readonly string[]; now?: number }): Promise<void> {
  const snapshot = await input.history.read(input.targetInvocationId)
  const state = readUnknownEffectRecoveryState(snapshot)
  if (!isUnknownEffectDecisionCurrent(state, input.targetInvocationId, input.acceptedIds)) throw new Error('UNKNOWN_EFFECT_DECISION_STALE_OR_INCOMPLETE')
  const turnId = snapshot.events[0]?.turnId ?? input.targetInvocationId
  const sequence = snapshot.version + 1
  const commitService = createSessionCommitService({ sessionId: input.sessionId, invocationId: input.targetInvocationId, turnId, history: input.history })
  await commitService.commitHistory([{
    invocationId: input.targetInvocationId, turnId, sequence,
    schemaVersion: snapshot.schemaVersion, eventId: `${input.targetInvocationId}:unknown-risk:${sequence}`,
    idempotencyKey: `${input.targetInvocationId}:unknown-risk:${sequence}`, kind: 'unknown-effect-risk-accepted',
    payload: { targetInvocationId: input.targetInvocationId, unresolvedEffectIds: [...new Set(input.acceptedIds)].sort(), acceptedAt: input.now ?? Date.now() }
  }], snapshot.version)
}

export async function approveOneTimeUnknownEffectRetry(input: { history: HistoryPort; sessionId: string; targetInvocationId: string; unknownEffectId: string; now?: number }): Promise<void> {
  const snapshot = await input.history.read(input.targetInvocationId)
  const state = readUnknownEffectRecoveryState(snapshot)
  const effect = state.unresolvedEffects.find(({ id }) => id === input.unknownEffectId)
  if (state.mode !== 'verify-only' || !effect?.toolName || !effect.inputHash) throw new Error('UNKNOWN_EFFECT_RETRY_UNAVAILABLE')
  const turnId = snapshot.events[0]?.turnId ?? input.targetInvocationId
  const sequence = snapshot.version + 1
  const commitService = createSessionCommitService({ sessionId: input.sessionId, invocationId: input.targetInvocationId, turnId, history: input.history })
  await commitService.commitHistory([{
    invocationId: input.targetInvocationId, turnId, sequence,
    schemaVersion: snapshot.schemaVersion, eventId: `${input.targetInvocationId}:unknown-retry-approved:${sequence}`,
    idempotencyKey: `${input.targetInvocationId}:unknown-retry-approved:${sequence}`, kind: 'unknown-effect-retry-approved',
    payload: { targetInvocationId: input.targetInvocationId, unknownEffectId: effect.id, toolName: effect.toolName, inputHash: effect.inputHash, approvedAt: input.now ?? Date.now() }
  }], snapshot.version)
}

export async function findOneTimeUnknownEffectRetryApproval(input: { history: HistoryPort; targetInvocationId: string; toolName: string; inputHash: string }): Promise<string | undefined> {
  const snapshot = await input.history.read(input.targetInvocationId)
  const state = readUnknownEffectRecoveryState(snapshot)
  if (state.mode !== 'verify-only') return undefined
  const consumed = new Set(snapshot.events.filter((event) => event.kind === 'unknown-effect-retry-consumed')
    .map((event) => (event.payload as { approvalEventId?: unknown }).approvalEventId).filter((id): id is string => typeof id === 'string'))
  const approval = [...snapshot.events].reverse().find((event) => {
    if (event.kind !== 'unknown-effect-retry-approved' || consumed.has(event.eventId)) return false
    const payload = event.payload as { targetInvocationId?: unknown; unknownEffectId?: unknown; toolName?: unknown; inputHash?: unknown }
    return payload.targetInvocationId === input.targetInvocationId && state.unresolvedEffects.some(({ id }) => id === payload.unknownEffectId) && payload.toolName === input.toolName && payload.inputHash === input.inputHash
  })
  return approval?.eventId
}

export async function hasPendingUnknownEffectRetryApproval(history: HistoryPort, targetInvocationId: string): Promise<boolean> {
  const snapshot = await history.read(targetInvocationId)
  const state = readUnknownEffectRecoveryState(snapshot)
  if (state.mode !== 'verify-only') return false
  const consumed = new Set(snapshot.events.filter((event) => event.kind === 'unknown-effect-retry-consumed')
    .map((event) => (event.payload as { approvalEventId?: unknown }).approvalEventId).filter((id): id is string => typeof id === 'string'))
  return snapshot.events.some((event) => {
    if (event.kind !== 'unknown-effect-retry-approved' || consumed.has(event.eventId)) return false
    const payload = event.payload as { targetInvocationId?: unknown; unknownEffectId?: unknown; toolName?: unknown; inputHash?: unknown }
    return payload.targetInvocationId === targetInvocationId && state.unresolvedEffects.some((effect) =>
      effect.id === payload.unknownEffectId && effect.toolName === payload.toolName && effect.inputHash === payload.inputHash)
  })
}
