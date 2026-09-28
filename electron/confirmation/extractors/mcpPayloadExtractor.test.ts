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

describe('E1（评审 2026-09-28）：嵌套对象/数组中的 secret 递归脱敏', () => {
  it('headers.Authorization 深层键脱敏', () => {
    const r = summarizeMcpArgs({ headers: { Authorization: 'sk-ant-supersecret', 'Content-Type': 'application/json' } })
    const digest = JSON.parse(r.argsDigest) as { headers: Record<string, string> }
    expect(digest.headers.Authorization).toBe('[REDACTED]')
    expect(digest.headers['Content-Type']).toBe('application/json')
    expect(r.argsDigest).not.toContain('sk-ant-supersecret')
  })

  it('auth.token / config.api_key 任意深度键脱敏', () => {
    const r = summarizeMcpArgs({ auth: { token: 'ghp_supersecret' }, config: { api_key: 'AKIA-supersecret' } })
    expect(r.argsDigest).not.toContain('ghp_supersecret')
    expect(r.argsDigest).not.toContain('AKIA-supersecret')
    expect(r.argsDigest).toContain('[REDACTED]')
  })

  it('apiKeys 数组：键名命中 secret 正则时整个值替换（不逐项泄露）', () => {
    const r = summarizeMcpArgs({ apiKeys: ['sk-1-supersecret', 'sk-2-supersecret'] })
    expect(r.argsDigest).not.toContain('sk-1-supersecret')
    expect(r.argsDigest).not.toContain('sk-2-supersecret')
    expect(r.argsDigest).toContain('[REDACTED]')
  })

  it('普通嵌套数据不受影响', () => {
    const r = summarizeMcpArgs({ user: { name: 'alice', tags: ['a', 'b'] }, page: 2 })
    const digest = JSON.parse(r.argsDigest) as { user: { name: string; tags: string[] }; page: number }
    expect(digest.user.name).toBe('alice')
    expect(digest.user.tags).toEqual(['a', 'b'])
    expect(digest.page).toBe(2)
  })
})
