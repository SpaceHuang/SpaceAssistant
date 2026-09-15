import { describe, expect, it } from 'vitest'
import { decideOverflowRecovery, isProviderContextOverflow, selectRecoveryMessages } from './overflowRecovery'

describe('provider overflow recovery', () => {
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
