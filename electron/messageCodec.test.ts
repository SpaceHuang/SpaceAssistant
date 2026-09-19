import { describe, expect, it, vi } from 'vitest'
import { deserializeToolCallsFromDb, serializeToolCallsForDb } from './messageCodec'

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

import { logAgentEvent } from './agentLogger/agentLogger'

describe('deserializeToolCallsFromDb', () => {
  it('round-trips MCP displayData for historical cards', () => {
    const raw = serializeToolCallsForDb([{
      id: 'mcp-1', toolName: 'mcp_x_y_abc', input: {}, status: 'completed', riskLevel: 'low',
      result: { success: true, data: '[model]', displayData: { text: '可读结果', blocks: [{ kind: 'text', text: '可读结果' }], isEmpty: false } }
    }])
    expect(deserializeToolCallsFromDb(raw)?.[0]?.result?.displayData?.text).toBe('可读结果')
  })
  it('13: returns corrupted placeholder and logs on parse failure', () => {
    const result = deserializeToolCallsFromDb('not-valid-json{{{')
    expect(result).toHaveLength(1)
    expect(result![0]!.corrupted).toBe(true)
    expect(result![0]!.status).toBe('failed')
    expect(result![0]!.result?.success).toBe(false)
    expect(logAgentEvent).toHaveBeenCalledWith(
      'warn',
      'db.tool_calls.deserialize_failed',
      expect.objectContaining({ error: expect.any(String) })
    )
  })

  it('deserializes valid tool_calls including interrupted flag', () => {
    const raw = JSON.stringify([
      {
        id: 't1',
        toolName: 'read_file',
        input: '{}',
        status: 'failed',
        riskLevel: 'low',
        interrupted: true,
        result: { success: false, error: 'interrupted', data: undefined }
      }
    ])
    const result = deserializeToolCallsFromDb(raw)
    expect(result).toHaveLength(1)
    expect(result![0]!.interrupted).toBe(true)
    expect(result![0]!.input).toEqual({})
  })

  it('round-trips MCP metadata on tool calls (P0-B 持久化)', () => {
    const call = {
      id: 't-mcp',
      toolName: 'mcp_github_create_issue_12345678',
      input: { title: 'x' },
      status: 'completed' as const,
      riskLevel: 'medium' as const,
      mcp: { serverId: 'server-1', serverName: 'GitHub', originalToolName: 'create_issue' },
      result: { success: true, data: { ok: true } }
    }
    const serialized = serializeToolCallsForDb([call])
    const restored = deserializeToolCallsFromDb(serialized)
    expect(restored).toHaveLength(1)
    expect(restored![0]!.mcp).toEqual({
      serverId: 'server-1',
      serverName: 'GitHub',
      originalToolName: 'create_issue'
    })
    expect(restored![0]!.toolName).toBe('mcp_github_create_issue_12345678')
    expect(restored![0]!.result).toEqual({ success: true, data: { ok: true } })
  })

  it('round-trips shell process identity for restart orphan cleanup', () => {
    const call = {
      id: 't-shell', toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'executing' as const,
      riskLevel: 'high' as const, processPid: 4321, processGroupId: 4321, processOwnerToken: 'request:t-shell'
    }
    const restored = deserializeToolCallsFromDb(serializeToolCallsForDb([call]))
    expect(restored?.[0]).toMatchObject({ processPid: 4321, processGroupId: 4321, processOwnerToken: 'request:t-shell' })
  })
})

describe('serializeToolCallsForDb：toolkit.call 凭据持久化净化（H3）', () => {
  it('toolkit.call 的 accessToken/headerValue/env 落库前布尔化（明文不进 messages.tool_calls）', () => {
    const raw = serializeToolCallsForDb([
      {
        id: 'tu-1',
        toolName: 'toolkit.call',
        input: {
          id: 'action.mcp.add',
          params: {
            name: 'srv',
            endpoint: 'https://example.com/mcp',
            accessToken: 'sk-secret-value',
            headerValue: 'Bearer xyz',
            env: { TOKEN: 'plain-secret' }
          }
        },
        status: 'completed'
      }
    ])
    const parsed = JSON.parse(raw!) as Array<{ input: string }>
    const input = JSON.parse(parsed[0]!.input) as { params: Record<string, unknown> }
    expect(input.params.accessToken).toBe(true)
    expect(input.params.headerValue).toBe(true)
    expect(JSON.stringify(input.params)).not.toContain('sk-secret-value')
    expect(JSON.stringify(input.params)).not.toContain('plain-secret')
    // 非凭据字段原样保留
    expect(input.params.endpoint).toBe('https://example.com/mcp')
    expect(input.params.name).toBe('srv')
  })

  it('非 toolkit 工具的 input 不净化（行为不变）', () => {
    const raw = serializeToolCallsForDb([
      { id: 'tu-2', toolName: 'write_file', input: { path: 'a.txt', content: 'x' }, status: 'completed' }
    ])
    expect(raw).toContain('a.txt')
  })
})
