import { describe, expect, it } from 'vitest'
import { buildMcpToolCatalog, resolveMcpToolFromCatalog } from './mcpToolCatalog'

describe('mcpToolCatalog', () => {
  it('indexes mapped names without losing the original tool metadata', () => {
    buildMcpToolCatalog({
      servers: [{ id: '知乎', name: '知乎热榜' } as never],
      toolCaches: { 知乎: { tools: [{ mappedName: 'mcp_s_hot_abc', originalName: 'hot_list', description: '获取热榜' }] } as never }
    })
    expect(resolveMcpToolFromCatalog('mcp_s_hot_abc')).toEqual({
      serverId: '知乎', serverName: '知乎热榜', originalToolName: 'hot_list', description: '获取热榜'
    })
  })

  it('returns undefined for an unknown mapped name', () => {
    expect(resolveMcpToolFromCatalog('mcp_missing')).toBeUndefined()
  })
})
