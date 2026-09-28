import { describe, expect, it } from 'vitest'

import {
  extractMcpInvocationSignal,
  summarizeMcpArgs,
} from './mcpPayloadExtractor'

describe('summarizeMcpArgs（R3 入参摘要）', () => {
  it('键名清单 + 归一 JSON 摘要；未超限时不标注截断', () => {
    const r = summarizeMcpArgs({ url: 'https://example.com', max_length: 100 })
    expect(r.argNames).toEqual(['url', 'max_length'])
    expect(r.argsTruncated).toBe(false)
    expect(JSON.parse(r.argsDigest)).toEqual({ url: 'https://example.com', max_length: 100 })
  })

  it('secret 类键只留键名不留值', () => {
    const r = summarizeMcpArgs({ token: 'ghp_abcdef', url: 'https://example.com' })
    const digest = JSON.parse(r.argsDigest) as Record<string, string>
    expect(digest.token).toBe('[REDACTED]')
    expect(digest.url).toBe('https://example.com')
  })

  it('argNames 超 20 项截断并标注', () => {
    const input: Record<string, unknown> = {}
    for (let i = 0; i < 25; i += 1) input[`k${i}`] = i
    const r = summarizeMcpArgs(input)
    expect(r.argNames).toHaveLength(20)
    expect(r.argsTruncated).toBe(true)
  })

  it('摘要超兜底上限截断并标注（防极端值，O5）', () => {
    const r = summarizeMcpArgs({ body: 'x'.repeat(20000) })
    expect(r.argsDigest.length).toBeLessThan(20000)
    expect(r.argsTruncated).toBe(true)
    expect(r.argsDigest.endsWith('…[truncated]')).toBe(true)
  })
})

describe('extractMcpInvocationSignal（R3 事实信号）', () => {
  it('注解安全：classificationBasis=annotations-readonly，actionClass=read，url 进入 targetUrl', () => {
    const sig = extractMcpInvocationSignal({
      serverId: 'srv1',
      toolName: 'fetch_url',
      toolInput: { url: 'https://example.com/data', max_length: 200 },
      annotationsSafe: true,
      inputSchema: {}
    })
    expect(sig.kind).toBe('mcp-invocation')
    if (sig.kind !== 'mcp-invocation') return
    expect(sig.actionClass).toBe('read')
    expect(sig.classificationBasis).toBe('annotations-readonly')
    expect(sig.targetUrl).toBe('https://example.com/data')
    expect(sig.argNames).toEqual(['url', 'max_length'])
  })

  it('无注解 + method GET：仍按 write 兜底但标注 schema-heuristic（只标注不改宽严）', () => {
    const sig = extractMcpInvocationSignal({
      serverId: 'srv1',
      toolName: 'get_page',
      toolInput: { url: 'https://example.com', method: 'GET' },
      annotationsSafe: false,
      inputSchema: {}
    })
    if (sig.kind !== 'mcp-invocation') return
    expect(sig.actionClass).toBe('write')
    expect(sig.classificationBasis).toBe('schema-heuristic')
  })

  it('其余默认 default-write；path 进 targetPath', () => {
    const sig = extractMcpInvocationSignal({
      serverId: 'srv1',
      toolName: 'write_thing',
      toolInput: { path: 'C:\\tmp\\x.txt', content: 'abc' },
      annotationsSafe: false,
      inputSchema: {}
    })
    if (sig.kind !== 'mcp-invocation') return
    expect(sig.actionClass).toBe('write')
    expect(sig.classificationBasis).toBe('default-write')
    expect(sig.targetPath).toBe('C:\\tmp\\x.txt')
    expect(sig.targetUrl).toBeUndefined()
  })
})
