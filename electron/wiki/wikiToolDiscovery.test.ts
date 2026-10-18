import { describe, expect, it } from 'vitest'
import { discoverWikiTools, WIKI_DISCOVERY_TOOL_DEFINITION, WIKI_DOMAIN_TOOL_DEFINITIONS } from './wikiToolDiscovery'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { isBuiltinToolName } from '../toolsConfigRuntime'

describe('Wiki domain tool discovery', () => {
  it('registers memory as a real lightweight discovery tool', () => {
    expect(WIKI_DISCOVERY_TOOL_DEFINITION).toMatchObject({ name: 'memory', input_schema: { type: 'object' } })
    expect(WIKI_DOMAIN_TOOL_DEFINITIONS.every(tool => tool.name.startsWith('memory.wiki_'))).toBe(true)
    expect(isBuiltinToolName('memory')).toBe(true)
    expect(createBuiltinToolRegistry().get('memory')).toBeDefined()
  })

  it('returns operation names, use descriptions, and complete schemas for matching tools', () => {
    const result = discoverWikiTools({ query: 'read page', limit: 8, offset: 0 })
    expect(result.matches.map(item => item.name)).toContain('memory.wiki_read_page')
    expect(result.matches.find(item => item.name === 'memory.wiki_read_page')?.input_schema).toMatchObject({ required: ['readHandle'] })
    expect(result.totalMatches).toBeGreaterThan(0)
  })

  it('paginates deterministically without modifying authorization or truncating schemas', () => {
    const first = discoverWikiTools({ query: '', limit: 3, offset: 0 })
    const second = discoverWikiTools({ query: '', limit: 3, offset: 3 })
    expect(first.matches).toHaveLength(3)
    expect(second.matches).toHaveLength(3)
    expect(first.matches.map(item => item.name)).not.toEqual(second.matches.map(item => item.name))
    expect(first.matches.every(item => item.input_schema.properties)).toBe(true)
    expect(first.usage).toContain('授权')
  })
})
