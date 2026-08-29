import { describe, expect, it } from 'vitest'
import {
  MCP_SERVER_NAME_MAX,
  MCP_CALL_ARGS_MAX_BYTES,
  MCP_TOOLS_PER_ROUND_MAX,
  MCP_TIMEOUT_SEC_DEFAULT,
  MCP_TIMEOUT_SEC_MAX,
  MCP_TIMEOUT_SEC_MIN,
  deriveUniqueMappedToolName,
  detectSensitiveParamValue,
  generateMappedToolName,
  mcpToolNeedsConfirmation,
  maskSensitiveArgs,
  trimMcpToolsForBudget,
  sanitizeEndpointForDisplay,
  validateMcpCallArgs,
  McpServerProfileSchema,
  McpServerWriteInputSchema
} from './mcpTypes'

describe('mcpTypes schemas', () => {
  const baseProfile = {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'GitHub',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    stdio: {
      command: 'node',
      args: ['server.js'],
      env: [{ key: 'GITHUB_TOKEN', valuePresent: false }]
    },
    enabledToolNames: [],
    toolConfirmPolicy: 'always',
    status: 'untested',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z'
  }

  it('parses a valid server profile and applies defaults', () => {
    const parsed = McpServerProfileSchema.parse(baseProfile)
    expect(parsed.status).toBe('untested')
    expect(parsed.toolConfirmPolicy).toBe('always')
    expect(parsed.timeoutSec).toBe(60)
  })

  it('rejects an empty name', () => {
    expect(() => McpServerProfileSchema.parse({ ...baseProfile, name: '' })).toThrow()
  })

  it('rejects a name longer than the max', () => {
    expect(() => McpServerProfileSchema.parse({ ...baseProfile, name: 'x'.repeat(MCP_SERVER_NAME_MAX + 1) })).toThrow()
  })

  it('rejects duplicate tool names inside enabledToolNames', () => {
    expect(() =>
      McpServerProfileSchema.parse({ ...baseProfile, enabledToolNames: ['a', 'a'] })
    ).toThrow()
  })

  it('rejects an out-of-range timeout', () => {
    expect(() => McpServerProfileSchema.parse({ ...baseProfile, timeoutSec: MCP_TIMEOUT_SEC_MIN - 1 })).toThrow()
    expect(() => McpServerProfileSchema.parse({ ...baseProfile, timeoutSec: MCP_TIMEOUT_SEC_MAX + 1 })).toThrow()
  })

  it('rejects an invalid transport type', () => {
    expect(() => McpServerProfileSchema.parse({ ...baseProfile, transport: 'websocket' })).toThrow()
  })

  it('strips unknown fields on read profile (migration tolerance)', () => {
    const parsed = McpServerProfileSchema.parse({ ...baseProfile, unknownField: 123 })
    expect(parsed).not.toHaveProperty('unknownField')
  })

  it('rejects invalid env variable key names in stdio', () => {
    const bad = {
      ...baseProfile,
      stdio: { ...baseProfile.stdio, env: [{ key: '1BAD KEY', valuePresent: false }] }
    }
    expect(() => McpServerProfileSchema.parse(bad)).toThrow()
  })

  it('requires command when transport is stdio', () => {
    expect(() =>
      McpServerProfileSchema.parse({
        ...baseProfile,
        stdio: { command: '', args: [], env: [] }
      })
    ).toThrow()
  })

  it('requires endpoint when transport is streamable-http', () => {
    expect(() =>
      McpServerProfileSchema.parse({
        ...baseProfile,
        transport: 'streamable-http',
        stdio: undefined,
        http: { endpoint: '' }
      })
    ).toThrow()
  })

  it('accepts a legacy SSE profile with an http endpoint', () => {
    const parsed = McpServerProfileSchema.parse({
      ...baseProfile,
      transport: 'sse',
      stdio: undefined,
      http: { endpoint: 'https://example.com/sse' }
    })
    expect(parsed.transport).toBe('sse')
    expect(parsed.http?.endpoint).toBe('https://example.com/sse')
  })

  it('requires endpoint when transport is legacy SSE', () => {
    expect(() =>
      McpServerProfileSchema.parse({
        ...baseProfile,
        transport: 'sse',
        stdio: undefined,
        http: undefined
      })
    ).toThrow(/http required/)
  })
})

describe('mcpTypes write input schema', () => {
  const baseWriteInput = {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'GitHub',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'bearer-token', headerName: undefined, valuePrefix: undefined },
    stdio: {
      command: 'node',
      args: ['server.js'],
      env: [{ key: 'GITHUB_TOKEN', valuePresent: false, value: 'ghp_abc' }]
    },
    enabledToolNames: [],
    toolConfirmPolicy: 'always'
  }

  it('accepts a valid write input with one-time secrets', () => {
    const parsed = McpServerWriteInputSchema.parse({
      ...baseWriteInput,
      auth: { ...baseWriteInput.auth, accessToken: 'ghp_abc', headerValue: '' }
    })
    expect(parsed.auth.accessToken).toBe('ghp_abc')
  })

  it('rejects unknown fields (strict)', () => {
    expect(() => McpServerWriteInputSchema.parse({ ...baseWriteInput, status: 'connected' })).toThrow()
    expect(() => McpServerWriteInputSchema.parse({ ...baseWriteInput, secrets: { x: 1 } })).toThrow()
  })

  it('accepts a legacy SSE write input with an http endpoint', () => {
    const parsed = McpServerWriteInputSchema.parse({
      ...baseWriteInput,
      transport: 'sse',
      stdio: undefined,
      http: { endpoint: 'https://example.com/sse' }
    })
    expect(parsed.transport).toBe('sse')
    expect(parsed.http?.endpoint).toBe('https://example.com/sse')
  })

  it('requires endpoint when a legacy SSE write input omits http', () => {
    expect(() =>
      McpServerWriteInputSchema.parse({
        ...baseWriteInput,
        transport: 'sse',
        stdio: undefined,
        http: undefined
      })
    ).toThrow(/http required/)
  })

  it('rejects malformed env key names', () => {
    expect(() =>
      McpServerWriteInputSchema.parse({
        ...baseWriteInput,
        stdio: { ...baseWriteInput.stdio, env: [{ key: 'A-B', valuePresent: false }] }
      })
    ).toThrow()
  })
})

describe('generateMappedToolName', () => {
  it('produces mcp_<server>_<tool>_<hash> shape', () => {
    const name = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'create_issue' })
    expect(name).toMatch(/^mcp_github_create_issue_[0-9a-f]{8}$/)
  })

  it('is stable for the same inputs', () => {
    const a = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'create_issue' })
    const b = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'create_issue' })
    expect(a).toBe(b)
  })

  it('differs across servers with the same tool name', () => {
    const a = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'list_repos' })
    const b = generateMappedToolName({ serverId: 's2', serverName: 'GitHub', toolName: 'list_repos' })
    expect(a).not.toBe(b)
  })

  it('never exceeds 64 characters even for long names', () => {
    const name = generateMappedToolName({
      serverId: 's1',
      serverName: 'A very long server display name that should be truncated',
      toolName: 'an_even_longer_tool_name_that_definitely_exceeds_any_reasonable_limit'
    })
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/_([0-9a-f]{8})$/)
  })

  it('falls back to safe slugs for non-alphanumeric names', () => {
    const name = generateMappedToolName({ serverId: 's1', serverName: '!!! 中文 服务', toolName: '   ' })
    expect(name).toMatch(/^mcp_[a-z0-9_]+_[a-z0-9_]+_[0-9a-f]{8}$/)
  })
})

describe('deriveUniqueMappedToolName', () => {
  it('returns the base name when unused', () => {
    const base = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'create_issue' })
    expect(deriveUniqueMappedToolName(base, new Set())).toBe(base)
  })

  it('deterministically re-derives on hash collision and stays unique', () => {
    const base = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'create_issue' })
    const used = new Set([base])
    const first = deriveUniqueMappedToolName(base, used)
    expect(first).not.toBe(base)
    expect(first.length).toBeLessThanOrEqual(64)
    used.add(first)
    const second = deriveUniqueMappedToolName(base, used)
    expect(second).not.toBe(base)
    expect(second).not.toBe(first)
    expect(second.length).toBeLessThanOrEqual(64)
  })

  it('returns distinct names for many collisions', () => {
    const base = generateMappedToolName({ serverId: 's1', serverName: 'GitHub', toolName: 'create_issue' })
    const used = new Set([base])
    const out = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const next = deriveUniqueMappedToolName(base, used)
      expect(next.length).toBeLessThanOrEqual(64)
      expect(out.has(next)).toBe(false)
      out.add(next)
      used.add(next)
    }
  })
})

describe('sanitizeEndpointForDisplay', () => {
  it('strips userinfo, query and fragment', () => {
    expect(sanitizeEndpointForDisplay('https://user:pass@Example.COM:8443/mcp?token=abc#frag')).toBe(
      'https://example.com:8443/mcp'
    )
  })

  it('lowercases the host and keeps the path', () => {
    expect(sanitizeEndpointForDisplay('HTTPS://Api.GitHub.com/Path/')).toBe('https://api.github.com/Path/')
  })

  it('returns null for an invalid endpoint', () => {
    expect(sanitizeEndpointForDisplay('not a url')).toBeNull()
  })
})

describe('detectSensitiveParamValue', () => {
  it('detects sensitive flag patterns', () => {
    expect(detectSensitiveParamValue('--token abc').matched).toBe(true)
    expect(detectSensitiveParamValue('--api-key=sk-test').matched).toBe(true)
    expect(detectSensitiveParamValue('-p secret').matched).toBe(true)
  })

  it('detects common token formats', () => {
    expect(detectSensitiveParamValue('sk-ant-api03-xxxxxxxxxxxxxxxx').matched).toBe(true)
    expect(detectSensitiveParamValue('ghp_1234567890abcdef').matched).toBe(true)
    expect(detectSensitiveParamValue('xoxb-1234567890-abcdefgh').matched).toBe(true)
    expect(detectSensitiveParamValue('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def').matched).toBe(true)
  })

  it('detects Authorization header text', () => {
    expect(detectSensitiveParamValue('Authorization: Bearer abc').matched).toBe(true)
  })

  it('does not match ordinary text', () => {
    expect(detectSensitiveParamValue('python server.py --port 8080').matched).toBe(false)
  })
})

describe('maskSensitiveArgs', () => {
  it('masks values under sensitive keys recursively', () => {
    const masked = maskSensitiveArgs({
      apiKey: 'sk-ant-xxx',
      nested: { password: 'p@ss', keep: 'visible' },
      authorization: 'Bearer abc',
      query: 'SELECT 1'
    })
    expect(masked).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', keep: 'visible' },
      authorization: '[REDACTED]',
      query: 'SELECT 1'
    })
  })

  it('masks token-shaped string values even under ordinary keys', () => {
    const masked = maskSensitiveArgs({ token: 'sk-ant-api03-aaaaaaaa', plain: 'sk-ant-api03-bbbbbbbb' })
    expect(masked).toEqual({ token: '[REDACTED]', plain: '[REDACTED]' })
  })

  it('keeps arrays and ordinary values intact', () => {
    const masked = maskSensitiveArgs({ list: ['a', 'b'], count: 3, flag: true })
    expect(masked).toEqual({ list: ['a', 'b'], count: 3, flag: true })
  })
})

function makeToolDescriptor(name: string, extra: Record<string, unknown> = {}): import('./mcpTypes').McpToolDescriptor {
  return {
    serverId: 's1',
    originalName: name,
    mappedName: `mcp_s_${name}_12345678`,
    description: 'x'.repeat(100),
    inputSchema: { type: 'object' },
    discoveredAt: '2026-08-28T00:00:00.000Z',
    ...extra
  }
}

describe('trimMcpToolsForBudget', () => {
  it('keeps all tools under the budget', () => {
    const tools = [makeToolDescriptor('a'), makeToolDescriptor('b')]
    const result = trimMcpToolsForBudget(tools)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })

  it('trims by count in deterministic input order', () => {
    const tools = ['a', 'b', 'c', 'd'].map((n) => makeToolDescriptor(n))
    const result = trimMcpToolsForBudget(tools, { maxCount: 2 })
    expect(result.kept.map((t) => t.originalName)).toEqual(['a', 'b'])
    expect(result.dropped.map((t) => t.tool.originalName)).toEqual(['c', 'd'])
  })

  it('trims by total bytes', () => {
    const tools = [makeToolDescriptor('a'), makeToolDescriptor('b'), makeToolDescriptor('c')]
    const perTool = JSON.stringify(tools[0]).length
    const result = trimMcpToolsForBudget(tools, { maxTotalBytes: perTool * 2 + 10 })
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(1)
  })

  it('drops a single tool that exceeds the byte budget entirely', () => {
    const big = makeToolDescriptor('big', { description: 'y'.repeat(5000) })
    const result = trimMcpToolsForBudget([big], { maxTotalBytes: 1024 })
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
  })

  it('respects default limits (64 tools / 96 KiB)', () => {
    const tools = Array.from({ length: 70 }, (_, i) => makeToolDescriptor(`t${i}`))
    const result = trimMcpToolsForBudget(tools)
    expect(result.kept).toHaveLength(MCP_TOOLS_PER_ROUND_MAX)
    expect(result.dropped).toHaveLength(6)
  })
})

describe('mcpToolNeedsConfirmation', () => {
  const profile = {
    id: 's1',
    name: 'S',
    enabled: true,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    enabledToolNames: ['read'],
    toolConfirmPolicy: 'always',
    status: 'connected',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z'
  } as const

  it('confirms every call under the always policy', () => {
    const tool = makeToolDescriptor('read', { annotations: { readOnlyHint: true, destructiveHint: false } })
    expect(mcpToolNeedsConfirmation({ ...profile, toolConfirmPolicy: 'always' }, tool)).toBe(true)
  })

  it('skips confirmation only for readonly-auto + readOnlyHint && !destructiveHint', () => {
    const safe = makeToolDescriptor('read', { annotations: { readOnlyHint: true, destructiveHint: false } })
    const readonlyAuto = { ...profile, toolConfirmPolicy: 'readonly-auto' as const }
    expect(mcpToolNeedsConfirmation(readonlyAuto, safe)).toBe(false)
  })

  it('confirms when annotations are missing or destructive', () => {
    const readonlyAuto = { ...profile, toolConfirmPolicy: 'readonly-auto' as const }
    expect(mcpToolNeedsConfirmation(readonlyAuto, makeToolDescriptor('no-ann'))).toBe(true)
    expect(
      mcpToolNeedsConfirmation(
        readonlyAuto,
        makeToolDescriptor('destructive', { annotations: { readOnlyHint: true, destructiveHint: true } })
      )
    ).toBe(true)
  })
})

describe('validateMcpCallArgs', () => {
  it('accepts a plain object input', () => {
    expect(validateMcpCallArgs({ a: 1, b: 'x' }, { type: 'object' }).ok).toBe(true)
  })

  it('rejects non-object inputs', () => {
    expect(validateMcpCallArgs('nope', {}).ok).toBe(false)
    expect(validateMcpCallArgs([1, 2], {}).ok).toBe(false)
    expect(validateMcpCallArgs(null, {}).ok).toBe(false)
  })

  it('rejects inputs deeper than the depth limit', () => {
    let nested: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 25; i++) nested = { child: nested }
    expect(validateMcpCallArgs(nested, {}).ok).toBe(false)
  })

  it('rejects inputs larger than the byte limit', () => {
    const huge = { payload: 'x'.repeat(MCP_CALL_ARGS_MAX_BYTES + 10) }
    expect(validateMcpCallArgs(huge, {}).ok).toBe(false)
  })

  it('accepts inputs at the byte boundary', () => {
    const input = { payload: 'x'.repeat(MCP_CALL_ARGS_MAX_BYTES - 100) }
    expect(validateMcpCallArgs(input, {}).ok).toBe(true)
  })
})
