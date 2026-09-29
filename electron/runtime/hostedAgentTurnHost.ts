import type { AgentTurnHost, AgentTurnPorts, ConfirmationPort } from '../../packages/agent-sdk/src/turn'
import type { CanonicalModelMessage, ModelProviderRegistry, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import type { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import type { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import type { SafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import type { ExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import type { HistoryPort } from '../../packages/agent-sdk/src/history'
import type { PermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import type { CanonicalTurnMessage, ToolPreparationStage } from '../../packages/agent-sdk/src/turn'
import type { PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'
import type { AgentTurnObserver } from '../../packages/agent-sdk/src/turn'
import { resolveRegisteredToolName } from '../tools/registeredToolName'

export type HostedAgentTurnCall = Readonly<{
  invocationId: string
  turnId?: string
  windowId?: string
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  routeId: string
  request: PreparedModelCall['request']
}>

export type HostedAgentTurnHostDependencies<TCall extends { invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, TResult> = Readonly<{
  invocationId: string
  turnId: string
  routeId: string
  providerRegistry: ModelProviderRegistry
  toolRegistry: { get(name: string): unknown; entries?(): readonly Readonly<{ name: string }>[] }
  /** Product-filtered capability set for this invocation; model-visible tools alone never grant authorization. */
  authorizedToolNames: ReadonlySet<string>
  resolveRegisteredToolName?(providerToolName: string): string
  capabilities: CapabilityRegistry
  permits: SafetyPermitStore
  admission: ExecutionAdmissionCoordinator
  safetyGate: SafetyGate
  history: HistoryPort
  sdkHistory?: HistoryPort
  hostHistory?: HistoryPort
  appendHistoryEvents?(events: readonly Readonly<{ kind: import('../../packages/agent-sdk/src/history').HistoryEvent['kind']; payload: unknown }>[]): Promise<void>
  expectedHistoryVersion?(): Promise<number>
  prepareTool(call: TCall, stage: ToolPreparationStage): Promise<PermitBinding>
  discardPreparedTool?(call: TCall, reason: string): void | Promise<void>
  confirmation?: ConfirmationPort
  toolExecution: PermitBoundToolExecutionPort<TCall, TResult>
  observer?: AgentTurnObserver
  recordProviderAttemptUsage?(input: Record<string, unknown>): void | Promise<void>
  recoverProviderAttempt?(input: Parameters<NonNullable<AgentTurnPorts['recoverProviderAttempt']>>[0]): ReturnType<NonNullable<AgentTurnPorts['recoverProviderAttempt']>>
  refreshExecutionContext?(call: TCall, stage: Extract<ToolPreparationStage, { kind: 'recheck' }>, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
  recoverOutputLimit?(input: Parameters<NonNullable<AgentTurnPorts['recoverOutputLimit']>>[0]): ReturnType<NonNullable<AgentTurnPorts['recoverOutputLimit']>>
  preflightModelRequest?(input: Parameters<NonNullable<AgentTurnPorts['preflightModelRequest']>>[0]): ReturnType<NonNullable<AgentTurnPorts['preflightModelRequest']>>
  turnBoundary?(input: Parameters<NonNullable<AgentTurnPorts['turnBoundary']>>[0]): ReturnType<NonNullable<AgentTurnPorts['turnBoundary']>>
  maxConcurrentTools: number
  maxModelTurns: number
  maxToolRounds?: number
  resourceLocks?: AgentTurnPorts['resourceLocks']
  toolResourceKeys?(call: TCall): readonly string[] | undefined
  isApprovalCandidate?(call: TCall): boolean
  applicationAdmission?: AgentTurnPorts['applicationAdmission']
  deadlineAt?: number
  sessionLedgerForToolResult?(call: TCall, result: Readonly<{ output: unknown; replayContent?: unknown; isError?: boolean; auditRef?: string }>): Record<string, unknown> | Promise<Record<string, unknown>>
  afterToolResult?(call: TCall, result: Readonly<{ output: unknown; replayContent?: unknown; isError?: boolean; auditRef?: string }>): void | Promise<void>
  sessionLedgerForNotDispatched?(call: TCall, reason: string, result: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
  sessionLedgerForModelResponse?(message: import('../../packages/agent-sdk/src/turn').CanonicalTurnMessage, modelTurn: number, attempt: number): Record<string, unknown> | Promise<Record<string, unknown>>
  sessionLedgerForAttemptUsage?(attempt: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
  sessionLedgerForInvocationTerminal?(terminal: { status: 'completed' | 'failed' | 'interrupted'; turnId: string; sessionEventReason?: 'completed' | 'failed' | 'interrupted' | 'cancelled' }): Record<string, unknown> | Promise<Record<string, unknown>>
}>

/**
 * Build a route- and invocation-bound SDK host from already-authorized Electron runtime ports.
 * This module only composes capabilities; policy and execution decisions remain in the supplied ports.
 */
export function createHostedAgentTurnHost<
  TCall extends { invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal },
  TResult
>(dependencies: HostedAgentTurnHostDependencies<TCall, TResult>): AgentTurnHost {
  if (!dependencies.invocationId.trim()) throw new Error('HOSTED_INVOCATION_ID_REQUIRED')
  if (!dependencies.turnId.trim()) throw new Error('HOSTED_TURN_ID_REQUIRED')
  if (!dependencies.routeId.trim()) throw new Error('HOSTED_ROUTE_ID_REQUIRED')
  if (!dependencies.providerRegistry) throw new Error('HOSTED_PROVIDER_REGISTRY_REQUIRED')
  if (!dependencies.toolRegistry) throw new Error('HOSTED_TOOL_REGISTRY_REQUIRED')
  if (!dependencies.capabilities) throw new Error('HOSTED_CAPABILITY_REGISTRY_REQUIRED')
  if (!dependencies.permits) throw new Error('HOSTED_SAFETY_PERMITS_REQUIRED')
  if (!dependencies.admission) throw new Error('HOSTED_EXECUTION_ADMISSION_REQUIRED')
  if (!dependencies.safetyGate) throw new Error('HOSTED_SAFETY_GATE_REQUIRED')
  if (!dependencies.history) throw new Error('HOSTED_HISTORY_REQUIRED')
  if (typeof dependencies.prepareTool !== 'function') throw new Error('HOSTED_TOOL_PREPARATION_REQUIRED')
  if (!dependencies.toolExecution) throw new Error('HOSTED_TOOL_EXECUTION_REQUIRED')
  if (!Number.isInteger(dependencies.maxConcurrentTools) || dependencies.maxConcurrentTools < 1) throw new Error('HOSTED_TOOL_CONCURRENCY_INVALID')
  if (!Number.isInteger(dependencies.maxModelTurns) || dependencies.maxModelTurns < 1) throw new Error('HOSTED_MODEL_TURN_LIMIT_INVALID')

  return {
    async createPorts(input): Promise<AgentTurnPorts> {
      if (input.invocationId !== dependencies.invocationId) throw new Error('HOSTED_INVOCATION_ID_MISMATCH')
      if (input.turnId !== undefined && input.turnId !== dependencies.turnId) throw new Error('HOSTED_TURN_ID_MISMATCH')
      if (input.routeId !== dependencies.routeId) throw new Error('HOSTED_ROUTE_ID_MISMATCH')
      const route = dependencies.providerRegistry.getRoute(input.routeId)
      if (!route) throw new Error('HOSTED_PROVIDER_ROUTE_UNAVAILABLE')
      const visibleTools = routeVisibleToolNames(input.request)
      const registeredTools = visibleTools.filter((name) => dependencies.toolRegistry.get(
        dependencies.resolveRegisteredToolName?.(name) ?? resolveRegisteredToolName(name, dependencies.toolRegistry)
      ) !== undefined)
      const invocationAuthorized = registeredTools.filter((name) => dependencies.authorizedToolNames.has(
          dependencies.resolveRegisteredToolName?.(name) ?? resolveRegisteredToolName(name, dependencies.toolRegistry)
        ))
      dependencies.capabilities.define(input.invocationId, visibleTools, invocationAuthorized)
      if (!input.request.messages.length && input.currentUserMessageId) throw new Error('HOSTED_CURRENT_USER_MESSAGE_MISSING')
      if (input.currentUserMessageId && input.requiredUserMessage?.id !== input.currentUserMessageId) throw new Error('HOSTED_REQUIRED_USER_ID_MISMATCH')
      if (input.requiredUserMessage && !input.request.messages.some((message) => sameMessage(message, input.requiredUserMessage!.message))) throw new Error('HOSTED_REQUIRED_USER_MESSAGE_MISSING')

      return {
        invocationId: input.invocationId,
        routeId: input.routeId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.windowId ? { windowId: input.windowId } : {}),
        ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}),
        ...(input.requiredUserMessage ? { requiredUserMessage: input.requiredUserMessage } : {}),
        registry: dependencies.providerRegistry,
        safetyGate: dependencies.safetyGate,
        prepareTool: dependencies.prepareTool as AgentTurnPorts['prepareTool'],
        ...(dependencies.refreshExecutionContext ? { refreshExecutionContext: dependencies.refreshExecutionContext } : {}),
        ...(dependencies.discardPreparedTool ? { discardPreparedTool: dependencies.discardPreparedTool as AgentTurnPorts['discardPreparedTool'] } : {}),
        ...(dependencies.recordProviderAttemptUsage ? { recordProviderAttemptUsage: dependencies.recordProviderAttemptUsage } : {}),
        ...(dependencies.confirmation ? { confirmation: dependencies.confirmation } : {}),
        toolExecution: dependencies.toolExecution as AgentTurnPorts['toolExecution'],
        request: input.request,
        ...(dependencies.observer ? { observer: dependencies.observer } : {}),
        history: dependencies.hostHistory ?? dependencies.sdkHistory ?? dependencies.history,
        maxModelTurns: dependencies.maxModelTurns,
        ...(dependencies.maxToolRounds !== undefined ? { maxToolRounds: dependencies.maxToolRounds } : {}),
        returnDeniedToolsToModel: true,
        maxConcurrentTools: dependencies.maxConcurrentTools,
        ...(dependencies.resourceLocks ? { resourceLocks: dependencies.resourceLocks } : {}),
        ...(dependencies.toolResourceKeys ? { toolResourceKeys: dependencies.toolResourceKeys as AgentTurnPorts['toolResourceKeys'] } : {}),
        ...(dependencies.isApprovalCandidate ? { isApprovalCandidate: dependencies.isApprovalCandidate as AgentTurnPorts['isApprovalCandidate'] } : {}),
        ...(dependencies.applicationAdmission ? { applicationAdmission: dependencies.applicationAdmission } : {}),
        ...(dependencies.deadlineAt !== undefined ? { deadlineAt: dependencies.deadlineAt } : {}),
        ...(dependencies.sessionLedgerForToolResult ? { sessionLedgerForToolResult: dependencies.sessionLedgerForToolResult as AgentTurnPorts['sessionLedgerForToolResult'] } : {}),
        ...(dependencies.afterToolResult ? { afterToolResult: dependencies.afterToolResult as AgentTurnPorts['afterToolResult'] } : {}),
        ...(dependencies.sessionLedgerForNotDispatched ? { sessionLedgerForNotDispatched: dependencies.sessionLedgerForNotDispatched as AgentTurnPorts['sessionLedgerForNotDispatched'] } : {}),
        ...(dependencies.sessionLedgerForModelResponse ? { sessionLedgerForModelResponse: dependencies.sessionLedgerForModelResponse } : {}),
        ...(dependencies.sessionLedgerForAttemptUsage ? { sessionLedgerForAttemptUsage: dependencies.sessionLedgerForAttemptUsage } : {}),
        ...(dependencies.sessionLedgerForInvocationTerminal ? { sessionLedgerForInvocationTerminal: dependencies.sessionLedgerForInvocationTerminal } : {}),
        ...(dependencies.preflightModelRequest ? { preflightModelRequest: dependencies.preflightModelRequest as AgentTurnPorts['preflightModelRequest'] } : {}),
        ...(dependencies.turnBoundary ? { turnBoundary: dependencies.turnBoundary as AgentTurnPorts['turnBoundary'] } : {}),
        ...(dependencies.recoverProviderAttempt ? { recoverProviderAttempt: dependencies.recoverProviderAttempt as AgentTurnPorts['recoverProviderAttempt'] } : {}),
        ...(dependencies.recoverOutputLimit ? { recoverOutputLimit: dependencies.recoverOutputLimit as AgentTurnPorts['recoverOutputLimit'] } : {})
      }
    }
  }
}

function routeVisibleToolNames(request: PreparedModelCall['request']): string[] {
  const names: string[] = []
  for (const tool of request.tools ?? []) {
    const name = tool.name.trim()
    if (!name || names.includes(name)) throw new Error('HOSTED_TOOL_IDENTITY_INVALID')
    names.push(name)
  }
  return names
}

function sameMessage(left: CanonicalTurnMessage, right: CanonicalModelMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
