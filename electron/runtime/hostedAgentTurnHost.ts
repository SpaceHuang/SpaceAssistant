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
  /** FR3：延迟工具名集合（不在 request.tools 广告面、在授权面）。
   *  capabilities.define 时同时并入 known 与 authorized（门禁簿记，零上下文成本；
   *  SDK 约束 authorized ⊆ known 由「两栏都填」满足）。 */
  deferredToolNames?: ReadonlySet<string>
  /** FR8：延迟工具未浮现直调判定（sessionLedgerForToolResult 持久化投影查询）。 */
  deferredUnsurfacedCheck?: (toolName: string) => boolean
  /** FR12②：本轮因预算被裁的工具名（快照层 budgetDropped ∪ 广告面层 eagerBudgetDropped）；
   *  被拒文案据此区分「预算未注入」与「服务不可用」。 */
  budgetDroppedNames?: ReadonlySet<string>
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
      // FR3（A 方案）：延迟名并入 known 与 authorized 两栏——模型直调延迟工具经 capability
      // 检查（known-authorized）走正常分发路径执行（透明兜底 D2），tool loop 不中断。
      // known 语义 = 广告面 ∪ 索引面（模型在索引区块中确实见过这些名字）。
      const deferredNames = [...(dependencies.deferredToolNames ?? [])].filter((name) => dependencies.toolRegistry.get(
        dependencies.resolveRegisteredToolName?.(name) ?? resolveRegisteredToolName(name, dependencies.toolRegistry)
      ) !== undefined)
      const known = [...new Set([...visibleTools, ...deferredNames])]
      const authorized = [...new Set([...invocationAuthorized, ...deferredNames])]
      dependencies.capabilities.define(input.invocationId, known, authorized)
      // FR12②：对 UNKNOWN/UNAUTHORIZED 拒绝附加区分文案——预算裁剪名单内 =「预算未注入」，
      // 其余（幻觉名/服务已移除）=「服务不可用」。显式委托包装（评审 P3：不走原型链，避免
      // SafetyGate 未来改用 #private 字段时静默破）；仅叠加 userMessage，决策语义不变。
      const safetyGate = dependencies.safetyGate
      const budgetDroppedNames = dependencies.budgetDroppedNames
      const wrappedSafetyGate: import('../../packages/agent-sdk/src/safetyGate').SafetyGatePort = budgetDroppedNames && budgetDroppedNames.size > 0
        ? {
            evaluate: async (binding, signal) => {
              const decision = await safetyGate.evaluate(binding, signal)
              if (decision.kind === 'deny' &&
                (decision.reasonCode === 'UNKNOWN_CAPABILITY' || decision.reasonCode === 'UNAUTHORIZED_CAPABILITY')) {
                return {
                  ...decision,
                  userMessage: budgetDroppedNames.has(binding.capabilityId)
                    ? `工具 ${binding.capabilityId} 因本轮上下文预算未注入（已被裁剪），本轮无法调用。请减少同时启用的 MCP 工具，或在设置页查看工具预算裁剪记录。`
                    : `工具 ${binding.capabilityId} 当前不可用：MCP 工具可能已变更或服务不可用。请确认服务连接，并在设置页刷新工具列表后重试。`
                }
              }
              return decision
            },
            authorize: (binding, signal) => safetyGate.authorize(binding, signal),
            discardPermit: (permitId) => safetyGate.discardPermit(permitId)
          }
        : safetyGate
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
        safetyGate: wrappedSafetyGate,
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
