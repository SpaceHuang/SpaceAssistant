import { describe, expect, it } from 'vitest'
import { maskSensitiveMarkdownText, maskSensitiveText, maskSensitiveValue } from './mcpSensitiveText'

describe('maskSensitiveText', () => {
  it('masks MCP credential patterns without dropping surrounding text', () => {
    const result = maskSensitiveText('answer sk-live_123 ghp_abc xoxb-123 glpat-token')
    expect(result).toContain('answer')
    expect(result).not.toContain('sk-live_123')
    expect(result).not.toContain('ghp_abc')
    expect(result).not.toContain('xoxb-123')
    expect(result).not.toContain('glpat-token')
  })

  it('masks bearer, JWT and long hex tokens', () => {
    const result = maskSensitiveText('Bearer abc.def.ghi jwt eyJhbGciOiJIUzI1NiJ9.abc.def deadbeefdeadbeefdeadbeefdeadbeef')
    expect(result).toBe('Bearer <secret:redacted> jwt <secret:redacted> <secret:redacted>')
  })

  it('masks non-Bearer Authorization credentials while retaining the scheme', () => {
    const result = maskSensitiveText('Authorization: Basic dXNlcjpwYXNzd29yZA==')
    expect(result).toBe('Authorization: Basic <secret:redacted>')
  })

  it('masks arbitrary Authorization schemes and structured header values', () => {
    const result = maskSensitiveValue({ headers: { Authorization: 'Negotiate YIIFZGVtbw==' } })
    expect(JSON.stringify(result)).toBe('{"headers":{"Authorization":"Negotiate <secret:redacted>"}}')
  })
  it('masks inline Basic headers and the complete Digest credential payload', () => {
    expect(maskSensitiveText('request Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      'request Authorization: Basic <secret:redacted>'
    )
    expect(maskSensitiveText('Authorization: Digest username="alice", realm="private", nonce="secret", response="hash"')).toBe(
      'Authorization: Digest <secret:redacted>'
    )
  })
  it('masks serialized and inline authorization headers without leaving fields behind', () => {
    expect(maskSensitiveText('Authorization: Digest username="demo", realm="example", nonce="nonce-demo", uri="/", response="digest-response-demo", cnonce="cnonce-demo"')).not.toContain('digest-response-demo')
    expect(maskSensitiveText('headers={"Authorization":"Digest username=demo, response=digest-response-demo, nonce=nonce-demo"}')).not.toContain('digest-response-demo')
    expect(maskSensitiveText('request headers: Authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNzd29yZA==')
  })
  it('does not delete JSON fields or links after an inline Basic credential', () => {
    const json = '{"note":"request Authorization: Basic dXNlcjpwYXNzd29yZA==","answer":"业务答案","count":42}'
    const masked = maskSensitiveText(json)
    expect(JSON.parse(masked)).toMatchObject({ answer: '业务答案', count: 42 })
    expect(maskSensitiveText('请求 Authorization: Basic dXNlcjpwYXNzd29yZA==；下载 [业务报告](https://example.test/report)。')).toContain('[业务报告]')
  })
  it('masks non-whitelisted schemes while preserving following Markdown content', () => {
    expect(maskSensitiveText('request Authorization: Custom credential-123; answer')).toBe(
      'request Authorization: Custom <secret:redacted>; answer'
    )
  })
  it('masks many credentials with linear output assembly', () => {
    const input = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890 '.repeat(4096)
    const started = performance.now()
    const masked = maskSensitiveText(input)
    expect(masked).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('recursively masks strings in structured values', () => {
    expect(maskSensitiveValue({ nested: ['ok', 'ghp_secret'], count: 2 })).toEqual({
      nested: ['ok', '<secret:redacted>'], count: 2
    })
  })

  it('masks entity-encoded credentials without decoding Markdown business entities', () => {
    const result = maskSensitiveMarkdownText('## ghp&#95;abcdefghijklmnopqrstuvwxyz1234567890\n| a&#124;b |')
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    expect(result).toContain('a&#124;b')
  })

  it('preserves distinct sensitive object keys without collision', () => {
    const result = maskSensitiveValue({
      ghp_abcdefghijklmnopqrstuvwxyz1234567890: 'first-entry',
      ghp_zyxwvkjihgfedcba0987654321: 'second-entry'
    }) as Record<string, string>
    expect(Object.keys(result)).toHaveLength(2)
    expect(result['ghp_abcdefghijklmnopqrstuvwxyz1234567890']).toBe('first-entry')
    expect(result['ghp_zyxwvkjihgfedcba0987654321']).toBe('second-entry')
  })
})
