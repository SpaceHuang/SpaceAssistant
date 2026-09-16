import { describe, expect, it } from 'vitest'
import { projectPersistedMcpResult, projectSanitizedMcpBlocks } from './mcpToolResultDisplay'

describe('projectSanitizedMcpBlocks', () => {
  it('preserves block order and joins text blocks', () => {
    const result = projectSanitizedMcpBlocks({ blocks: [
      { kind: 'text', text: '第一段' },
      { kind: 'resource', uri: 'file:///tmp/a.txt', name: 'a.txt' },
      { kind: 'text', text: '第二段' }
    ] })
    expect(result.text).toBe('第一段\n\n第二段')
    expect(result.blocks).toHaveLength(3)
    expect(result.isEmpty).toBe(false)
  })

  it('uses UTF-8 safe limits and reports truncation', () => {
    const result = projectSanitizedMcpBlocks({ blocks: [{ kind: 'text', text: '你好'.repeat(100) }] }, { maxTextBytes: 7 })
    expect(result.text).toBe('你好你好你好你')
    expect(result.unknownTruncated).toBeUndefined()
    expect(result.structuredTruncated).toBeUndefined()
    expect(result.truncated).toBe(true)
  })

  it('marks empty blocks and retains structured data', () => {
    const result = projectSanitizedMcpBlocks({ blocks: [{ kind: 'unknown', raw: '' }], structured: { answer: 42 } })
    expect(result.structured).toEqual({ answer: 42 })
    expect(result.isEmpty).toBe(false)
  })

  it('classifies a truncated text block as huge', () => {
    const result = projectSanitizedMcpBlocks({ blocks: [{ kind: 'text', text: 'x'.repeat(512 * 1024 + 1) }] })
    expect(result.displayMode).toBe('huge')
    expect(result.truncated).toBe(true)
  })

  it('sanitizes historical text, structured data, resources, and unknown blocks', () => {
    const result = projectPersistedMcpResult({ content: [
      { type: 'text', text: 'Bearer secret-token' },
      { type: 'resource_link', uri: 'https://example.test/a?token=secret' },
      { type: 'resource', resource: { uri: 'file:///tmp/a', text: 'hidden' } },
      { type: 'unknown', value: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }
    ], structuredContent: { token: 'Bearer secret-token' } })
    expect(result.text).not.toContain('secret-token')
    expect(result.blocks.some((block) => block.kind === 'resource' && block.uri.includes('secret'))).toBe(false)
    expect(result.structuredText).not.toContain('secret-token')
    expect(result.blocks.some((block) => block.kind === 'unknown' && block.raw.includes('ghp_'))).toBe(false)
  })

  it('masks credentials in structured object keys in the readable projection', () => {
    const result = projectSanitizedMcpBlocks({ blocks: [], structured: { 'ghp_abcdefghijklmnopqrstuvwxyz1234567890': 'enabled' } })
    expect(result.structuredText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    expect(result.structuredText).toContain('<secret:redacted>')
  })

  it('keeps text after the UI block cap in the bounded text projection', () => {
    const result = projectSanitizedMcpBlocks({ blocks: [
      ...Array.from({ length: 128 }, () => ({ kind: 'text' as const, text: '' })),
      { kind: 'text', text: 'sole-business-answer' }
    ] })
    expect(result.text).toContain('sole-business-answer')
    expect(result.truncated).toBe(true)
  })

  it('masks a non-serializable structured fallback', () => {
    const value: Record<string, unknown> = { token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }
    value.self = value
    const result = projectSanitizedMcpBlocks({ blocks: [], structured: value })
    expect(result.structuredText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
  })
})
