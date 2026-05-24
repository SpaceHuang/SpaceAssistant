import { describe, expect, it } from 'vitest'
import { sanitizeForLog } from './sanitize'

describe('sanitizeForLog', () => {
  it('redacts sensitive keys', () => {
    const result = sanitizeForLog({
      apiKey: 'sk-ant-api03-secret',
      password: 'p@ss',
      nested: { secret: 'value', safe: 'ok' }
    }) as Record<string, unknown>

    expect(result.apiKey).toBe('[REDACTED]')
    expect(result.password).toBe('[REDACTED]')
    expect((result.nested as Record<string, unknown>).secret).toBe('[REDACTED]')
    expect((result.nested as Record<string, unknown>).safe).toBe('ok')
  })

  it('redacts anthropic key patterns in strings', () => {
    const input = 'Authorization failed for sk-ant-api03-abc123xyz token'
    expect(sanitizeForLog(input)).toBe('Authorization failed for [REDACTED] token')
  })

  it('redacts bearer tokens in strings', () => {
    const input = 'Header: Bearer eyJhbGciOiJIUzI1NiJ9.payload'
    expect(sanitizeForLog(input)).toBe('Header: Bearer [REDACTED]')
  })

  it('truncates long strings with metadata', () => {
    const long = '长文本'.repeat(100)
    const result = sanitizeForLog(long, { maxStringLength: 50 }) as Record<string, unknown>
    expect(result._truncated).toBe(true)
    expect(result._originalLength).toBe(300)
    expect((result._value as string).length).toBe(50)
  })

  it('handles arrays and preserves non-sensitive values', () => {
    const result = sanitizeForLog([{ token: 'abc' }, 'safe text']) as unknown[]
    expect((result[0] as Record<string, unknown>).token).toBe('[REDACTED]')
    expect(result[1]).toBe('safe text')
  })

  it('redacts llmServiceKeys map values', () => {
    const result = sanitizeForLog({
      llmServiceKeys: {
        'svc-1': 'sk-ant-api03-secret-key-value'
      }
    }) as Record<string, unknown>
    const keys = result.llmServiceKeys as Record<string, unknown>
    expect(keys['svc-1']).toBe('[REDACTED]')
  })
})
