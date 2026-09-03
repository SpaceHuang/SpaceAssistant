import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'
import { filterBuiltinToolsForRenderer } from './toolsConfigFilter'

describe('filterBuiltinToolsForRenderer（消费主进程清单的薄壳）', () => {
  it('仅返回主进程清单内的工具定义（清单驱动渲染，不自算）', () => {
    const visible = ['read_file', 'run_shell']
    const list = filterBuiltinToolsForRenderer(visible)
    expect(list.map((t) => t.name)).toEqual(['read_file', 'run_shell'])
    expect(list[0]).toBe(BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'read_file'))
  })

  it('清单之外的内置工具一律不返回（deniedTools/开关/exposure 规则已由主进程前置）', () => {
    const list = filterBuiltinToolsForRenderer(['read_file'])
    expect(list.map((t) => t.name)).toEqual(['read_file'])
  })

  it('空清单 → 空工具列表（冷启动空窗不渲染工具）', () => {
    expect(filterBuiltinToolsForRenderer([])).toEqual([])
  })

  it('清单中的未知名不产生工具定义', () => {
    const list = filterBuiltinToolsForRenderer(['no_such_tool', 'write_file'])
    expect(list.map((t) => t.name)).toEqual(['write_file'])
  })
})
