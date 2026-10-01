import { describe, expect, it } from 'vitest'
import { buildToolCapabilityConventionHint, buildAvailableToolsHint } from './skillPrompt'

const BASE_NAMES = ['read_file', 'run_shell', 'toolkit_find', 'toolkit_call', 'tool_search']

describe('FR7：延迟模式约定提示', () => {
  it('非延迟模式：hint 与现状一致（无 tool_search 检索行、无「另有 N 个」尾注）', () => {
    const hint = buildToolCapabilityConventionHint(BASE_NAMES)
    expect(hint).not.toContain('tool_search')
    const available = buildAvailableToolsHint(BASE_NAMES)
    expect(available).not.toContain('MCP 工具索引')
  })

  it('延迟模式：约定 hint 追加「先 tool_search 检索」一行（compat 名口径，无点号）', () => {
    const hint = buildToolCapabilityConventionHint(BASE_NAMES, { mcpDeferredCount: 42 })
    expect(hint).toContain('tool_search')
    expect(hint).toContain('参数定义未随请求下发')
    expect(hint).toContain('toolkit_find / toolkit_call')
    expect(hint).not.toContain('toolkit.find')
  })

  it('延迟模式：「仅可调用」清单尾部注明另有 N 个 MCP 工具（消除表述矛盾）', () => {
    const available = buildAvailableToolsHint(BASE_NAMES, { mcpDeferredCount: 42 })
    expect(available).toContain('42')
    expect(available).toContain('MCP 工具索引')
    expect(available).toContain('tool_search')
    // 「仅可调用以下工具名称」清单本身不变
    expect(available).toContain(`仅可调用以下工具名称：${BASE_NAMES.join(', ')}`)
  })

  it('延迟数为 0 时不加尾注（等同现状）', () => {
    expect(buildAvailableToolsHint(BASE_NAMES, { mcpDeferredCount: 0 })).not.toContain('MCP 工具索引')
    expect(buildToolCapabilityConventionHint(BASE_NAMES, { mcpDeferredCount: 0 })).not.toContain('tool_search')
  })
})
