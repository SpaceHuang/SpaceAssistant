import { annotateUsageCacheSemantics } from '../../src/shared/usageCacheSemantics'
import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import type { SessionEventInput } from '../sessionEvents'
import { buildStepAttribution, type StepAttribution } from '../../src/shared/usageAttribution'

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
  modelId?: string
  providerModelName?: string
  routeIdentity?: string
  baseUrl?: string
  recordStepUsage?(fact: Record<string, unknown>): void
  attribution?: StepAttribution
  emitSessionEvent?(event: SessionEventInput): void | Promise<void>
  emitFactEvent?(event: AssistantFactEvent): void
  attributionForModelTurn?(modelTurn: number): StepAttribution | undefined
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
    const modelTurnNumber = modelTurn as number
    const rawAttribution = input.attribution ?? input.attributionForModelTurn?.(modelTurnNumber) ?? (attempt.attributionInput && typeof attempt.attributionInput === 'object' ? attempt.attributionInput as Record<string, unknown> : undefined)
    const attribution = rawAttribution && typeof rawAttribution === 'object' && 'blocks' in rawAttribution
      ? rawAttribution as unknown as StepAttribution
      : rawAttribution && typeof rawAttribution.system === 'string' && Array.isArray(rawAttribution.tools) && Array.isArray(rawAttribution.messages)
        ? buildStepAttribution(rawAttribution as unknown as Parameters<typeof buildStepAttribution>[0])
        : undefined
    const attributionSnapshot = attribution ? (({ threeSources: _sources, toolDeclarationSnapshot: _tools, ...snapshot }) => snapshot)(attribution as StepAttribution & { toolDeclarationSnapshot?: unknown }) : undefined
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
      ...(attribution ? { attribution: { ...attributionSnapshot, threeSources: attribution.threeSources, ...(attributionSnapshot ? { attributionJson: JSON.stringify(attributionSnapshot) } : {}) } } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.llmServiceId !== undefined ? { llmServiceId: input.llmServiceId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.providerModelName !== undefined ? { providerModelName: input.providerModelName } : {}),
      ...(input.routeIdentity !== undefined ? { routeIdentity: input.routeIdentity } : {})
    })
    input.emitFactEvent?.({ type: 'usage-updated', usage })
    await input.emitSessionEvent?.(sessionEvent)
  }
}
