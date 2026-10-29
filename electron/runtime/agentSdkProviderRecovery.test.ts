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
    expect(result).toEqual({ kind: 'retry', reasonCode: 'PROVIDER_CONTEXT_OVERFLOW', messages: [messages[2]], retryEvent: { attempt: 1, code: 'provider_context_overflow' }, recordTranscriptCompaction: true, recoveryKind: 'overflow', plannedWaitMs: 0, maxAttempts: 5 })
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
      retryEvent: { attempt: 1, code: 'provider_context_overflow' }, recordTranscriptCompaction: true, recoveryKind: 'overflow', plannedWaitMs: 0, maxAttempts: 5
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
    expect(result).toEqual({ kind: 'retry', reasonCode: 'SILENT_CONTEXT_OVERFLOW', messages: [messages[2]], retryEvent: { attempt: 1, code: 'provider_context_overflow' }, recordTranscriptCompaction: true, recoveryKind: 'overflow', plannedWaitMs: 0, maxAttempts: 5 })
  })

  it('does not infer silent overflow from an untrusted context window', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: false })
    const result = await recover({
      response: { finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 0 }, hasOutputContent: true },
      attempt: 1, modelTurn: 1, routeId: 'route', messages
    })
    expect(result).toBeUndefined()
  })

  it('retries rate limits and rejects a second context overflow attempt', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const rateLimit = await recover({ error: Object.assign(new Error('rate limit'), { status: 429 }), attempt: 1, modelTurn: 1, routeId: 'r', messages })
    const secondOverflow = await recover({ response: { finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 0 }, hasOutputContent: true }, attempt: 2, modelTurn: 1, routeId: 'r', messages })
    expect(rateLimit).toMatchObject({ kind: 'retry', reasonCode: 'PROVIDER_RATE_LIMIT', maxAttempts: 5 })
    expect(secondOverflow).toEqual({ kind: 'reject', reasonCode: 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT' })
  })

  it('对有限次数的瞬时 provider 错误给出 Retry-After 等待并拒绝认证错误', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const rateLimit = await recover({ error: Object.assign(new Error('busy'), { status: 429, headers: { 'retry-after': '2' } }), attempt: 1, modelTurn: 1, routeId: 'r', messages })
    const server = await recover({ error: Object.assign(new Error('unavailable'), { status: 503 }), attempt: 2, modelTurn: 1, routeId: 'r', messages })
    const exhausted = await recover({ error: Object.assign(new Error('unavailable'), { status: 503 }), attempt: 5, attemptInRequest: 5, recoveryCounts: { transient: 4, idleTimeout: 0, overflow: 0, effort: 0 }, modelTurn: 1, routeId: 'r', messages })
    const auth = await recover({ error: Object.assign(new Error('unauthorized'), { status: 401 }), attempt: 1, modelTurn: 1, routeId: 'r', messages })
    expect(rateLimit).toMatchObject({ kind: 'retry', reasonCode: 'PROVIDER_RATE_LIMIT', retryAfterMs: 2000, maxAttempts: 5, recoveryKind: 'transient' })
    expect(server).toMatchObject({ kind: 'retry', reasonCode: 'PROVIDER_SERVER_ERROR', maxAttempts: 5, recoveryKind: 'transient' })
    expect(exhausted).toEqual({ kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' })
    expect(auth).toBeUndefined()
  })

  it('为瞬时故障返回有界全抖动等待和恢复分类，并允许最多五次物理尝试', async () => {
    const recover = createAgentSdkProviderRecovery({ random: () => 0.5 })
    const first = await recover({ error: Object.assign(new Error('busy'), { status: 503 }), attempt: 1, attemptInRequest: 1, recoveryCounts: { transient: 0, idleTimeout: 0, overflow: 0, effort: 0 }, waitBudgetRemainingMs: 60_000, modelTurn: 1, routeId: 'r', messages })
    const fourth = await recover({ error: Object.assign(new Error('busy'), { status: 503 }), attempt: 4, attemptInRequest: 4, recoveryCounts: { transient: 3, idleTimeout: 0, overflow: 0, effort: 0 }, waitBudgetRemainingMs: 60_000, modelTurn: 1, routeId: 'r', messages })
    const fifth = await recover({ error: Object.assign(new Error('busy'), { status: 503 }), attempt: 5, attemptInRequest: 5, recoveryCounts: { transient: 4, idleTimeout: 0, overflow: 0, effort: 0 }, waitBudgetRemainingMs: 60_000, modelTurn: 1, routeId: 'r', messages })
    expect(first).toMatchObject({ kind: 'retry', maxAttempts: 5, recoveryKind: 'transient', plannedWaitMs: 250 })
    expect(fourth).toMatchObject({ kind: 'retry', maxAttempts: 5, recoveryKind: 'transient', plannedWaitMs: 2000 })
    expect(fifth).toEqual({ kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' })
  })

  it('允许注入时钟解析 Retry-After HTTP-date，并用注入随机源固定抖动', async () => {
    const now = Date.parse('2026-10-30T00:00:00.000Z')
    const recover = createAgentSdkProviderRecovery({ now: () => now, random: () => 0 })
    const result = await recover({
      error: Object.assign(new Error('busy'), { status: 429, headers: { 'Retry-After': new Date(now + 1000).toUTCString() } }),
      attempt: 1, attemptInRequest: 1, recoveryCounts: { transient: 0, idleTimeout: 0, overflow: 0, effort: 0 },
      waitBudgetRemainingMs: 60_000, modelTurn: 1, routeId: 'r', messages
    })
    expect(result).toMatchObject({ kind: 'retry', recoveryKind: 'transient', plannedWaitMs: 1000, retryAfterMs: 1000 })
  })

  it('保留 45 秒 Retry-After 原值并计划精确等待', async () => {
    const now = Date.parse('2026-10-30T00:00:00.000Z')
    const recover = createAgentSdkProviderRecovery({ now: () => now, random: () => 0 })
    const result = await recover({
      error: Object.assign(new Error('busy'), { status: 429, headers: { 'retry-after': '45' } }),
      attempt: 1, attemptInRequest: 1, recoveryCounts: { transient: 0, idleTimeout: 0, overflow: 0, effort: 0 },
      waitBudgetRemainingMs: 60_000, modelTurn: 1, routeId: 'r', messages
    })
    expect(result).toMatchObject({ kind: 'retry', retryAfterMs: 45_000, plannedWaitMs: 45_000 })
  })

  it('拒绝超过 60 秒单次上限并回传原始服务端等待和 retryAt', async () => {
    const now = Date.parse('2026-10-30T00:00:00.000Z')
    const recover = createAgentSdkProviderRecovery({ now: () => now, random: () => 0 })
    const result = await recover({
      error: Object.assign(new Error('busy'), { status: 429, headers: { 'retry-after': '120' } }),
      attempt: 1, attemptInRequest: 1, recoveryCounts: { transient: 0, idleTimeout: 0, overflow: 0, effort: 0 },
      waitBudgetRemainingMs: 60_000, modelTurn: 1, routeId: 'r', messages
    })
    expect(result).toEqual({ kind: 'reject', reasonCode: 'PROVIDER_RETRY_AFTER_EXCEEDS_SINGLE_CAP', serverAskedMs: 120_000, retryAt: now + 120_000 })
  })

  it('为 effort、空闲超时与溢出分别计数，同时受共享物理尝试上限约束', async () => {
    const recover = createAgentSdkProviderRecovery({ contextWindow: 100, contextWindowTrusted: true })
    const afterTransient = { transient: 1, idleTimeout: 0, overflow: 0, effort: 0 }
    const idle = await recover({ error: new ModelStreamIdleTimeoutError(120_000), attempt: 2, attemptInRequest: 2, recoveryCounts: afterTransient, waitBudgetRemainingMs: 0, modelTurn: 1, routeId: 'r', messages })
    const overflow = await recover({ error: Object.assign(new Error('context length exceeded'), { type: 'context_length_exceeded' }), attempt: 2, attemptInRequest: 2, recoveryCounts: { ...afterTransient, idleTimeout: 1 }, waitBudgetRemainingMs: 0, modelTurn: 1, routeId: 'r', messages })
    const overflowUsed = await recover({ response: { finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 0 }, hasOutputContent: true }, attempt: 3, attemptInRequest: 3, recoveryCounts: { ...afterTransient, idleTimeout: 1, overflow: 1 }, waitBudgetRemainingMs: 0, modelTurn: 1, routeId: 'r', messages })
    const physicalLimit = await recover({ error: new ModelStreamIdleTimeoutError(120_000), attempt: 5, attemptInRequest: 5, recoveryCounts: afterTransient, waitBudgetRemainingMs: 0, modelTurn: 1, routeId: 'r', messages })
    expect(idle).toMatchObject({ kind: 'retry', recoveryKind: 'idle-timeout', maxAttempts: 5, plannedWaitMs: 0 })
    expect(overflow).toMatchObject({ kind: 'retry', recoveryKind: 'overflow', maxAttempts: 5, plannedWaitMs: 0 })
    expect(overflowUsed).toEqual({ kind: 'reject', reasonCode: 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT' })
    expect(physicalLimit).toEqual({ kind: 'reject', reasonCode: 'PROVIDER_RETRY_EXHAUSTED' })
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
      retryEvent: { attempt: 1, code: 'provider_stream_idle_timeout' }, recordTranscriptCompaction: false, recoveryKind: 'idle-timeout', plannedWaitMs: 0, maxAttempts: 5
    })
    const second = await recover({
      error: idleError, attempt: 2, modelTurn: 2, routeId: 'deepseek-main', messages
    })
    expect(second).toEqual({ kind: 'reject', reasonCode: 'PROVIDER_STREAM_IDLE_TIMEOUT_RETRY_LIMIT' })
  })
})
