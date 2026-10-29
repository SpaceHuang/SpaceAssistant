import { decideOverflowRecovery, detectSilentContextOverflow, selectRecoveryMessages } from '../../src/shared/overflowRecovery'
import type { CanonicalModelMessage, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import { ModelStreamIdleTimeoutError } from '../../packages/agent-sdk/src/model'
import { isOutputConfigRejectedError, memoizeEffortUnsupported } from '../effortFallback'

type RecoveryInput = Readonly<{
  error?: unknown
  response?: Readonly<{ finishReason: 'stop' | 'tool-calls' | 'length' | 'cancelled'; usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }; hasOutputContent: boolean }>
  attempt: number
  attemptInRequest?: number
  recoveryCounts?: Readonly<{ transient: number; idleTimeout: number; overflow: number; effort: number }>
  waitBudgetRemainingMs?: number
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
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined
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
  random?: () => number
  now?: () => number
}): (request: RecoveryInput) => Promise<Readonly<{ kind?: 'retry'; reasonCode: string; messages: readonly CanonicalModelMessage[]; retryEvent?: Readonly<{ attempt: number; code: string }>; maxAttempts?: number; retryAfterMs?: number; plannedWaitMs?: number; recoveryKind?: 'transient' | 'idle-timeout' | 'overflow' | 'effort'; requestPatch?: Partial<Pick<PreparedModelCall['request'], 'thinking' | 'maxTokens'>>; recordTranscriptCompaction?: boolean } | { kind: 'reject'; reasonCode: string; serverAskedMs?: number; retryAt?: number }> | undefined> {
  return async (request) => {
    const transient = request.error ? transientProviderError(request.error) : undefined
    if (transient) {
      const attempt = request.attemptInRequest ?? request.attempt
      if (attempt >= 5) return { kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' }
      const recoveryCount = request.recoveryCounts?.transient ?? Math.max(0, attempt - 1)
      const localBackoff = Math.min(8_000, 500 * (2 ** recoveryCount))
      const randomValue = Math.min(1, Math.max(0, (input.random ?? Math.random)()))
      const jitterMs = Math.floor(localBackoff * randomValue)
      const now = (input.now ?? Date.now)()
      const serverAskedMs = retryAfterMs(request.error, now)
      const serverWaitMs = serverAskedMs ?? 0
      const plannedWaitMs = Math.max(jitterMs, serverWaitMs)
      if (plannedWaitMs > 60_000) return {
        kind: 'reject', reasonCode: 'PROVIDER_RETRY_AFTER_EXCEEDS_SINGLE_CAP',
        ...(serverAskedMs !== undefined ? { serverAskedMs, retryAt: now + serverAskedMs } : {})
      }
      return { kind: 'retry', reasonCode: transient.reasonCode, messages: request.messages, retryEvent: { attempt: request.attempt, code: transient.code }, recordTranscriptCompaction: false,
        maxAttempts: 5, plannedWaitMs, recoveryKind: 'transient', ...(serverAskedMs !== undefined ? { retryAfterMs: serverAskedMs, serverAskedMs, retryAt: now + serverAskedMs } : {}) }
    }
    const recoveryCounts = request.recoveryCounts
    if ((recoveryCounts?.effort ?? (request.attempt > 1 ? 1 : 0)) < 1 && request.request?.thinking?.effort && isOutputConfigRejectedError(request.error)) {
      if ((request.attemptInRequest ?? request.attempt) >= 5) return { kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' }
      memoizeEffortUnsupported(input.llmServiceId, input.model ?? request.routeId)
      await input.onEffortUnsupported?.(request.error)
      return {
        kind: 'retry',
        reasonCode: 'EFFORT_UNSUPPORTED',
        messages: request.messages,
        requestPatch: { thinking: { enabled: request.request.thinking.enabled } },
        recordTranscriptCompaction: false,
        retryEvent: { attempt: request.attempt, code: 'effort_unsupported' },
        maxAttempts: 5,
        recoveryKind: 'effort', plannedWaitMs: 0
      }
    }
    // Provider 流空闲超时（评审后真机回归：DeepSeek /anthropic 对 tool_result 回传请求偶发挂起，
    // 15 分钟静默后 MODEL_PROVIDER_ERROR）。挂起的请求体本身无害：原样重发幂等（工具结果已在
    // 消息里，不会重复执行工具），不触发转录压缩；attempt 2 仍超时则拒绝（避免无限循环）。
    if (request.error instanceof ModelStreamIdleTimeoutError) {
      if ((recoveryCounts?.idleTimeout ?? (request.attempt > 1 ? 1 : 0)) >= 1) return { kind: 'reject', reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT_RETRY_LIMIT' }
      if ((request.attemptInRequest ?? request.attempt) >= 5) return { kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' }
      return {
        kind: 'retry',
        reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT',
        messages: request.messages,
        retryEvent: { attempt: request.attempt, code: 'provider_stream_idle_timeout' },
        recordTranscriptCompaction: false, maxAttempts: 5, recoveryKind: 'idle-timeout', plannedWaitMs: 0
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
      retries: recoveryCounts?.overflow ?? Math.max(0, request.attempt - 1),
      maxRetries: 1,
      inFlightToolCount: 0,
      safeBoundary: true
    })
    if (decision.action !== 'reset_and_retry_provider') {
      if (silentOverflow.overflow) return { kind: 'reject', reasonCode: decision.reason === 'retry_limit' ? 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT' : 'SILENT_CONTEXT_OVERFLOW_UNSAFE_BOUNDARY' }
      return undefined
    }
    if ((request.attemptInRequest ?? request.attempt) >= 5) return { kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' }
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
      retryEvent: { attempt: request.attempt, code: 'provider_context_overflow' },
      recordTranscriptCompaction: true, maxAttempts: 5, recoveryKind: 'overflow', plannedWaitMs: 0
    }
  }
}
