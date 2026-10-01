import { describe, expect, it, vi } from 'vitest'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import { McpConnectionManager } from './mcpConnectionManager'
import { createHostedMcpToolRegistry } from './hostedMcpRegistry'
import type { McpToolSnapshot } from './mcpToolRegistry'

describe('createHostedMcpToolRegistry', () => {
  it('adds only the current model-visible snapshot as registered MCP tools', async () => {
    const base = new TypedToolRegistry()
    const builtin = definePlannedTool({ name: 'write_file', parseInput: (value) => value, plan: async (value) => value, execute: async () => ({ success: true }) })
    base.register(builtin)
    const snapshot: McpToolSnapshot = {
      entries: new Map([['mcp_docs_search', { mappedName: 'mcp_docs_search', serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search docs', inputSchema: { type: 'object' } }]]),
      budgetDropped: [{ mappedName: 'mcp_hidden_admin', reason: 'count' }]
    }
    const execute = vi.fn(async () => ({ success: true, data: 'found' }))
    const resolveExecutor = vi.fn((name: string) => name === 'mcp_docs_search' ? { name, execute } : undefined)
    const registry = createHostedMcpToolRegistry({ base, snapshot, manager: new McpConnectionManager(), resolveExecutor })

    expect(registry.get('write_file')).toBe(builtin)
    expect(registry.entries().map(({ name }) => name)).toEqual(['write_file', 'mcp_docs_search'])
    expect(registry.get('mcp_hidden_admin')).toBeUndefined()
    expect(resolveExecutor).toHaveBeenCalledExactlyOnceWith('mcp_docs_search', expect.any(McpConnectionManager))

    const registered = registry.get('mcp_docs_search')!
    const handle = await registered.begin({ query: 'plan' }, { requestId: 'req', toolUseId: 'call' })
    handle.confirm()
    await handle.execute({ requestId: 'req', toolUseId: 'call', signal: new AbortController().signal, runtimeContext: {} as never })
    expect(execute).toHaveBeenCalledWith({ query: 'plan' }, expect.objectContaining({ requestId: 'req', toolUseId: 'call' }))
  })

  it('fails closed if the invocation snapshot has no corresponding executor', () => {
    expect(() => createHostedMcpToolRegistry({
      base: new TypedToolRegistry(),
      snapshot: { entries: new Map([['mcp_missing', { mappedName: 'mcp_missing' } as never]]), budgetDropped: [] },
      manager: new McpConnectionManager(),
      resolveExecutor: () => undefined
    })).toThrow('MCP_REGISTERED_EXECUTOR_UNAVAILABLE:mcp_missing')
  })

  it('rejects snapshot key drift before resolving an executor', () => {
    const resolveExecutor = vi.fn()
    expect(() => createHostedMcpToolRegistry({
      base: new TypedToolRegistry(),
      snapshot: { entries: new Map([['provider-name', { mappedName: 'internal-name' } as never]]), budgetDropped: [] },
      manager: new McpConnectionManager(),
      resolveExecutor
    })).toThrow('MCP_SNAPSHOT_NAME_MISMATCH:provider-name')
    expect(resolveExecutor).not.toHaveBeenCalled()
  })
})
