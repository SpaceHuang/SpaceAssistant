import { describe, expect, it } from 'vitest'
import { adaptMcpToolResult } from './mcpToolResultAdapter'

describe('adaptMcpToolResult', () => {
  it('parses both MCP envelope fields without overwriting content', () => {
    const result = adaptMcpToolResult({ __spaceAssistantMcpResult: 1, content: [{ type: 'text', text: 'hello' }], structuredContent: { ok: true } })
    expect(result.text).toBe('hello')
    expect(result.structured).toEqual({ ok: true })
  })

  it('maps malformed content to an unknown block without throwing', () => {
    const result = adaptMcpToolResult([{ type: 'text', text: 123 }, 'bad'])
    expect(result.blocks.map((block) => block.kind)).toEqual(['unknown', 'unknown'])
  })

  it('parses SDK resource and resource_link content blocks', () => {
    const result = adaptMcpToolResult([
      { type: 'resource', resource: { uri: 'file:///tmp/a.txt', mimeType: 'text/plain', text: 'hello' } },
      { type: 'resource_link', uri: 'https://example.test/a', name: 'a' }
    ])
    expect(result.blocks.map((block) => block.kind)).toEqual(['resource', 'resource'])
    expect(result.blocks.map((block) => block.kind === 'resource' ? block.uri : '')).toEqual(['file:///tmp/a.txt', 'https://example.test/a'])
    expect(result.isEmpty).toBe(false)
  })
})
