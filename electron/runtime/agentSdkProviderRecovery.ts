import { decideOverflowRecovery, detectSilentContextOverflow, selectRecoveryMessages } from '../../src/shared/overflowRecovery'
import type { CanonicalModelMessage, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import { isOutputConfigRejectedError, memoizeEffortUnsupported } from '../effortFallback'

type RecoveryInput = Readonly<{
  error?: unknown
  response?: Readonly<{ finishReason: 'stop' | 'tool-calls' | 'length' | 'cancelled'; usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }; hasOutputContent: boolean }>
  attempt: number
  modelTurn: number
  routeId: string
  request?: PreparedModelCall['request']
  messages: readonly CanonicalModelMessage[]
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

/** Bridges the existing provider overflow policy into the SDK's bounded recovery port. */
export function createAgentSdkProviderRecovery(input: {
  contextWindow?: number
  contextWindowTrusted?: boolean
  model?: string
  llmServiceId?: string
  onEffortUnsupported?(error: unknown): void | Promise<void>
}): (request: RecoveryInput) => Promise<Readonly<{ kind?: 'retry'; reasonCode: string; messages: readonly CanonicalModelMessage[]; retryEvent?: Readonly<{ attempt: number; code: string }>; requestPatch?: Partial<Pick<PreparedModelCall['request'], 'thinking' | 'maxTokens'>>; recordTranscriptCompaction?: boolean } | { kind: 'reject'; reasonCode: string }> | undefined> {
  return async (request) => {
    if (request.attempt === 1 && request.request?.thinking?.effort && isOutputConfigRejectedError(request.error)) {
      memoizeEffortUnsupported(input.llmServiceId, input.model ?? request.routeId)
      await input.onEffortUnsupported?.(request.error)
      return {
        kind: 'retry',
        reasonCode: 'EFFORT_UNSUPPORTED',
        messages: request.messages,
        requestPatch: { thinking: { enabled: request.request.thinking.enabled } },
        recordTranscriptCompaction: false,
        retryEvent: { attempt: 1, code: 'effort_unsupported' }
      }
    }
    const silentOverflow = request.response ? detectSilentContextOverflow({
      stopReason: request.response.finishReason === 'stop' ? 'end_turn' : request.response.finishReason === 'length' ? 'max_tokens' : request.response.finishReason === 'tool-calls' ? 'tool_use' : undefined,
      usage: {
        input_tokens: request.response.usage.inputTokens,
        output_tokens: request.response.usage.outputTokens,
        ...(request.response.usage.cacheReadInputTokens ? { cache_read_input_tokens: request.response.usage.cacheReadInputTokens } : {}),
        ...(request.response.usage.cacheCreationInputTokens ? { cache_creation_input_tokens: request.response.usage.cacheCreationInputTokens } : {}),
        cacheSemantics: 'additive'
      },
      contextWindow: input.contextWindow,
      contextWindowTrusted: input.contextWindowTrusted,
      hasOutputContent: request.response.hasOutputContent
    }) : { overflow: false as const }
    const overflowError = silentOverflow.overflow ? { type: 'context_length_exceeded' } : request.error
    if (overflowError === undefined) return undefined
    const decision = decideOverflowRecovery({
      error: overflowError,
      retries: Math.max(0, request.attempt - 1),
      maxRetries: 1,
      inFlightToolCount: 0,
      safeBoundary: true
    })
    if (decision.action !== 'reset_and_retry_provider') {
      if (silentOverflow.overflow) return { kind: 'reject', reasonCode: decision.reason === 'retry_limit' ? 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT' : 'SILENT_CONTEXT_OVERFLOW_UNSAFE_BOUNDARY' }
      return undefined
    }
    const recoveredMessages = selectRecoveryMessages(request.messages, request.currentUserMessageId, request.requiredUserMessage?.message)
    if (request.requiredUserMessage && !recoveredMessages.some((message) =>
      message.role === 'user' && JSON.stringify(message) === JSON.stringify(request.requiredUserMessage!.message)
    )) {
      throw new Error(`provider overflow recovery omitted required user message: ${request.requiredUserMessage.id}`)
    }
    return {
      kind: 'retry',
      reasonCode: silentOverflow.overflow ? 'SILENT_CONTEXT_OVERFLOW' : 'PROVIDER_CONTEXT_OVERFLOW',
      messages: recoveredMessages,
      retryEvent: { attempt: decision.nextRetry, code: 'provider_context_overflow' },
      recordTranscriptCompaction: true
    }
  }
}
