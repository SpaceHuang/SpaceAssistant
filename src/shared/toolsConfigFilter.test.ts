import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from './domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'
import { filterBuiltinToolsForRenderer } from './toolsConfigFilter'

describe('filterBuiltinToolsForRenderer', () => {
  it('未提供 visibleTools 时走旧滤镜（cfg 开关生效）', () => {
    expect(filterBuiltinToolsForRenderer({ ...DEFAULT_TOOLS_CONFIG, enabled: false })).toEqual([])
  })

  it('提供 visibleTools 时作薄壳映射：仅返回清单内的工具定义', () => {
    const visible = ['read_file', 'run_shell']
    const list = filterBuiltinToolsForRenderer(DEFAULT_TOOLS_CONFIG, null, null, null, visible)
    expect(list.map((t) => t.name)).toEqual(['read_file', 'run_shell'])
    expect(list[0]).toBe(BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'read_file'))
  })

  it('薄壳无视 allowedTools/deniedTools（已由主进程前置，渲染端不重复过滤）', () => {
    const list = filterBuiltinToolsForRenderer(
      { ...DEFAULT_TOOLS_CONFIG, deniedTools: ['read_file'] },
      null,
      null,
      null,
      ['read_file', 'write_file']
    )
    expect(list.map((t) => t.name)).toEqual(['read_file', 'write_file'])
  })
})
