import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logAgentEvent } from './agentLogger/agentLogger'
import { normalizeAndValidateClaudeMessagesWithContentBlocks } from './claudeStreamHandlers'
import { ORPHAN_REMOVED_MESSAGE } from '../src/shared/toolResultPairing'

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

describe('normalizeAndValidateClaudeMessagesWithContentBlocks pairing integration', () => {
  beforeEach(() => {
    vi.mocked(logAgentEvent).mockClear()
  })

  it('repairs orphaned tool_result and logs pairing event', () => {
    const input = [
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'ok' }]
      },
      { role: 'assistant' as const, content: 'hi' }
    ]
    const out = normalizeAndValidateClaudeMessagesWithContentBlocks(input, { sessionId: 's1' })
    expect(out[0]!.content).toBe(ORPHAN_REMOVED_MESSAGE)
    expect(logAgentEvent).toHaveBeenCalledWith(
      'warn',
      'tool.result.pairing.repaired',
      expect.objectContaining({ sessionId: 's1' })
    )
  })

  it('passes through valid tool_use/tool_result pairs unchanged', () => {
    const input = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }]
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }]
      }
    ]
    const out = normalizeAndValidateClaudeMessagesWithContentBlocks(input)
    expect(out).toHaveLength(3)
    expect(logAgentEvent).not.toHaveBeenCalled()
  })
})
