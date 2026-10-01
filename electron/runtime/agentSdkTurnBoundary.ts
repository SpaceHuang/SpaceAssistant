import type { CanonicalModelMessage } from '../../packages/agent-sdk/src/model'
import type { ClaudeChatMessageWithBlocks } from '../../src/shared/api'
import { toLegacyBoundaryMessages } from './canonicalHistory'

export type AgentSdkTurnBoundaryInput = Readonly<{
  invocationId: string
  modelTurn: number
  response: CanonicalModelMessage
  messages: readonly CanonicalModelMessage[]
  toolCalls: readonly Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }>[]
  usage: Readonly<{ inputTokens: number; outputTokens: number }>
  requestProjection?: Readonly<{
    requestId: string
    windowId: string
    system: string
    tools: unknown[]
    surfaceSnapshot: ReturnType<typeof import('../../src/shared/requestContext').buildRequestHeaderPayload>['surfaceSnapshot']
    budget: ReturnType<typeof import('../../src/shared/requestContext').buildRequestContextPayload>['budget']
    contextUsage?: ReturnType<typeof import('../../src/shared/requestContext').buildRequestContextPayload>['contextUsage']
    toolExecutionCheckpoint: ReturnType<typeof import('../../src/shared/requestContext').buildRequestHeaderPayload>['toolExecutionCheckpoint']
    requiredSurfaceSet: string[]
  }>
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

export type AgentSdkTurnBoundaryContext = Readonly<{
  compact(input: AgentSdkTurnBoundaryInput & Readonly<{ legacyMessages: readonly ClaudeChatMessageWithBlocks[]; plannerInputs?: AgentSdkTurnBoundaryInput['requestProjection'] }>): Promise<Readonly<{ messages: readonly CanonicalModelMessage[] }> | void>
  hasLegacyPlannerInputs?: boolean
}>

export type AgentSdkPreflightRequestInput = Readonly<{
  invocationId: string
  modelTurn: number
  messages: readonly CanonicalModelMessage[]
  requestProjection?: AgentSdkTurnBoundaryInput['requestProjection']
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

/** Adapts request-time compaction to the same Desktop planner without inventing a model response. */
export function createAgentSdkPreflightAdapter(context: Readonly<{
  compact(input: Readonly<{
    requestId: string
    windowId: string
    system: string
    tools: unknown[]
    surfaceSnapshot: NonNullable<AgentSdkPreflightRequestInput['requestProjection']>['surfaceSnapshot']
    messages: readonly ClaudeChatMessageWithBlocks[]
    budget: NonNullable<AgentSdkPreflightRequestInput['requestProjection']>['budget']
    contextUsage?: NonNullable<AgentSdkPreflightRequestInput['requestProjection']>['contextUsage']
    toolExecutionCheckpoint: NonNullable<AgentSdkPreflightRequestInput['requestProjection']>['toolExecutionCheckpoint']
    requiredSurfaceSet: string[]
  }>): Promise<Readonly<{ messages: readonly CanonicalModelMessage[]; windowId?: string; historyPayload?: Record<string, unknown>; commitProjection?(): void | Promise<void> }> | void>
}>) {
  return async (input: AgentSdkPreflightRequestInput): Promise<Readonly<{ messages: readonly CanonicalModelMessage[]; windowId?: string; historyPayload?: Record<string, unknown>; commitProjection?(): void | Promise<void> } | { rejected: 'OVER_BUDGET' }> | void> => {
    const projection = input.requestProjection
    if (!projection) return undefined
    if (input.currentUserMessageId && (!input.requiredUserMessage || input.requiredUserMessage.id !== input.currentUserMessageId)) return undefined
    let legacyMessages: ClaudeChatMessageWithBlocks[]
    try { legacyMessages = toLegacyBoundaryMessages(input.messages, input.requiredUserMessage) }
    catch { return undefined }
    const result = await context.compact({ ...projection, messages: legacyMessages })
    if (!result) {
      const projectedTokens = projection.contextUsage?.projectedTokens ?? projection.surfaceSnapshot.surfaceTokens
      return projectedTokens > projection.budget.totalInputBudget
        ? { rejected: 'OVER_BUDGET' as const }
        : undefined
    }
    if (input.currentUserMessageId && input.requiredUserMessage) {
      const required = JSON.stringify(input.requiredUserMessage.message)
      if (!result.messages.some((message) => message.role === 'user' && JSON.stringify(message) === required)) return undefined
    }
    return result
  }
}

/** Host adapter for planning transcript compaction; SDK revalidates proposals before history commit. */
export function createAgentSdkTurnBoundaryAdapter(context: AgentSdkTurnBoundaryContext) {
  return async (input: AgentSdkTurnBoundaryInput): Promise<Readonly<{ messages: readonly CanonicalModelMessage[] }> | void> => {
    if (input.toolCalls.length > 0 || context.hasLegacyPlannerInputs === false) return
    if (input.currentUserMessageId && (!input.requiredUserMessage || input.requiredUserMessage.id !== input.currentUserMessageId)) return
    let legacyMessages: ClaudeChatMessageWithBlocks[]
    try { legacyMessages = toLegacyBoundaryMessages(input.messages, input.requiredUserMessage) }
    catch { return }
    const result = await context.compact({ ...input, legacyMessages, ...(input.requestProjection ? { plannerInputs: input.requestProjection } : {}) })
    if (!result) return
    const requiredId = input.currentUserMessageId ?? input.requiredUserMessage?.id
    if (requiredId && input.requiredUserMessage && !result.messages.some((message) => message.role === 'user' && JSON.stringify(message) === JSON.stringify(input.requiredUserMessage!.message))) return
    return result
  }
}
