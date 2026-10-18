import { describe, expect, it } from 'vitest'
import { authorizeToolCall, computeEffectiveTools } from './effectiveTools'

const cfg = { enabled: false, allowedTools: [], deniedTools: [] }

describe('computeEffectiveTools', () => {
  it('通过内置工具开关时在首轮请求广告并授权 memory discovery', () => {
    const result = computeEffectiveTools({ builtinConfig: { enabled: true, allowedTools: ['memory'], deniedTools: [] } })
    expect(result.toolNames).toEqual(['memory'])
    expect(result.authorizedToolNames.has('memory')).toBe(true)
  })

  it('内置关闭时仍保留桌面 MCP，并用同一名称集合生成授权白名单', () => {
    const result = computeEffectiveTools({
      builtinConfig: cfg,
      mcpSnapshot: {
        entries: new Map([
          ['mcp_read', {
            serverId: 's1', serverName: 'demo', originalName: 'read', mappedName: 'mcp_read',
            description: 'read', inputSchema: {}
          }]
        ]),
        budgetDropped: []
      }
    })
    expect(result.toolNames).toEqual(['mcp_read'])
    expect([...result.authorizedToolNames]).toEqual(result.toolNames)
  })

  it('IM lane 注入本回合快照中的 MCP 工具', () => {
    const result = computeEffectiveTools({
      builtinConfig: cfg,
      remoteContext: { source: 'wechat', messageId: 'm', confirmPolicy: 'always' },
      mcpSnapshot: {
        entries: new Map([['mcp_read', {
          serverId: 's1', serverName: 'demo', originalName: 'read', mappedName: 'mcp_read', description: 'read', inputSchema: {}
        }]]), budgetDropped: []
      }
    })
    expect(result.toolNames).toEqual(['mcp_read'])
  })

  it('trim allow applies to MCP and excludes it from all advertised/authorized surfaces', () => {
    const result = computeEffectiveTools({
      builtinConfig: cfg,
      remoteContext: { source: 'wechat', messageId: 'm', confirmPolicy: 'always' },
      mcpSnapshot: { entries: new Map([['mcp_read', {
        serverId: 's1', serverName: 'demo', originalName: 'read', mappedName: 'mcp_read', description: 'read', inputSchema: {}
      }]]), budgetDropped: [] },
      trim: { allow: ['safe_builtin'] }
    })
    expect(result.toolNames).toEqual([])
    expect(result.deferredToolNames).toEqual(new Set())
  })

  it('trim allow applies to deferred MCP names and their index authorization surface', () => {
    const entry = { serverId: 's1', serverName: 'demo', originalName: 'read', mappedName: 'mcp_read', description: 'read', inputSchema: {} }
    const result = computeEffectiveTools({
      builtinConfig: { enabled: true, allowedTools: ['tool_search'], deniedTools: [] },
      remoteContext: { source: 'feishu', messageId: 'm', confirmPolicy: 'always' },
      mcpSnapshot: { entries: new Map([['mcp_read', entry]]), budgetDropped: [] },
      deferredPlan: { mode: 'deferred', deferredNames: new Set(['mcp_read']), deferredEntries: [entry], eagerAdvertiseBudget: { maxCount: 64, maxTotalBytes: 96 * 1024 } },
      trim: { allow: ['tool_search'] }
    })
    expect(result.toolNames).toEqual(['tool_search'])
    expect(result.deferredToolNames).toEqual(new Set())
    expect([...result.authorizedToolNames]).toEqual(['tool_search'])
  })
})

describe('authorizeToolCall', () => {
  it('拒绝不在请求初始白名单中的名称', () => {
    expect(authorizeToolCall('read_file', new Set(['mcp_read']))).toEqual({ ok: false, error: 'tool_not_authorized' })
  })
})
