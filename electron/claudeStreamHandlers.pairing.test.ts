import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logAgentEvent } from './agentLogger/agentLogger'
import { normalizeAndValidateClaudeMessagesWithContentBlocks } from './claudeStreamHandlers'
import {
  OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX,
  formatOversizedToolResultPlaceholder
} from '../src/shared/oversizedToolResult'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/shared/toolResultLimits'
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

  it('compacts oversized tool_result instead of throwing', () => {
    const oversized = 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 1)
    const input = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }]
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: oversized }]
      }
    ]
    const out = normalizeAndValidateClaudeMessagesWithContentBlocks(input, { sessionId: 's-over' })
    const blocks = out[2]!.content as Array<{ type: string; tool_use_id: string; content: string }>
    expect(blocks[0]!.tool_use_id).toBe('t1')
    expect(blocks[0]!.content).toBe(
      formatOversizedToolResultPlaceholder(oversized.length, MAX_TOOL_RESULT_CONTENT_CHARS)
    )
    expect(blocks[0]!.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
    expect(logAgentEvent).toHaveBeenCalledWith(
      'warn',
      'tool.result.oversized.compacted',
      expect.objectContaining({
        sessionId: 's-over',
        toolUseId: 't1',
        originalLength: oversized.length
      })
    )
  })

  it('keeps is_error true when compacting oversized error tool_result', () => {
    const oversized = 'e'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 5)
    const input = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't-err', name: 'shell', input: {} }]
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't-err', content: oversized, is_error: true }]
      }
    ]
    const out = normalizeAndValidateClaudeMessagesWithContentBlocks(input)
    const blocks = out[2]!.content as Array<{
      type: string
      tool_use_id: string
      content: string
      is_error?: boolean
    }>
    expect(blocks[0]!.is_error).toBe(true)
    expect(blocks[0]!.content.startsWith(OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX)).toBe(true)
  })

  it('leaves short tool_result content unchanged', () => {
    const input = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }]
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]
      }
    ]
    const out = normalizeAndValidateClaudeMessagesWithContentBlocks(input)
    const blocks = out[2]!.content as Array<{ content: string }>
    expect(blocks[0]!.content).toBe('ok')
    expect(logAgentEvent).not.toHaveBeenCalled()
  })

  it('compacts oversized tool_result after pairing without empty user', () => {
    const oversized = 'z'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 2)
    const withOversized = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't-pair', name: 'read_file', input: {} }]
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't-pair', content: oversized }]
      }
    ]
    const out = normalizeAndValidateClaudeMessagesWithContentBlocks(withOversized, {
      sessionId: 's-pair'
    })
    expect(out.every((m) => m.content !== undefined && m.content !== '')).toBe(true)
    const last = out[out.length - 1]!.content as Array<{ content: string }>
    expect(last[0]!.content.startsWith(OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX)).toBe(true)
  })
})
