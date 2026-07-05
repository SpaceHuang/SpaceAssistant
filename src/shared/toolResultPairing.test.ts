import { describe, expect, it } from 'vitest'
import type { ClaudeChatMessageWithBlocks } from './api'
import {
  NO_CONTENT_MESSAGE,
  ORPHAN_REMOVED_MESSAGE,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  ToolResultPairingError,
  ensureToolResultPairing
} from './toolResultPairing'

type Msg = ClaudeChatMessageWithBlocks

function assistantToolUse(...ids: string[]): Msg {
  return {
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool_use', id, name: 'read_file', input: {} }))
  }
}

function userToolResults(...entries: Array<{ id: string; content?: string; is_error?: boolean }>): Msg {
  return {
    role: 'user',
    content: entries.map((e) => ({
      type: 'tool_result',
      tool_use_id: e.id,
      content: e.content ?? 'ok',
      ...(e.is_error ? { is_error: true } : {})
    }))
  }
}

function userText(text: string): Msg {
  return { role: 'user', content: text }
}

describe('ensureToolResultPairing', () => {
  it('1: leaves valid adjacent pairing unchanged', () => {
    const input: Msg[] = [userText('hi'), assistantToolUse('a'), userToolResults({ id: 'a' })]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(false)
    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual(input[1])
    expect(messages[2]).toEqual(input[2])
  })

  it('2: injects synthetic tool_result for missing results', () => {
    const input: Msg[] = [userText('start'), assistantToolUse('a', 'b'), userToolResults({ id: 'a' })]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.missingToolResult).toBe(1)
    const userMsg = messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
    )!
    const userContent = userMsg.content as Array<{ type: string; tool_use_id: string; is_error?: boolean; content: string }>
    expect(userContent).toHaveLength(2)
    const missing = userContent.find((b) => b.tool_use_id === 'b')
    expect(missing?.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
    expect(missing?.is_error).toBe(true)
  })

  it('3: removes orphaned tool_result and fills placeholder text', () => {
    const input: Msg[] = [
      userToolResults({ id: 'orphan' }),
      assistantToolUse('b'),
      userToolResults({ id: 'b' })
    ]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.orphanedToolResult).toBeGreaterThanOrEqual(1)
    expect(messages[0]!.content).toBe(ORPHAN_REMOVED_MESSAGE)
    expect(messages).toHaveLength(3)
  })

  it('4: deduplicates duplicate tool_use_id globally', () => {
    const input: Msg[] = [
      userText('start'),
      assistantToolUse('a'),
      userToolResults({ id: 'a' }),
      assistantToolUse('a'),
      userToolResults({ id: 'a' })
    ]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.duplicateToolUseId).toBe(1)
    const toolUseCount = messages.reduce((n, m) => {
      if (!Array.isArray(m.content)) return n
      return n + m.content.filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use').length
    }, 0)
    expect(toolUseCount).toBe(1)
  })

  it('5: deduplicates duplicate tool_result_id in same user message', () => {
    const input: Msg[] = [userText('hi'), assistantToolUse('a'), userToolResults({ id: 'a' }, { id: 'a' })]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.duplicateToolResultId).toBe(1)
    const userMsg = messages.find((m) => m.role === 'user' && Array.isArray(m.content))!
    const results = userMsg.content as Array<{ tool_use_id: string }>
    expect(results.filter((b) => b.tool_use_id === 'a')).toHaveLength(1)
  })

  it('6: drops leading assistant messages', () => {
    const input: Msg[] = [assistantToolUse('a'), userToolResults({ id: 'a' })]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.leadingAssistantDropped).toBeGreaterThan(0)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toBe(ORPHAN_REMOVED_MESSAGE)
  })

  it('7: fixes consecutive same-role messages by merging', () => {
    const input: Msg[] = [userText('a'), userText('b'), assistantToolUse('x')]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.roleAlternationFixed).toBeGreaterThan(0)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')
  })

  it('8: fills empty content arrays with NO_CONTENT placeholder', () => {
    const input: Msg[] = [userText('start'), { role: 'assistant', content: [] }]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(true)
    expect(report.fixes.emptyMessageFilled).toBeGreaterThan(0)
    const content = messages[1]!.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toBe(NO_CONTENT_MESSAGE)
  })

  it('11: strict mode throws on missing tool_result', () => {
    const input: Msg[] = [userText('hi'), assistantToolUse('a', 'b'), userToolResults({ id: 'a' })]
    expect(() => ensureToolResultPairing(input, { strict: true })).toThrow(ToolResultPairingError)
  })

  it('12: strict mode throws on orphaned tool_result', () => {
    const input: Msg[] = [userToolResults({ id: 'orphan' })]
    expect(() => ensureToolResultPairing(input, { strict: true })).toThrow(ToolResultPairingError)
  })

  it('17: preserves string content messages without block pairing', () => {
    const input: Msg[] = [userText('plain text'), assistantToolUse('a'), userToolResults({ id: 'a' })]
    const { messages, report } = ensureToolResultPairing(input)
    expect(report.repaired).toBe(false)
    expect(messages[0]!.content).toBe('plain text')
  })

  it('18: handles 10000 valid messages under 50ms without building structure summary', () => {
    const input: Msg[] = []
    for (let i = 0; i < 3333; i++) {
      input.push(userText(`u${i}`))
      input.push(assistantToolUse(`tool_${i}`))
      input.push(userToolResults({ id: `tool_${i}` }))
      input.push({ role: 'assistant', content: `done ${i}` })
    }
    input.push(userText('tail'))
    const start = performance.now()
    const { report } = ensureToolResultPairing(input)
    const elapsed = performance.now() - start
    expect(report.repaired).toBe(false)
    expect(report.messageStructure).toHaveLength(0)
    expect(elapsed).toBeLessThan(50)
  })
})
