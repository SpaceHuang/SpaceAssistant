import { describe, expect, it } from 'vitest'
import { classifyMcpResultSize } from './mcpResultSizing'

describe('classifyMcpResultSize', () => {
  it.each([
    [0, false, 'short'], [8192, false, 'short'], [8193, false, 'medium'],
    [65536, false, 'medium'], [65537, false, 'long'], [524288, false, 'long'],
    [524289, false, 'huge'], [1, true, 'huge']
  ])('classifies %d chars / oversized=%s as %s', (chars, oversized, expected) => {
    expect(classifyMcpResultSize(chars, oversized)).toBe(expected)
  })
})
