import { decideOverflowRecovery, detectSilentContextOverflow, selectRecoveryMessages } from '../../src/shared/overflowRecovery'
import type { CanonicalModelMessage, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import { ModelStreamIdleTimeoutError } from '../../packages/agent-sdk/src/model'
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

function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const headers = (error as { headers?: unknown }).headers
  const value = headers && typeof headers === 'object' ? (headers as Record<string, unknown>)['retry-after'] ?? (headers as Record<string, unknown>)['Retry-After'] : undefined
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(String(value)) - now
  return Number.isFinite(delay) && delay >= 0 ? Math.min(30_000, delay) : undefined
}

function transientProviderError(error: unknown): { reasonCode: string; code: string } | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { status?: unknown; code?: unknown; cause?: unknown }
  if (record.status === 429) return { reasonCode: 'PROVIDER_RATE_LIMIT', code: 'provider_rate_limit' }
  if (typeof record.status === 'number' && record.status >= 500 && record.status <= 599) return { reasonCode: 'PROVIDER_SERVER_ERROR', code: 'provider_server_error' }
  const code = typeof record.code === 'string' ? record.code : record.cause && typeof record.cause === 'object' && typeof (record.cause as { code?: unknown }).code === 'string' ? (record.cause as { code: string }).code : ''
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNABORTED'].includes(code)) return { reasonCode: 'PROVIDER_NETWORK_ERROR', code: 'provider_network_error' }
  return undefined
}

/** Bridges the existing provider overflow policy into the SDK's bounded recovery port. */
export function createAgentSdkProviderRecovery(input: {
  contextWindow?: number
  contextWindowTrusted?: boolean
  model?: string
  llmServiceId?: string
  onEffortUnsupported?(error: unknown): void | Promise<void>
}): (request: RecoveryInput) => Promise<Readonly<{ kind?: 'retry'; reasonCode: string; messages: readonly CanonicalModelMessage[]; retryEvent?: Readonly<{ attempt: number; code: string }>; maxAttempts?: number; retryAfterMs?: number; requestPatch?: Partial<Pick<PreparedModelCall['request'], 'thinking' | 'maxTokens'>>; recordTranscriptCompaction?: boolean } | { kind: 'reject'; reasonCode: string }> | undefined> {
  return async (request) => {
    const transient = request.error ? transientProviderError(request.error) : undefined
    if (transient) {
      if (request.attempt >= 3) return { kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' }
      return { kind: 'retry', reasonCode: transient.reasonCode, messages: request.messages, retryEvent: { attempt: request.attempt, code: transient.code }, recordTranscriptCompaction: false,
        maxAttempts: 3, ...(retryAfterMs(request.error) !== undefined ? { retryAfterMs: retryAfterMs(request.error) } : {}) }
    }
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
    // Provider 流空闲超时（评审后真机回归：DeepSeek /anthropic 对 tool_result 回传请求偶发挂起，
    // 15 分钟静默后 MODEL_PROVIDER_ERROR）。挂起的请求体本身无害：原样重发幂等（工具结果已在
    // 消息里，不会重复执行工具），不触发转录压缩；attempt 2 仍超时则拒绝（避免无限循环）。
    if (request.error instanceof ModelStreamIdleTimeoutError) {
      if (request.attempt > 1) return { kind: 'reject', reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT_RETRY_LIMIT' }
      return {
        kind: 'retry',
        reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT',
        messages: request.messages,
        retryEvent: { attempt: 1, code: 'provider_stream_idle_timeout' },
        recordTranscriptCompaction: false
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
