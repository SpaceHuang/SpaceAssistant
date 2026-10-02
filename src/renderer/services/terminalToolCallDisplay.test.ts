import { describe, expect, it } from 'vitest'
import { settleTerminalToolCallsForDisplay } from './terminalToolCallDisplay'

describe('settleTerminalToolCallsForDisplay', () => {
  it('does not keep waiting-confirmation tools in a terminal message', () => {
    const message = {
      id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 1,
      status: 'cancelled' as const, schemaVersion: 1,
      toolCalls: [
        { id: 'read-1', toolName: 'read_file', input: { path: 'a.md' }, status: 'confirming' as const, riskLevel: 'low' as const },
        { id: 'done-1', toolName: 'read_file', input: { path: 'b.md' }, status: 'completed' as const, riskLevel: 'low' as const }
      ]
    }

    expect(settleTerminalToolCallsForDisplay(message).toolCalls).toEqual([
      expect.objectContaining({ id: 'read-1', status: 'failed' }),
      expect.objectContaining({ id: 'done-1', status: 'completed' })
    ])
  })

  it('preserves confirming calls while the message is still streaming', () => {
    const message = {
      id: 'assistant-2', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 1,
      status: 'streaming' as const, schemaVersion: 1,
      toolCalls: [{ id: 'read-2', toolName: 'read_file', input: { path: 'a.md' }, status: 'confirming' as const, riskLevel: 'low' as const }]
    }

    expect(settleTerminalToolCallsForDisplay(message)).toBe(message)
  })
})
