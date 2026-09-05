import { describe, expect, it } from 'vitest'
import { authorizeToolCall, computeEffectiveTools } from './effectiveTools'

const cfg = { enabled: false, allowedTools: [], deniedTools: [] }

describe('computeEffectiveTools', () => {
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

  it('远端不注入 MCP', () => {
    const result = computeEffectiveTools({
      builtinConfig: cfg,
      remoteContext: { source: 'wechat', messageId: 'm', confirmPolicy: 'always' },
      mcpSnapshot: { entries: new Map(), budgetDropped: [] }
    })
    expect(result.toolNames).toEqual([])
  })
})

describe('authorizeToolCall', () => {
  it('拒绝不在请求初始白名单中的名称', () => {
    expect(authorizeToolCall('read_file', new Set(['mcp_read']))).toEqual({ ok: false, error: 'tool_not_authorized' })
  })
})
