import { describe, expect, it } from 'vitest'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from './toolResultLimits'
import {
  OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX,
  compactOversizedToolResultContent,
  formatOversizedToolResultPlaceholder
} from './oversizedToolResult'

describe('compactOversizedToolResultContent', () => {
  it('returns original content when under the limit', () => {
    const content = 'short tool result'
    const result = compactOversizedToolResultContent(content)
    expect(result).toEqual({
      content,
      compacted: false,
      originalLength: content.length
    })
  })

  it('replaces oversized content with a short placeholder', () => {
    const content = 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 1)
    const result = compactOversizedToolResultContent(content)
    expect(result.compacted).toBe(true)
    expect(result.originalLength).toBe(content.length)
    expect(result.content).toBe(
      formatOversizedToolResultPlaceholder(content.length, MAX_TOOL_RESULT_CONTENT_CHARS)
    )
    expect(result.content.length).toBeLessThan(MAX_TOOL_RESULT_CONTENT_CHARS)
    expect(result.content.length).toBeLessThan(500)
    expect(result.content.startsWith(OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX)).toBe(true)
  })

  it('is idempotent when content is already a placeholder', () => {
    const placeholder = formatOversizedToolResultPlaceholder(
      MAX_TOOL_RESULT_CONTENT_CHARS + 100,
      MAX_TOOL_RESULT_CONTENT_CHARS
    )
    const first = compactOversizedToolResultContent('y'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 100))
    expect(first.content).toBe(placeholder)
    const second = compactOversizedToolResultContent(first.content)
    expect(second).toEqual({
      content: placeholder,
      compacted: false,
      originalLength: placeholder.length
    })
  })

  it('compacts content exactly one char over the limit', () => {
    const content = 'z'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 1)
    const result = compactOversizedToolResultContent(content)
    expect(result.compacted).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
  })
})
