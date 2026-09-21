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

  it("redacts compound credential keys（评审 v2 S1）：accessToken/headerValue/API_TOKEN 等", () => {
    const result = sanitizeForLog({
      accessToken: 'ghp_secret_value',
      headerValue: 'Bearer xyz',
      nested: { API_TOKEN: 'tok_plain', DEBUG: 'verbose' }
    }) as Record<string, unknown>
    expect(result.accessToken).toBe('[REDACTED]')
    expect(result.headerValue).toBe('[REDACTED]')
    const nested = result.nested as Record<string, unknown>
    expect(nested.API_TOKEN).toBe('[REDACTED]')
    // DEBUG 不含凭据词，保留
    expect(nested.DEBUG).toBe('verbose')
  })

  it('env 键值表整体脱敏（toolkit.call 入参形态）', () => {
    const result = sanitizeForLog({
      env: { SECRET_TOKEN: 'tok-1', DEBUG: '1' }
    }) as Record<string, unknown>
    expect(result.env).toBe('[REDACTED]')
  })

  it('量化字段名含 token 词但非凭据 → 保留（v3 建议 2 / v4 建议 1 否定白名单，含驼峰）', () => {
    const result = sanitizeForLog({
      max_tokens: 8192,
      total_tokens: 1024,
      token_limit: 4096,
      maxTokens: 8192,
      tokenLimit: 4096
    }) as Record<string, unknown>
    expect(result.max_tokens).toBe(8192)
    expect(result.total_tokens).toBe(1024)
    expect(result.token_limit).toBe(4096)
    expect(result.maxTokens).toBe(8192)
    expect(result.tokenLimit).toBe(4096)
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
