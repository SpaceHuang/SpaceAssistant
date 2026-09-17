import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

describe('file-tool descriptions hint the path field name', () => {
  const fileTools = ['read_file', 'edit_file', 'write_file', 'list_directory']
  for (const name of fileTools) {
    it(`${name} description mentions canonical field name and forbids aliases`, () => {
      const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === name)
      expect(def).toBeDefined()
      expect(def!.description).toMatch(/path/)
      // 明确「请勿使用」语义，而非仅出现别名（避免误写成「可使用 filePath」也能通过）
      expect(def!.description).toMatch(/请勿使用 filePath 或 file_path/)
    })
  }

  it('grep 使用新的单一 rg 工具契约，不包含部署实现信息', () => {
    const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'grep')!
    expect(def.description).toContain('ripgrep 默认正则语法')
    expect(def.description).not.toMatch(/跨平台|内置实现|系统 grep|findstr|打包路径/)
  })
})

describe('toolkit 网关工具（docs/requirement/agent-toolkit-capability-gateway-requirement.md §8）', () => {
  const findDef = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'toolkit.find')
  const callDef = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'toolkit.call')

  it('两条网关工具已定义', () => {
    expect(findDef).toBeDefined()
    expect(callDef).toBeDefined()
  })

  it('browser_detect 已收编为 env.browserDetect 能力，不再占据模型面', () => {
    expect(BUILTIN_TOOL_DEFINITIONS.some((d) => d.name === 'browser_detect')).toBe(false)
  })

  it('上下文预算回归：两网关工具 schema 序列化体积 < 2 KiB（防未来无意膨胀）', () => {
    const serialized = JSON.stringify([findDef, callDef]) ?? ''
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(2048)
  })
})
