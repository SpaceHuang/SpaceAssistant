import { createHash } from 'node:crypto'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import type { ExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import type { PermitBinding, SafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import type { ToolPreparationStage } from '../../packages/agent-sdk/src/turn'
import type { AgentToolRevocationPort } from '../../src/shared/agent/invocation'
import type { RegisteredTool, ToolExecutionContext } from './plannedToolRegistry'
import { resolveRegisteredToolName } from './registeredToolName'
import { projectAgentToolResult, serializeAgentToolResult } from '../../src/shared/agentToolResult'
import { isProcessToolName } from '../../src/shared/processResultProjection'
import { compactOversizedToolResultContent } from '../../src/shared/oversizedToolResult'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { validateToolExecutorResultForTool, validateToolExecutorResultWithViolations } from './types'
import { classifyFileReadError, isExecutionOutcomeUncertainError, isUserAbortError } from './toolExecutionResource'
import { toToolUserError } from './toolUserErrors'

export type ExecutorUnhandledSettlement = { rethrow: true; error: unknown } | { rethrow: false; result: Record<string, unknown> }

/**
 * Executor 进入后抛出的漏网异常的结算决策：Uncertain（副作用不确定）、取消/中断，以及
 * 写/执行类工具（write/execute/未声明——动作可能已发生）都必须穿透继续向上，整轮按
 * unknown-after-dispatch / interrupted 结算；仅读类（actionClass 'read'，无副作用）的
 * 漏网异常降级为工具级错误结果，让模型可直接重试。
 */
export function settleExecutorUnhandledError(error: unknown, toolName: string, actionClass: string | undefined): ExecutorUnhandledSettlement {
  if (isExecutionOutcomeUncertainError(error)) return { rethrow: true, error }
  if (isUserAbortError(error) || (error instanceof Error && error.name === 'AbortError')) return { rethrow: true, error }
  if (actionClass !== 'read') return { rethrow: true, error }
  const friendly = toToolUserError(error, { toolName })
  // toToolUserError 对含绝对路径/超长的原始消息会退到通用文案，errno 码是对模型最有
  // 诊断价值的信号，单独补回（EBADF/EBUSY/ENOENT…），避免技术细节完全丢失。
  const code = (error as NodeJS.ErrnoException)?.code
  // retryable 与 executor 内降级（degradedFsReadResult）保持同一信号：errno 瞬态类可重试。
  const retryable = classifyFileReadError(error) === 'transient'
  return {
    rethrow: false,
    result: {
      success: false,
      error: code && !friendly.includes(code) ? `${friendly}（系统错误码 ${code}）` : friendly,
      diagnostic: { caseId: 'executor-unhandled-error', retryable, category: 'executor' }
    }
  }
}

type TurnToolCall = Readonly<{
  invocationId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  signal?: AbortSignal
}>
type TurnToolResult = Readonly<{ output: unknown; replayContent?: unknown; isError?: boolean }>
type PreparedRecord = {
  call: TurnToolCall
  registeredTool: RegisteredTool
  handle: Awaited<ReturnType<RegisteredTool['begin']>>
  runtimeContext: unknown
  signal: AbortSignal
  disposeSignal(): void
  unregisterActiveCancellation?: () => void
  binding: PermitBinding
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
  updateExecutionContext(call: TurnToolCall, update: (context: Record<string, unknown>) => void): void
  toolExecution: ReturnType<typeof createPermitBoundToolExecutionPort<TurnToolCall, TurnToolResult>>
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
    try {
      if (input.refreshExecutionContext) {
        const currentContext = record.runtimeContext
        if (!isRecord(currentContext)) throw new Error('PREPARED_EXECUTION_CONTEXT_NOT_REFRESHABLE')
        const safetyOwned = Object.fromEntries(['readExecutionPermit', 'writeExecutionPermit', 'decisionRuleId', 'autoApprovedWrite'].flatMap((key) =>
          Object.prototype.hasOwnProperty.call(currentContext, key) ? [[key, currentContext[key]]] : []
        ))
        const refreshed = await input.refreshExecutionContext(call, stage, currentContext)
        if (!isRecord(refreshed)) throw new Error('REFRESHED_EXECUTION_CONTEXT_INVALID')
        record.runtimeContext = { ...refreshed, ...safetyOwned }
      }
      if (record.handle.state === 'planned') record.handle.awaitConfirmation()
      if (record.handle.state !== 'awaiting-confirm') throw new Error('PREPARED_TOOL_NOT_AWAITING_CONFIRMATION')
      record.handle.confirm()
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
          // Executor 已进入（dispatch 后）。副作用是否发生不确定的失败必须抛 *UncertainError
          // （库内约定），连同取消/中断一起保持向上传播、整轮按 unknown-after-dispatch 结算；
          // 其余漏网异常（fs 瞬态、环境错误等）视为无副作用失败，降级为工具级错误结果，
          // 让模型可直接重试而不是把整轮打成 interrupted。
          const settlement = settleExecutorUnhandledError(error, call.toolName, record.registeredTool?.actionClass)
          if (settlement.rethrow) throw error
          logAgentEvent('warn', 'tool.result.executor-unhandled-error', { requestId: input.requestId, toolUseId: call.toolCallId, toolName: call.toolName, error: error instanceof Error ? error.message : String(error) })
          raw = settlement.result
        }
        const runtimeContext = record.runtimeContext && typeof record.runtimeContext === 'object' && !Array.isArray(record.runtimeContext)
          ? record.runtimeContext as Record<string, unknown>
          : undefined
        const withPolicyMetadata = raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...raw as Record<string, unknown>, ...(typeof runtimeContext?.decisionRuleId === 'string' ? { decisionRuleId: runtimeContext.decisionRuleId } : {}), ...(runtimeContext?.autoApprovedWrite && typeof runtimeContext.autoApprovedWrite === 'object' ? { autoApprovedWrite: runtimeContext.autoApprovedWrite } : {}) }
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

  return {
    prepareTool,
    discardPreparedTool,
    getPreparedCall,
    updateExecutionContext,
    toolExecution,
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

function mapSafeExecutionResult(raw: unknown, call: TurnToolCall, workspaceRoot?: string): TurnToolResult {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  const success = typeof source?.success === 'boolean' ? source.success : true
  const result = {
    success,
    ...(source && 'data' in source ? { data: source.data } : raw !== undefined ? { data: raw } : {}),
    ...(typeof source?.error === 'string' ? { error: source.error } : {}),
    ...(typeof source?.userMessage === 'string' ? { userMessage: source.userMessage } : {}),
    ...(typeof source?.decisionRuleId === 'string' ? { decisionRuleId: source.decisionRuleId } : {}),
    ...(source?.autoApprovedWrite && typeof source.autoApprovedWrite === 'object' ? { autoApprovedWrite: source.autoApprovedWrite as import('../../src/shared/domainTypes').AutoApprovedWriteMeta } : {}),
    ...(source && 'diagnostic' in source ? { diagnostic: source.diagnostic } : {})
  }
  const options = { workspaceRoot, processTool: isProcessToolName(call.toolName) }
  const output = projectAgentToolResult(result, options)
  const replayContent = compactOversizedToolResultContent(serializeAgentToolResult(result, options)).content
  return { output, replayContent, isError: !output.success }
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
    phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck'
  })
}

function executionContextFor(record: PreparedRecord, signal: AbortSignal): ToolExecutionContext {
  return {
    requestId: record.handle.prepared.requestId,
    toolUseId: record.handle.prepared.toolUseId,
    toolName: record.handle.prepared.toolName,
    runtimeContext: record.runtimeContext as ToolExecutionContext['runtimeContext'],
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
  return left.requestId === right.requestId && left.turnId === right.turnId && left.invocationId === right.invocationId && left.toolCallId === right.toolCallId && left.capabilityId === right.capabilityId && left.inputSnapshotHash === right.inputSnapshotHash && left.planDigest === right.planDigest && left.factsDigest === right.factsDigest && left.authorizationVersion === right.authorizationVersion && left.phase === right.phase
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
