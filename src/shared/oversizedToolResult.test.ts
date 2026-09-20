import { describe, expect, it } from 'vitest'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from './toolResultLimits'
import {
  OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX,
  TRUNCATED_TOOL_RESULT_MARKER_PREFIX,
  compactOversizedToolResultContent,
  formatOversizedToolResultPlaceholder,
  isTruncatedToolResultContent
} from './oversizedToolResult'

/**
 * P1-4（agent-context-token-cost-optimization-plan §5.4）：超限处理从「全有或全无」改为
 * 中段截断——保留头 + 尾 + 截断标记（originalLength/estimatedTokens/totalLines），
 * 并指引模型用 read_file offset/limit 读取指定区间。
 */

describe('compactOversizedToolResultContent（P1-4 中段截断）', () => {
  it('未超限：原样返回', () => {
    const content = 'short tool result'
    const result = compactOversizedToolResultContent(content)
    expect(result).toEqual({ content, compacted: false, originalLength: content.length })
  })

  it('超限：保留头部与尾部，中段替换为截断标记', () => {
    const head = 'HEAD-' + 'a'.repeat(500)
    const tail = 'b'.repeat(500) + '-TAIL'
    const content = head + 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS) + tail
    const result = compactOversizedToolResultContent(content)
    expect(result.compacted).toBe(true)
    expect(result.originalLength).toBe(content.length)
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
    // 头部/尾部保留（信息不全失）
    expect(result.content.startsWith(head)).toBe(true)
    expect(result.content.endsWith(tail)).toBe(true)
    // 标记含口径信息 + read_file 指引
    expect(result.content).toContain(TRUNCATED_TOOL_RESULT_MARKER_PREFIX)
    expect(result.content).toContain(`originalLength=${content.length}`)
    expect(result.content).toContain('totalLines=')
    expect(result.content).toContain('read_file')
    expect(result.content).toContain('offset/limit')
    expect(isTruncatedToolResultContent(result.content)).toBe(true)
  })

  it('评审 P1-2：天然包含 marker 字面量的超限原文不被误判为已截断，仍被压缩', () => {
    const marker = '…[tool_result truncated:'
    const content = (marker + 'x'.repeat(1000)).repeat(50)
    expect(content.length).toBeGreaterThan(MAX_TOOL_RESULT_CONTENT_CHARS)
    const result = compactOversizedToolResultContent(content)
    expect(result.compacted).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
  })

  it('幂等：已截断内容二次压缩不再变化', () => {
    const content = 'y'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 100)
    const first = compactOversizedToolResultContent(content)
    expect(first.compacted).toBe(true)
    const second = compactOversizedToolResultContent(first.content)
    expect(second).toEqual({ content: first.content, compacted: false, originalLength: first.content.length })
  })

  it('历史兼容：旧版「全有或全无」占位符保持幂等识别，不再二次处理', () => {
    const legacy = formatOversizedToolResultPlaceholder(MAX_TOOL_RESULT_CONTENT_CHARS + 100, MAX_TOOL_RESULT_CONTENT_CHARS)
    expect(legacy.startsWith(OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX)).toBe(true)
    const result = compactOversizedToolResultContent(legacy)
    expect(result).toEqual({ content: legacy, compacted: false, originalLength: legacy.length })
  })

  it('恰好超限 1 字符也截断，且结果长度不超过上限', () => {
    const content = 'z'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 1)
    const result = compactOversizedToolResultContent(content)
    expect(result.compacted).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
  })

  it('多行大结果：totalLines 与头尾行内容保留', () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `line-${i}: some content here`)
    const content = lines.join('\n')
    const result = compactOversizedToolResultContent(content)
    expect(result.compacted).toBe(true)
    expect(result.content).toContain('line-0:')
    expect(result.content).toContain('line-4999')
    expect(result.content).toMatch(/totalLines=\d+/)
  })
})
