import { createHash } from 'node:crypto'
import { createPermitBoundToolExecutionPort, ToolExecutionRejectedError } from '../../packages/agent-sdk/src/toolExecutionPort'
import type { ExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import type { PermitBinding, SafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import type { ToolPreparationStage } from '../../packages/agent-sdk/src/turn'
import type { AgentToolRevocationPort } from '../../packages/agent-sdk/src/invocation'
import type { RegisteredTool, ToolExecutionContext } from './plannedToolRegistry'
import { resolveRegisteredToolName } from './registeredToolName'
import { projectAgentToolResult, serializeAgentToolResult } from '../../src/shared/agentToolResult'
import { isProcessToolName } from '../../src/shared/processResultProjection'
import { compactOversizedToolResultContent } from '../../src/shared/oversizedToolResult'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { validateToolExecutorResultForTool, validateToolExecutorResultWithViolations } from './types'
import { isExecutionOutcomeUncertainError } from './toolExecutionResource'

export type ExecutorUnhandledSettlement = { rethrow: true; error: unknown }

/** A deferred call was rejected before the executor dispatch claim, so no tool side effect started. */
export class DeferredToolPreDispatchError extends Error {
  readonly failureCode: string
  readonly failureType: string
  readonly failureSite: string

  constructor(cause: unknown) {
    super('DEFERRED_TOOL_PRE_DISPATCH_REJECTED', { cause })
    this.name = 'DeferredToolPreDispatchError'
    const chain: unknown[] = []
    let current: unknown = cause
    for (let depth = 0; depth < 5 && current && !chain.includes(current); depth += 1) {
      chain.push(current)
      current = typeof current === 'object' && current !== null && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined
    }
    const stableToken = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,95}$/.test(value) ? value : undefined
    const diagnostic = chain.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      const message = item instanceof Error ? item.message : ''
      const suffix = message.match(/(?:^|:)([A-Z][A-Z0-9_:-]{0,95})$/)?.[1]
      return [stableToken(record.reasonCode), stableToken(record.reason), stableToken(record.code), stableToken(suffix)].filter((value): value is string => Boolean(value))
    })[0]
    const root = chain[0]
    const rootName = root instanceof Error ? root.name : root && typeof root === 'object' && typeof (root as { name?: unknown }).name === 'string' ? (root as { name: string }).name : ''
    this.failureType = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rootName) ? rootName : typeof root
    this.failureCode = diagnostic ?? 'UNKNOWN_PRE_DISPATCH_FAILURE'
    const stack = root instanceof Error ? root.stack ?? '' : ''
    const site = stack.match(/((?:electron|packages)\/[A-Za-z0-9_.\/-]+:\d+:\d+)/)?.[1]
    this.failureSite = site ?? 'UNKNOWN_FAILURE_SITE'
  }
}

/** 执行器 entry 后的异常由 SDK 统一结算为 unknown，不按工具分类降级或重试。 */
export function settleExecutorUnhandledError(error: unknown): ExecutorUnhandledSettlement {
  if (isExecutionOutcomeUncertainError(error)) return { rethrow: true, error }
  return { rethrow: true, error }
}

type TurnToolCall = Readonly<{
  invocationId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  signal?: AbortSignal
}>
type TurnToolResult = Readonly<{ output: unknown; auditOutput?: unknown; replayContent?: unknown; isError?: boolean }>
type PreparedRecord = {
  call: TurnToolCall
  registeredTool: RegisteredTool
  handle: Awaited<ReturnType<RegisteredTool['begin']>>
  runtimeContext: unknown
  signal: AbortSignal
  disposeSignal(): void
  unregisterActiveCancellation?: () => void
  binding: PermitBinding
  userConfirmationReceipt?: string
  userConfirmationAnswerer?: 'user' | 'agent'
  cleaned?: boolean
}

/** Adapt the host's private RegisteredTool plans to the SDK's prepare and permit-bound execute ports. */
export function createRegisteredAgentTurnTools(input: {
  requestId: string
  turnId: string
  registry: { get(name: string): RegisteredTool | undefined; entries?(): readonly Readonly<{ name: string }>[] }
  permits: SafetyPermitStore
  admission: ExecutionAdmissionCoordinator
  createExecutionContext(call: TurnToolCall): unknown
  /** Resolve volatile invocation context again after confirmation and before fresh plan validation. */
  refreshExecutionContext?(call: TurnToolCall, stage: Extract<ToolPreparationStage, { kind: 'recheck' }>, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
  resolveAuthorizationVersion(call: TurnToolCall, stage: ToolPreparationStage): Promise<string> | string
  /** Subscribe to host policy changes while this invocation owns a prepared tool or dispatch lease. */
  subscribeAuthorizationChanges?(call: TurnToolCall, listener: () => void): () => void
  /** Read latest host policy version synchronously to close subscribe/claim races. */
  currentAuthorizationVersion?(call: TurnToolCall): string | undefined
  /** Maps provider-visible compatibility names back to one registered internal capability. */
  resolveRegisteredToolName?(providerToolName: string): string
  workspaceRoot?: string
  /** Resolve the currently authorized workspace after execution (workDir may change within one session). */
  resolveWorkspaceRoot?(): string | undefined
  toolRevocations?: AgentToolRevocationPort
  isRevoked?(call: TurnToolCall): boolean
  subscribeRevocation?(call: TurnToolCall, onRevocation: () => void): () => void
  mapExecutionResult?(result: unknown, call: TurnToolCall): TurnToolResult
  /** Expose the active SDK dispatch lease to the desktop's exact-identity cancel IPC. */
  registerActiveCancellation?(call: TurnToolCall, cancel: () => void): void | (() => void) | Promise<void | (() => void)>
}): {
  prepareTool(call: TurnToolCall, stage: ToolPreparationStage): Promise<PermitBinding>
  discardPreparedTool(call: TurnToolCall): void
  getPreparedCall(identity: Pick<TurnToolCall, 'invocationId' | 'toolCallId'>): TurnToolCall | undefined
  getPreparedFacts(identity: Pick<TurnToolCall, 'invocationId' | 'toolCallId'>): unknown
  getPolicyDecisionMetadata(identity: Pick<TurnToolCall, 'invocationId' | 'toolCallId'>): { ruleId: string; factsHash: string } | undefined
  updateExecutionContext(call: TurnToolCall, update: (context: Record<string, unknown>) => void): void
  toolExecution: ReturnType<typeof createPermitBoundToolExecutionPort<TurnToolCall, TurnToolResult>>
  executeDeferred(call: TurnToolCall, input: {
    confirmationReceipt: string
    confirmationPolicyRevision?: string
    authorizeInitial?(initial: PermitBinding): Promise<{ kind: 'allow' } | { kind: 'deny'; reasonCode?: string }>
    authorize(initial: PermitBinding, recheck: PermitBinding): Promise<{ kind: 'allow'; permitId: string } | { kind: 'deny'; reasonCode?: string }>
  }): Promise<TurnToolResult>
  toolResourceKeys(call: TurnToolCall): readonly string[] | undefined
  isApprovalCandidate(call: TurnToolCall): boolean
} {
  const prepared = new Map<string, PreparedRecord>()
  const keyFor = (call: TurnToolCall) => JSON.stringify([call.invocationId, call.toolCallId])
  const cleanupPrepared = (record: PreparedRecord): void => {
    if (record.cleaned) return
    record.cleaned = true
    if (record.handle.state !== 'settled' && record.handle.state !== 'failed') record.handle.fail()
    record.handle.release()
    record.unregisterActiveCancellation?.()
    record.disposeSignal()
    const key = keyFor(record.call)
    if (prepared.get(key) === record) prepared.delete(key)
  }
  const isRevoked = (call: TurnToolCall) => input.isRevoked?.(call) ?? input.toolRevocations?.isToolRevoked(input.requestId, call.toolName, input.turnId) ?? false
  const subscribeRevocation = input.subscribeRevocation ?? (input.toolRevocations
    ? (call: TurnToolCall, listener: () => void) => input.toolRevocations!.onRevocation((event) => {
        if (event.requestId === input.requestId && event.executionId === input.turnId && event.toolName === call.toolName) listener()
      })
    : undefined)

  const prepareTool = async (call: TurnToolCall, stage: ToolPreparationStage): Promise<PermitBinding> => {
    if (call.invocationId.trim() === '' || call.toolCallId.trim() === '' || call.toolName.trim() === '') throw new Error('PREPARED_CALL_IDENTITY_REQUIRED')
    const key = keyFor(call)
    if (stage.kind === 'initial') {
      if (prepared.has(key)) throw new Error('PREPARED_CALL_ALREADY_EXISTS')
      const registeredToolName = input.resolveRegisteredToolName?.(call.toolName) ?? resolveRegisteredToolName(call.toolName, input.registry)
      const registeredTool = input.registry.get(registeredToolName)
      if (!registeredTool) throw new Error(`REGISTERED_TOOL_NOT_FOUND:${call.toolName}`)
      const cancelController = new AbortController()
      const combined = combineSignals(call.signal ?? new AbortController().signal, cancelController.signal)
      let unregisterActiveCancellation: void | (() => void) = undefined
      let handle: Awaited<ReturnType<RegisteredTool['begin']>> | undefined
      try {
        unregisterActiveCancellation = await input.registerActiveCancellation?.(call, () => cancelController.abort('tool-cancelled'))
        const runtimeContext = input.createExecutionContext(call)
        const planningContext = {
          requestId: input.requestId,
          toolUseId: call.toolCallId,
          signal: combined.signal,
          executionContext: runtimeContext as ToolExecutionContext['runtimeContext']
        } as Parameters<RegisteredTool['beginPlanning']>[1] & { signal: AbortSignal }
        const planning = registeredTool.beginPlanning(call.input, planningContext)
        handle = await planning.result
        if (combined.signal.aborted) throw new Error('REQUEST_CANCELLED')
        if (handle.prepared.requestId !== input.requestId || handle.prepared.toolUseId !== call.toolCallId || handle.prepared.toolName !== registeredTool.name) {
          throw new Error('PREPARED_TOOL_IDENTITY_MISMATCH')
        }
        const binding = await createBinding(input, call, handle, stage)
        prepared.set(key, { call: snapshotCall(call), registeredTool, handle, runtimeContext, signal: combined.signal, disposeSignal: combined.dispose,
          ...(unregisterActiveCancellation ? { unregisterActiveCancellation } : {}), binding })
        return binding
      } catch (error) {
        if (handle) {
          if (handle.state !== 'settled' && handle.state !== 'failed') handle.fail()
          handle.release()
        }
        unregisterActiveCancellation?.()
        combined.dispose()
        throw error
      }
    }

    const record = prepared.get(key)
    if (!record || !sameCall(record.call, call)) throw new Error('PREPARED_CALL_MISMATCH')
    if (stage.confirmation && !stage.confirmation.receipt.trim()) throw new Error('CONFIRMATION_RECEIPT_REQUIRED')
    record.userConfirmationReceipt = stage.confirmation?.receipt
    record.userConfirmationAnswerer = stage.confirmation?.answerer
    try {
      if (input.refreshExecutionContext) {
        const currentContext = record.runtimeContext
        if (!isRecord(currentContext)) throw new Error('PREPARED_EXECUTION_CONTEXT_NOT_REFRESHABLE')
        const safetyOwned = Object.fromEntries(['readExecutionPermit', 'writeExecutionPermit', 'decisionRuleId', 'autoApprovedWrite', 'expectedScriptEnvironmentDigest', 'expectedScriptSettingsDigest', 'expectedScriptNetworkReviewCandidate'].flatMap((key) =>
          Object.prototype.hasOwnProperty.call(currentContext, key) ? [[key, currentContext[key]]] : []
        ))
        const refreshed = await input.refreshExecutionContext(call, stage, currentContext)
        if (!isRecord(refreshed)) throw new Error('REFRESHED_EXECUTION_CONTEXT_INVALID')
        record.runtimeContext = { ...refreshed, ...safetyOwned }
      }
      if (stage.replanAfterFreshApproval) {
        if (!stage.policyChanged && !stage.confirmation?.receipt.trim()) throw new Error('FRESH_APPROVAL_REQUIRED_FOR_REPLAN')
        const planningContext = {
          requestId: input.requestId,
          toolUseId: call.toolCallId,
          signal: record.signal,
          executionContext: record.runtimeContext as ToolExecutionContext['runtimeContext']
        } as Parameters<RegisteredTool['beginPlanning']>[1] & { signal: AbortSignal }
        const planning = record.registeredTool.beginPlanning(call.input, planningContext)
        const replannedHandle = await planning.result
        if (record.signal.aborted) {
          replannedHandle.fail()
          replannedHandle.release()
          throw new Error('REQUEST_CANCELLED')
        }
        if (replannedHandle.prepared.requestId !== input.requestId || replannedHandle.prepared.toolUseId !== call.toolCallId || replannedHandle.prepared.toolName !== record.registeredTool.name) {
          replannedHandle.fail()
          replannedHandle.release()
          throw new Error('PREPARED_TOOL_IDENTITY_MISMATCH')
        }
        const supersededHandle = record.handle
        record.handle = replannedHandle
        if (supersededHandle.state !== 'settled' && supersededHandle.state !== 'failed') supersededHandle.fail()
        supersededHandle.release()
      }
      if (record.handle.state === 'planned') record.handle.awaitConfirmation()
      if (record.handle.state === 'awaiting-confirm') record.handle.confirm()
      else if (record.handle.state !== 'confirmed') throw new Error('PREPARED_TOOL_NOT_AWAITING_CONFIRMATION')
      record.handle.beginValidation()
      await record.handle.validatePrepared(executionContextFor(record, call.signal ?? record.signal))
      record.handle.finishValidation()
      const binding = await createBinding(input, call, record.handle, stage)
      record.binding = binding
      return binding
    } catch (error) {
      cleanupPrepared(record)
      throw error
    }
  }

  const discardPreparedTool = (call: TurnToolCall): void => {
    const key = keyFor(call)
    const record = prepared.get(key)
    if (!record || !sameCall(record.call, call)) return
    cleanupPrepared(record)
  }

  const getPreparedCall = (identity: Pick<TurnToolCall, 'invocationId' | 'toolCallId'>): TurnToolCall | undefined => {
    const record = prepared.get(JSON.stringify([identity.invocationId, identity.toolCallId]))
    return record ? snapshotCall(record.call) : undefined
  }

  const getPreparedFacts = (identity: Pick<TurnToolCall, 'invocationId' | 'toolCallId'>): unknown => {
    const record = prepared.get(JSON.stringify([identity.invocationId, identity.toolCallId]))
    return record ? record.registeredTool.getPreparedFacts?.(record.handle.prepared) : undefined
  }

  const getPolicyDecisionMetadata = (identity: Pick<TurnToolCall, 'invocationId' | 'toolCallId'>) => {
    const record = prepared.get(JSON.stringify([identity.invocationId, identity.toolCallId]))
    const context = record?.runtimeContext
    if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined
    const value = context as Record<string, unknown>
    return typeof value.decisionRuleId === 'string' && typeof value.policyFactsHash === 'string'
      ? { ruleId: value.decisionRuleId, factsHash: value.policyFactsHash } : undefined
  }

  const updateExecutionContext = (call: TurnToolCall, update: (context: Record<string, unknown>) => void): void => {
    const record = prepared.get(keyFor(call))
    const resolveName = input.resolveRegisteredToolName ?? ((name: string) => resolveRegisteredToolName(name, input.registry))
    if (!record || !sameCall(record.call, call) && !(
      record.call.invocationId === call.invocationId && record.call.toolCallId === call.toolCallId &&
      resolveName(record.call.toolName) === resolveName(call.toolName) && stableSerialize(record.call.input) === stableSerialize(call.input)
    )) throw new Error('PREPARED_CALL_MISMATCH')
    if (!record.runtimeContext || typeof record.runtimeContext !== 'object' || Array.isArray(record.runtimeContext)) {
      throw new Error('PREPARED_EXECUTION_CONTEXT_NOT_MUTABLE')
    }
    update(record.runtimeContext as Record<string, unknown>)
  }

  const permitBoundExecution = createPermitBoundToolExecutionPort<TurnToolCall, TurnToolResult>({
    permits: input.permits,
    admission: input.admission,
    allowedPhase: 'recheck',
    ...(subscribeRevocation ? { subscribeRevocation: (call: TurnToolCall, onRevocation: () => void) => subscribeRevocation(call, onRevocation) } : {}),
    isRevoked,
    ...(input.subscribeAuthorizationChanges ? {
      subscribeAuthorizationChange: (call: TurnToolCall, listener: () => void) => input.subscribeAuthorizationChanges!(call, listener),
      currentAuthorizationVersion: input.currentAuthorizationVersion
    } : {}),
    resolveExpected: async (call) => {
      const record = prepared.get(keyFor(call))
      if (!record || !sameCall(record.call, call)) throw new Error('PREPARED_CALL_MISMATCH')
      return record.binding
    },
    validatePrepared: async (call, binding) => {
      const record = prepared.get(keyFor(call))
      if (!record || !sameCall(record.call, call) || !sameBinding(record.binding, binding)) return false
      if (isRevoked(call)) return false
      return await input.resolveAuthorizationVersion(call, { kind: 'recheck' }) === binding.authorizationVersion
    },
    execute: async (call, leaseSignal) => {
      const record = prepared.get(keyFor(call))
      if (!record || !sameCall(record.call, call)) throw new Error('PREPARED_CALL_MISMATCH')
      const combined = combineSignals(call.signal ?? record.signal, leaseSignal)
      try {
        let raw: unknown
        try {
          raw = await record.handle.execute(executionContextFor(record, combined.signal))
        } catch (error) {
          throw settleExecutorUnhandledError(error).error
        }
        const runtimeContext = record.runtimeContext && typeof record.runtimeContext === 'object' && !Array.isArray(record.runtimeContext)
          ? record.runtimeContext as Record<string, unknown>
          : undefined
        const withPolicyMetadata = raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...raw as Record<string, unknown>, ...(typeof runtimeContext?.decisionRuleId === 'string' ? { decisionRuleId: runtimeContext.decisionRuleId } : {}), ...(runtimeContext?.autoApprovedWrite && typeof runtimeContext.autoApprovedWrite === 'object' ? { autoApprovedWrite: { ...(runtimeContext.autoApprovedWrite as Record<string, unknown>), ...((raw as Record<string, unknown>).success === true && (raw as Record<string, unknown>).data && typeof (raw as Record<string, unknown>).data === 'object' ? (raw as { data: Record<string, unknown> }).data : {}) } } : {}) }
          : raw
        const processValidation = isProcessToolName(call.toolName) ? validateToolExecutorResultWithViolations(withPolicyMetadata) : undefined
        for (const violation of processValidation?.violations ?? []) {
          if (violation.invariant === 'I5') continue
          logAgentEvent('warn', 'tool.result.contract-violation', { requestId: input.requestId, toolUseId: call.toolCallId, toolName: call.toolName, invariant: violation.invariant, detail: violation.detail })
        }
        const normalized = processValidation?.result ?? validateToolExecutorResultForTool(call.toolName, withPolicyMetadata)
        return input.mapExecutionResult?.(normalized, call) ?? mapSafeExecutionResult(normalized, call, input.resolveWorkspaceRoot?.() ?? input.workspaceRoot)
      } finally {
        combined.dispose()
        cleanupPrepared(record)
      }
    }
  })
  const toolExecution: typeof permitBoundExecution = {
    ...permitBoundExecution,
    async execute(call, permitId, onDispatchClaimed) {
      const record = prepared.get(keyFor(call))
      return permitBoundExecution.execute(record ? { ...call, signal: record.signal } : call, permitId, onDispatchClaimed)
    }
  }

  const executeDeferred = async (call: TurnToolCall, request: {
    confirmationReceipt: string
    confirmationPolicyRevision?: string
    authorizeInitial?(initial: PermitBinding): Promise<{ kind: 'allow' } | { kind: 'deny'; reasonCode?: string }>
    authorize(initial: PermitBinding, recheck: PermitBinding): Promise<{ kind: 'allow'; permitId: string } | { kind: 'deny'; reasonCode?: string }>
  }): Promise<TurnToolResult> => {
    if (!request.confirmationReceipt.trim()) throw new Error('DEFERRED_CONFIRMATION_RECEIPT_REQUIRED')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let dispatchClaimed = false
      try {
        const initial = await prepareTool(call, { kind: 'initial' })
      if (request.authorizeInitial) {
        const initialAuthorization = await request.authorizeInitial(initial)
        if (initialAuthorization.kind !== 'allow') {
          if (initialAuthorization.reasonCode === 'FRESH_APPROVAL_REQUIRED') throw new Error('FRESH_APPROVAL_REQUIRED')
          throw new Error(`DEFERRED_INITIAL_POLICY_DENIED:${initialAuthorization.reasonCode ?? 'POLICY_DENY'}`)
        }
      }
        const recheck = await prepareTool(call, { kind: 'recheck', confirmation: { receipt: request.confirmationReceipt, answerer: 'user' } })
        if (!sameRecheckSubject(initial, recheck)) throw new Error('DEFERRED_RECHECK_BINDING_CHANGED')
        const authorization = await request.authorize(initial, recheck)
        if (authorization.kind !== 'allow') throw new Error(`DEFERRED_SAFETY_RECHECK_DENIED:${authorization.reasonCode ?? 'POLICY_DENY'}`)
        return await toolExecution.execute(call, authorization.permitId, () => { dispatchClaimed = true })
      } catch (error) {
        // Final-check boundary: AUTHORIZATION_STALE is emitted before executor entry; rebuild and reauthorize
        // the same deferred call. Cancellation, revocation, and post-entry failures remain terminal.
        if (error instanceof ToolExecutionRejectedError && error.reason === 'AUTHORIZATION_STALE' && attempt < 3) {
          discardPreparedTool(call)
          continue
        }
        if (!dispatchClaimed || error instanceof ToolExecutionRejectedError) throw new DeferredToolPreDispatchError(error)
        throw error
      } finally {
        discardPreparedTool(call)
      }
    }
    throw new DeferredToolPreDispatchError(new Error('AUTHORIZATION_STALE'))
  }

  return {
    prepareTool,
    discardPreparedTool,
    getPreparedCall,
    getPreparedFacts,
    getPolicyDecisionMetadata,
    updateExecutionContext,
    toolExecution,
    executeDeferred,
    isApprovalCandidate: (call) => {
      const registeredName = input.resolveRegisteredToolName?.(call.toolName) ?? resolveRegisteredToolName(call.toolName, input.registry)
      const registered = input.registry.get(registeredName)
      const actionClass = registered?.actionClass
      if (actionClass) return ['write', 'execute', 'outbound'].includes(actionClass)
      return ['write_file', 'edit_file', 'run_shell', 'run_script', 'browser', 'browser_action'].includes(call.toolName)
        || ['write_file', 'edit_file', 'run_shell', 'run_script', 'browser', 'browser_action'].includes(registeredName)
    },
    toolResourceKeys: (call) => {
      const record = prepared.get(keyFor(call))
      return record?.registeredTool.resourceKeys?.(call.input, {
        workDir: String((record.runtimeContext as { workDir?: unknown } | undefined)?.workDir ?? ''),
        sessionId: String((record.runtimeContext as { sessionId?: unknown } | undefined)?.sessionId ?? '')
      })
    }
  }
}

function sameRecheckSubject(initial: PermitBinding, recheck: PermitBinding): boolean {
  return recheck.phase === 'recheck' && initial.requestId === recheck.requestId && initial.turnId === recheck.turnId &&
    initial.invocationId === recheck.invocationId && initial.toolCallId === recheck.toolCallId &&
    initial.capabilityId === recheck.capabilityId && initial.inputSnapshotHash === recheck.inputSnapshotHash &&
    initial.planDigest === recheck.planDigest && initial.factsDigest === recheck.factsDigest
}

function mapSafeExecutionResult(raw: unknown, call: TurnToolCall, workspaceRoot?: string): TurnToolResult {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  const success = typeof source?.success === 'boolean' ? source.success : true
  const result = {
    success,
    ...(source && 'data' in source ? { data: source.data } : raw !== undefined ? { data: raw } : {}),
    ...(typeof source?.error === 'string' ? { error: source.error } : {}),
    ...(typeof source?.userMessage === 'string' ? { userMessage: source.userMessage } : {}),
    ...(typeof source?.decisionRuleId === 'string' ? { decisionRuleId: source.decisionRuleId } : {}),
    ...(source?.autoApprovedWrite && typeof source.autoApprovedWrite === 'object' ? { autoApprovedWrite: { ...(source.autoApprovedWrite as Record<string, unknown>), ...(success && source.data && typeof source.data === 'object' && !Array.isArray(source.data) ? source.data as Record<string, unknown> : {}) } as unknown as import('../../src/shared/domainTypes').AutoApprovedWriteMeta } : {}),
    ...(source && 'diagnostic' in source ? { diagnostic: source.diagnostic } : {})
  }
  const options = { workspaceRoot, processTool: isProcessToolName(call.toolName) }
  const output = projectAgentToolResult(result, options)
  const replayContent = compactOversizedToolResultContent(serializeAgentToolResult(result, options)).content
  return { output, auditOutput: { ...result, success }, replayContent, isError: !output.success }
}

async function createBinding(input: {
  requestId: string
  turnId: string
  resolveAuthorizationVersion(call: TurnToolCall, stage: ToolPreparationStage): Promise<string> | string
}, call: TurnToolCall, handle: PreparedRecord['handle'], stage: ToolPreparationStage): Promise<PermitBinding> {
  const authorizationVersion = await input.resolveAuthorizationVersion(call, stage)
  if (!authorizationVersion.trim()) throw new Error('AUTHORIZATION_VERSION_REQUIRED')
  return Object.freeze({
    requestId: input.requestId,
    turnId: input.turnId,
    invocationId: call.invocationId,
    toolCallId: call.toolCallId,
    capabilityId: call.toolName,
    inputSnapshotHash: createHash('sha256').update(stableSerialize(call.input)).digest('hex'),
    planDigest: handle.prepared.planDigest,
    factsDigest: handle.prepared.factsDigest,
    authorizationVersion,
    ...(stage.kind === 'recheck' && stage.policyChanged ? { policyChanged: true as const } : {}),
    phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck'
  })
}

function executionContextFor(record: PreparedRecord, signal: AbortSignal): ToolExecutionContext {
  return {
    requestId: record.handle.prepared.requestId,
    toolUseId: record.handle.prepared.toolUseId,
    toolName: record.handle.prepared.toolName,
    runtimeContext: record.runtimeContext as ToolExecutionContext['runtimeContext'],
    ...(record.userConfirmationReceipt ? { userConfirmationReceipt: record.userConfirmationReceipt } : {}),
    ...(record.userConfirmationAnswerer ? { userConfirmationAnswerer: record.userConfirmationAnswerer } : {}),
    signal
  }
}

function snapshotCall(call: TurnToolCall): TurnToolCall {
  return { invocationId: call.invocationId, toolCallId: call.toolCallId, toolName: call.toolName, input: structuredClone(call.input), ...(call.signal ? { signal: call.signal } : {}) }
}

function sameCall(left: TurnToolCall, right: TurnToolCall): boolean {
  return left.invocationId === right.invocationId && left.toolCallId === right.toolCallId && left.toolName === right.toolName && stableSerialize(left.input) === stableSerialize(right.input)
}

function sameBinding(left: PermitBinding, right: PermitBinding): boolean {
  return left.requestId === right.requestId && left.turnId === right.turnId && left.invocationId === right.invocationId && left.toolCallId === right.toolCallId && left.capabilityId === right.capabilityId && left.inputSnapshotHash === right.inputSnapshotHash && left.planDigest === right.planDigest && left.factsDigest === right.factsDigest && left.authorizationVersion === right.authorizationVersion && left.policyChanged === right.policyChanged && left.phase === right.phase
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function combineSignals(primary: AbortSignal, lease: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([primary, lease]), dispose: () => undefined }
  const controller = new AbortController()
  const abortPrimary = () => controller.abort(primary.reason)
  const abortLease = () => controller.abort(lease.reason)
  if (primary.aborted) abortPrimary()
  else primary.addEventListener('abort', abortPrimary, { once: true })
  if (lease.aborted) abortLease()
  else lease.addEventListener('abort', abortLease, { once: true })
  return { signal: controller.signal, dispose: () => { primary.removeEventListener('abort', abortPrimary); lease.removeEventListener('abort', abortLease) } }
}
