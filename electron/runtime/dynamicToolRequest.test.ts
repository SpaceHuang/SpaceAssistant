import { describe, expect, it } from 'vitest'
import { mergeDynamicTools, withDynamicToolsObserver } from './dynamicToolRequest'

describe('mergeDynamicTools', () => {
  it('preserves base tools, appends discovered schemas once, and does not mutate either input', () => {
    const base = [{ name: 'memory', description: 'discover', inputSchema: { type: 'object' } }]
    const discovered = [
      { name: 'memory_wiki_search', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'memory_wiki_search', description: 'search updated', inputSchema: { type: 'object', required: ['query'] } },
      { name: '   ', description: 'invalid', inputSchema: { type: 'object' } }
    ]
    expect(mergeDynamicTools(base, discovered)).toEqual([
      base[0],
      { name: 'memory_wiki_search', description: 'search updated', inputSchema: { type: 'object', required: ['query'] } }
    ])
    expect(base).toHaveLength(1)
    expect(discovered).toHaveLength(3)
  })

  it('patches a later model request with discovered schemas while preserving observer output', async () => {
    const calls: string[] = []
    const observer = withDynamicToolsObserver({
      prepareModelRequest: () => ({ requestProjection: { retained: true } }),
      onModelRequest: () => { calls.push('model-request') }
    }, () => [{ name: 'memory_wiki_search', description: 'search', inputSchema: { type: 'object', required: ['query'] } }])
    const result = await observer.prepareModelRequest?.({
      modelTurn: 2,
      attempt: 1,
      routeId: 'route',
      request: { messages: [], maxTokens: 100, tools: [{ name: 'memory', description: 'discover', inputSchema: { type: 'object' } }] }
    })
    expect(result?.requestProjection).toEqual({ retained: true })
    expect(result?.requestPatch?.tools).toEqual([
      { name: 'memory', description: 'discover', inputSchema: { type: 'object' } },
      { name: 'memory_wiki_search', description: 'search', inputSchema: { type: 'object', required: ['query'] } }
    ])
    expect(calls).toEqual([])
  })
})
