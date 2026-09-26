import { describe, expect, it } from 'vitest'
import { decideOverflowRecovery, detectSilentContextOverflow, isProviderContextOverflow, selectRecoveryMessages } from './overflowRecovery'

describe('provider overflow recovery', () => {
  it('detects silent overflow using shared cache semantics', () => {
    expect(detectSilentContextOverflow({ stopReason: 'end_turn', contextWindow: 150_000, contextWindowTrusted: true, usage: { input_tokens: 100_000, cache_read_input_tokens: 80_000, cacheSemantics: 'subset' } }))
      .toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'end_turn', contextWindow: 150_000, contextWindowTrusted: true, usage: { input_tokens: 100_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 20_000, cacheSemantics: 'additive' } }))
      .toEqual({ overflow: true, kind: 'usage-exceeds-window', inputTokens: 160_000, contextWindow: 150_000 })
  })

  it('detects full-window zero-output truncation and rejects untrusted inputs', () => {
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 100_000, contextWindowTrusted: true, usage: { input_tokens: 99_000, output_tokens: 0, cacheSemantics: 'subset' } }))
      .toEqual({ overflow: true, kind: 'truncated-input', inputTokens: 99_000, contextWindow: 100_000 })
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 100_000, contextWindowTrusted: true, usage: { input_tokens: 99_000, output_tokens: 1 } })).toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 100_000, contextWindowTrusted: true, usage: { input_tokens: 99_000 } })).toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 100_000, contextWindowTrusted: true, usage: { input_tokens: 99_000, output_tokens: 0 }, hasOutputContent: true })).toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'end_turn', contextWindow: 200_000, contextWindowTrusted: true, usage: { input_tokens: 300_001 } }))
      .toEqual({ overflow: true, kind: 'usage-exceeds-window', inputTokens: 300_001, contextWindow: 200_000 })
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 100_000, contextWindowTrusted: true, usage: { input_tokens: 50_000, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 24_500, cacheSemantics: 'additive', output_tokens: 0 } }))
      .toEqual({ overflow: true, kind: 'truncated-input', inputTokens: 99_500, contextWindow: 100_000 })
    for (const contextWindow of [undefined, 0, -1]) {
      expect(detectSilentContextOverflow({ stopReason: 'end_turn', contextWindow, contextWindowTrusted: true, usage: { input_tokens: 300_000 } })).toEqual({ overflow: false })
    }
    expect(detectSilentContextOverflow({ stopReason: 'end_turn', contextWindow: 200_000, contextWindowTrusted: false, usage: { input_tokens: 300_000 } })).toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 200_000, contextWindowTrusted: true, usage: { input_tokens: 198_000, output_tokens: 0 } }))
      .toEqual({ overflow: true, kind: 'truncated-input', inputTokens: 198_000, contextWindow: 200_000 })
    expect(detectSilentContextOverflow({ stopReason: 'max_tokens', contextWindow: 200_000, contextWindowTrusted: false, usage: { input_tokens: 198_000, output_tokens: 0 } })).toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'tool_use', contextWindow: 100_000, contextWindowTrusted: true, usage: { input_tokens: 200_000 } })).toEqual({ overflow: false })
    expect(detectSilentContextOverflow({ stopReason: 'end_turn', contextWindow: 1, usage: { input_tokens: 100 } })).toEqual({ overflow: false })
  })
  it('retries only the provider after a safe boundary', () => {
    expect(decideOverflowRecovery({ error: new Error('prompt token limit exceeded'), retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true })).toEqual({ action: 'reset_and_retry_provider', nextRetry: 1 })
  })
  it('waits while tools are in flight and never retries tools', () => {
    expect(decideOverflowRecovery({ error: 'context window exceeded', retries: 0, maxRetries: 1, inFlightToolCount: 1, safeBoundary: false })).toEqual({ action: 'wait_for_tools', reason: 'in_flight' })
  })
  it('does not retry unrelated errors or exceed the retry budget', () => {
    expect(decideOverflowRecovery({ error: 'network unavailable', retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true }).action).toBe('ignore')
    expect(decideOverflowRecovery({ error: 'context length exceeded', retries: 1, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true })).toEqual({ action: 'ignore', reason: 'retry_limit' })
  })
  it('does not classify rate and quota limits as context overflow', () => {
    expect(decideOverflowRecovery({ error: 'rate limit exceeded: 30000 input tokens per minute', retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true }).action).toBe('ignore')
    expect(decideOverflowRecovery({ error: 'quota exceeded for tokens', retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true }).action).toBe('ignore')
  })
  it('prefers structured provider status and error type', () => {
    expect(isProviderContextOverflow({ status: 429, type: 'context_length_exceeded', message: 'retry later' })).toBe(false)
    expect(isProviderContextOverflow({ status: 400, type: 'context_length_exceeded', message: 'input too long' })).toBe(true)
  })
  it('does not reset for max_tokens parameter errors', () => {
    expect(isProviderContextOverflow({ status: 400, type: 'invalid_request_error', message: 'max_tokens: 64000 exceeds model limit of 8192' })).toBe(false)
    expect(isProviderContextOverflow('invalid max tokens, maximum is 8192')).toBe(false)
    expect(decideOverflowRecovery({ error: 'invalid max tokens, maximum is 8192', retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true }).action).toBe('ignore')
  })
  it('recognizes common context-length errors even when they mention maximum tokens', () => {
    for (const error of [
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
      'maximum context window is 8192 tokens',
      'prompt exceeds maximum context length of 8192 tokens'
    ]) expect(isProviderContextOverflow({ status: 400, type: 'invalid_request_error', message: error })).toBe(true)
  })
  it('keeps current input and completed tool results in the recovery surface', () => {
    const messages = [{ id: 'old', role: 'user', content: 'old' }, { id: 'current', role: 'user', content: 'current' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }] as const
    expect(selectRecoveryMessages(messages, 'current').map((message) => message.id ?? 'tool-results')).toEqual(['current', 'tool-results'])
  })
  it('drops old tool rounds while retaining the current turn', () => {
    const messages = [
      { id: 'old-user', role: 'user', content: 'old' },
      { id: 'old-tool-use', role: 'assistant', content: [{ type: 'tool_use', id: 'old-tool', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'x'.repeat(100_000) }] },
      { id: 'current', role: 'user', content: 'current' },
      { id: 'new-tool-use', role: 'assistant', content: [{ type: 'tool_use', id: 'new-tool', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new-tool', content: 'new result' }] }
    ] as const
    const recovered = selectRecoveryMessages(messages, 'current')
    expect(recovered.map((message) => message.id ?? 'tool-result')).toEqual(['current', 'new-tool-use', 'tool-result'])
    expect(JSON.stringify(recovered)).not.toContain('old-tool')
    expect(JSON.stringify(recovered)).toContain('new result')
  })
})
