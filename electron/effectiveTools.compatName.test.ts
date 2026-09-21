import { describe, expect, it } from 'vitest'
import { authorizeToolCall, computeEffectiveTools } from './effectiveTools'
import { getRegisteredTool } from './tools/builtinExecutors'
import { createAgentRuntime } from './runtime/agentRuntime'
import { setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from './tools/builtinExecutors'
import { ConfirmIdSpace } from './remote/confirmId'
import { ChatCancelRegistry } from './chatCancelRegistry'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { McpConcurrencyGate } from './mcp/mcpToolExecutor'


// B1 复现/回归：点号内部名（history.read/skills.read）出向被 sanitize 为 compat 名，
// 分发侧必须经 compatToInternal 逆映射才能命中以内部名为 key 的注册表。
const enabledCfg = { enabled: true, allowedTools: [], deniedTools: [] }

// P8:显式装配含真 builtin registry 的默认 runtime(兼容转发打到真实注册表)
setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry()
  })
)

describe('工具名双向转换（B1）', () => {
  it('出向为 compat 名，逆映射表把 compat 名还原为内部注册名', () => {
    const result = computeEffectiveTools({ builtinConfig: enabledCfg })

    const apiNames = result.tools.map((t) => (t as { name?: string }).name)
    expect(apiNames).toContain('history_read')
    expect(apiNames).not.toContain('history.read')
    expect(apiNames).toContain('skills_read')

    expect(result.compatToInternal.get('history_read')).toBe('history.read')
    expect(result.compatToInternal.get('skills_read')).toBe('skills.read')
    // 无点号工具为恒等映射
    expect(result.compatToInternal.get('read_file')).toBe('read_file')
  })

  it('授权白名单与注册表按内部名口径：compat 调用名解析后可授权、可命中注册表', () => {
    const result = computeEffectiveTools({ builtinConfig: enabledCfg })
    const internalName = result.compatToInternal.get('history_read')!
    expect(internalName).toBe('history.read')
    // 模型按 API 名（history_read）调用 → 逆映射后通过授权
    expect(authorizeToolCall(internalName, result.authorizedToolNames)).toEqual({ ok: true })
    expect(authorizeToolCall('history.read', result.authorizedToolNames)).toEqual({ ok: true })
    expect(authorizeToolCall('unknown_tool', result.authorizedToolNames)).toEqual({
      ok: false,
      error: 'tool_not_authorized'
    })
    // 注册表 key 是内部名：解析后命中；直接用 compat 名命中不了（修复前分发必败的根因）
    expect(getRegisteredTool(internalName)).toBeDefined()
    expect(getRegisteredTool('history_read')).toBeUndefined()
  })

  it('compat 撞名在构建期报错：点号名与等价下划线名不可并存', () => {
    expect(() =>
      computeEffectiveTools({
        builtinConfig: enabledCfg,
        mcpSnapshot: {
          entries: new Map([
            [
              'history_read',
              {
                serverId: 's1',
                serverName: 'demo',
                originalName: 'read',
                mappedName: 'history_read',
                description: 'read',
                inputSchema: {}
              }
            ]
          ]),
          budgetDropped: []
        }
      })
    ).toThrow(/撞名/)
  })
})
