import { describe, expect, it } from 'vitest'
import { createToolCallLabelFormatter } from './toolCallLabel'

describe('createToolCallLabelFormatter', () => {
  it('never exposes a bare MCP mapped name to remote progress', () => {
    const label = createToolCallLabelFormatter('zh-CN')('mcp_s_hot_019ce6b1', {})
    expect(label).not.toBe('mcp_s_hot_019ce6b1')
    expect(label).toContain('hot')
  })
})
