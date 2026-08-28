import { describe, expect, it, vi } from 'vitest'
import { deserializeToolCallsFromDb, serializeToolCallsForDb } from './messageCodec'

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

import { logAgentEvent } from './agentLogger/agentLogger'

describe('deserializeToolCallsFromDb', () => {
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
})
