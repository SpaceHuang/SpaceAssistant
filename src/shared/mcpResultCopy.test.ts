import { describe, expect, it } from 'vitest'
import { buildMcpCopyText } from './mcpResultCopy'

describe('buildMcpCopyText', () => {
  it('copies readable text and structured data, never protocol wrappers', () => {
    expect(buildMcpCopyText({ text: 'hello', structured: { ok: true } }, 1024).text).toContain('hello')
    expect(buildMcpCopyText({ text: 'hello', structured: { ok: true } }, 1024).text).toContain('"ok": true')
  })

  it('truncates at a valid UTF-8 boundary and reports truncation', () => {
    const result = buildMcpCopyText({ text: '你好'.repeat(100) }, 21)
    expect(result.text).toBe('你\n[结果已截断]')
    expect(result.truncated).toBe(true)
  })

  it('copies bounded structuredText and preserves upstream truncation state', () => {
    const result = buildMcpCopyText({ structuredText: '{"safe":true}', structuredTruncated: true }, 1024)
    expect(result.text).toContain('safe')
    expect(result.text).toContain('结果已截断')
    expect(result.truncated).toBe(true)
  })

  it('copies readable metadata for resource-only results', () => {
    const result = buildMcpCopyText({ blocks: [{ kind: 'resource', name: 'report', uri: 'https://example.test/report' }] }, 1024)
    expect(result.text).toContain('report')
    expect(result.text).toContain('https://example.test/report')
  })
})
