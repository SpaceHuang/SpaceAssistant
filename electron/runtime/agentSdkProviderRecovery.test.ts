import { describe, expect, it, vi } from 'vitest'
import { createAgentSdkProviderRecovery } from './agentSdkProviderRecovery'
import { isEffortUnsupportedByUpstream, resetEffortMemoForTests } from '../effortFallback'
import { ModelStreamIdleTimeoutError } from '../../packages/agent-sdk/src/model'

describe('createAgentSdkProviderRecovery', () => {
  it('retries output_config rejection without effort and remembers the model compatibility', async () => {
    resetEffortMemoForTests()
    const request = { messages, maxTokens: 1000, thinking: { enabled: true, effort: 'high' as const } }
    const onEffortUnsupported = vi.fn()
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true, model: 'claude-test', llmServiceId: 'svc-7', onEffortUnsupported })
    const result = await recover({
      error: Object.assign(new Error('unknown field output_config'), { status: 400 }),
      attempt: 1, modelTurn: 1, routeId: 'anthropic-main', messages, request,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: messages[2]! }
    })

    expect(result).toMatchObject({
      kind: 'retry', reasonCode: 'EFFORT_UNSUPPORTED', messages,
      requestPatch: { thinking: { enabled: true } }, recordTranscriptCompaction: false,
      retryEvent: { attempt: 1, code: 'effort_unsupported' }
    })
    expect(isEffortUnsupportedByUpstream('svc-7', 'claude-test')).toBe(true)
    expect(isEffortUnsupportedByUpstream(undefined, 'claude-test')).toBe(false)
    expect(onEffortUnsupported).toHaveBeenCalledOnce()
    resetEffortMemoForTests()
  })

  const messages = [
    { role: 'user' as const, content: 'old question' },
    { role: 'assistant' as const, content: 'old answer' },
    { role: 'user' as const, content: 'current question' }
  ]

  it('recovers only provider context overflow and preserves the current required user message', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const input = {
      error: Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' }),
      attempt: 1,
      modelTurn: 1,
      routeId: 'anthropic-main',
      messages,
      currentUserMessageId: 'user-current',
      requiredUserMessage: { id: 'user-current', message: messages[2]! }
    }
    const result = await recover(input)
    expect(result).toEqual({ kind: 'retry', reasonCode: 'PROVIDER_CONTEXT_OVERFLOW', messages: [messages[2]], retryEvent: { attempt: 1, code: 'provider_context_overflow' }, recordTranscriptCompaction: true })
  })

  it('从多轮工具后缀恢复时用 canonical required user 定位边界并保留后续工具对', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const currentUser = { role: 'user' as const, content: 'current question' }
    const toolAssistant = { role: 'assistant' as const, toolCalls: [{ id: 'read-1', name: 'read_file', input: { path: 'a.txt' } }] }
    const toolResult = { role: 'tool' as const, toolCallId: 'read-1', content: 'current evidence', isError: false }
    const multiRoundMessages = [messages[0]!, messages[1]!, currentUser, toolAssistant, toolResult]
    const result = await recover({
      error: Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' }),
      attempt: 1, modelTurn: 2, routeId: 'anthropic-main', messages: multiRoundMessages,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: currentUser }
    })

    expect(result).toEqual({
      kind: 'retry', reasonCode: 'PROVIDER_CONTEXT_OVERFLOW',
      messages: [currentUser, toolAssistant, toolResult],
      retryEvent: { attempt: 1, code: 'provider_context_overflow' }, recordTranscriptCompaction: true
    })
  })

  it('discards a completed response whose trusted usage proves silent context overflow', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const result = await recover({
      response: { finishReason: 'stop', usage: { inputTokens: 80, outputTokens: 0, cacheReadInputTokens: 15, cacheCreationInputTokens: 6 }, hasOutputContent: true },
      attempt: 1, modelTurn: 2, routeId: 'anthropic-main', messages,
      currentUserMessageId: 'user-current',
      requiredUserMessage: { id: 'user-current', message: messages[2]! }
    })
    expect(result).toEqual({ kind: 'retry', reasonCode: 'SILENT_CONTEXT_OVERFLOW', messages: [messages[2]], retryEvent: { attempt: 1, code: 'provider_context_overflow' }, recordTranscriptCompaction: true })
  })

  it('does not infer silent overflow from an untrusted context window', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: false })
    const result = await recover({
      response: { finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 0 }, hasOutputContent: true },
      attempt: 1, modelTurn: 1, routeId: 'route', messages
    })
    expect(result).toBeUndefined()
  })

  it('does not retry rate limits or a second context overflow attempt', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const rateLimit = await recover({ error: Object.assign(new Error('rate limit'), { status: 429 }), attempt: 1, modelTurn: 1, routeId: 'r', messages })
    const secondOverflow = await recover({ response: { finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 0 }, hasOutputContent: true }, attempt: 2, modelTurn: 1, routeId: 'r', messages })
    expect(rateLimit).toBeUndefined()
    expect(secondOverflow).toEqual({ kind: 'reject', reasonCode: 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT' })
  })

  it('fails closed when recovery selection drops the required user message', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    await expect(recover({
      error: Object.assign(new Error('context length exceeded'), { type: 'context_length_exceeded' }),
      attempt: 1,
      modelTurn: 1,
      routeId: 'r',
      messages,
      currentUserMessageId: 'missing',
      requiredUserMessage: { id: 'missing', message: { role: 'user', content: 'not in request' } }
    })).rejects.toThrow('required user message')
  })

  it('provider 流空闲超时：attempt 1 原样重发重试（不压缩转录），attempt 2 拒绝', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const idleError = new ModelStreamIdleTimeoutError(120_000)
    const retry = await recover({
      error: idleError, attempt: 1, modelTurn: 2, routeId: 'deepseek-main', messages,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: messages[2]! }
    })
    // 挂起的请求体本身没有问题：原样重发（工具结果已在消息里，重试幂等），不触发转录压缩
    expect(retry).toEqual({
      kind: 'retry', reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT', messages,
      retryEvent: { attempt: 1, code: 'provider_stream_idle_timeout' }, recordTranscriptCompaction: false
    })
    const second = await recover({
      error: idleError, attempt: 2, modelTurn: 2, routeId: 'deepseek-main', messages
    })
    expect(second).toEqual({ kind: 'reject', reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT_RETRY_LIMIT' })
  })
})
