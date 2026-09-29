import { annotateUsageCacheSemantics } from '../../src/shared/usageCacheSemantics'
import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import type { SessionEventInput } from '../sessionEvents'

export function createAgentSdkUsageSessionEvent(input: {
  requestId: string
  turnId: string
  baseUrl?: string
}, attempt: Record<string, unknown>): SessionEventInput | undefined {
  const rawUsage = attempt.usage && typeof attempt.usage === 'object' ? attempt.usage as Record<string, unknown> : undefined
  const modelTurn = attempt.modelTurn
  const attemptNumber = attempt.attempt
  const inputTokens = rawUsage?.inputTokens
  const outputTokens = rawUsage?.outputTokens
  const cacheReadTokens = rawUsage?.cacheReadInputTokens
  const cacheCreationTokens = rawUsage?.cacheCreationInputTokens
  if (!Number.isInteger(modelTurn) || (modelTurn as number) < 1 ||
    !Number.isInteger(attempt.attempt) || (attempt.attempt as number) < 1 ||
    typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0 ||
    (cacheReadTokens !== undefined && (typeof cacheReadTokens !== 'number' || !Number.isFinite(cacheReadTokens) || cacheReadTokens < 0)) ||
    (cacheCreationTokens !== undefined && (typeof cacheCreationTokens !== 'number' || !Number.isFinite(cacheCreationTokens) || cacheCreationTokens < 0))) return undefined
  const usage = annotateUsageCacheSemantics({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheReadTokens !== undefined ? { cache_read_input_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {})
  }, { baseUrl: input.baseUrl })
  const usageRequestId = `${input.requestId}:round:${modelTurn}${(attemptNumber as number) > 1 ? `:attempt:${attemptNumber}` : ''}`
  return {
    type: 'request_usage',
    payload: {
      schemaVersion: 1,
      requestId: usageRequestId,
      turnId: input.turnId,
      usage,
      source: 'api',
      ...(attempt.disposition === 'discarded' && typeof attempt.reasonCode === 'string' && attempt.reasonCode.startsWith('SILENT_CONTEXT_OVERFLOW')
        ? { resultDisposition: 'discarded_overflow' }
        : {})
    }
  }
}

/** Adapts SDK attempt usage to the existing per-provider-call usage-step ledger. */
export function createAgentSdkUsageRecorder(input: {
  requestId: string
  sessionId: string
  turnId: string
  model?: string
  llmServiceId?: string
  baseUrl?: string
  recordStepUsage?(fact: Record<string, unknown>): void
  emitSessionEvent?(event: SessionEventInput): void | Promise<void>
  emitFactEvent?(event: AssistantFactEvent): void
}): (attempt: Record<string, unknown>) => Promise<void> {
  return async (attempt) => {
    const sessionEvent = createAgentSdkUsageSessionEvent({ requestId: input.requestId, turnId: input.turnId, baseUrl: input.baseUrl }, attempt)
    if (!sessionEvent) return
    const rawUsage = attempt.usage && typeof attempt.usage === 'object' ? attempt.usage as Record<string, unknown> : undefined
    const modelTurn = attempt.modelTurn
    const attemptNumber = attempt.attempt
    const inputTokens = rawUsage?.inputTokens
    const outputTokens = rawUsage?.outputTokens
    const cacheReadTokens = rawUsage?.cacheReadInputTokens
    const cacheCreationTokens = rawUsage?.cacheCreationInputTokens
    if (!Number.isInteger(modelTurn) || (modelTurn as number) < 1 ||
      !Number.isInteger(attemptNumber) || (attemptNumber as number) < 1 ||
      typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0 ||
      typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0 ||
      (cacheReadTokens !== undefined && (typeof cacheReadTokens !== 'number' || !Number.isFinite(cacheReadTokens) || cacheReadTokens < 0)) ||
      (cacheCreationTokens !== undefined && (typeof cacheCreationTokens !== 'number' || !Number.isFinite(cacheCreationTokens) || cacheCreationTokens < 0))) return
    const usage = annotateUsageCacheSemantics({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cacheReadTokens !== undefined ? { cache_read_input_tokens: cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {})
    }, { baseUrl: input.baseUrl })
    input.recordStepUsage?.({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: `${input.requestId}:model:${modelTurn}:attempt:${attemptNumber}`,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheReadTokens ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(cacheCreationTokens ? { cache_creation_input_tokens: cacheCreationTokens } : {})
      },
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.llmServiceId !== undefined ? { llmServiceId: input.llmServiceId } : {})
    })
    input.emitFactEvent?.({ type: 'usage-updated', usage })
    await input.emitSessionEvent?.(sessionEvent)
  }
}
