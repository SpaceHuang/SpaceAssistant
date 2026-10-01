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

  it('读取工具描述反映桌面策略范围与远程工作目录边界', () => {
    for (const name of ['read_file', 'grep', 'list_directory']) {
      const description = BUILTIN_TOOL_DEFINITIONS.find((definition) => definition.name === name)!.description
      expect(description).toMatch(/普通桌面只读可按策略(?:访问|搜索)工作目录外(?:的)?路径/)
      expect(description).toMatch(/远程会话只允许工作目录内(?:的)?普通路径/)
    }
  })

  it('grep 使用新的单一 rg 工具契约，不包含部署实现信息', () => {
    const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'grep')!
    expect(def.description).toContain('ripgrep 默认正则语法')
    expect(def.description).not.toMatch(/跨平台|内置实现|系统 grep|findstr|打包路径/)
  })

  it('grep 契约放开为文件/目录递归搜索：required 不含 path（docs/develop/grep-recursive-search-capability-release-plan.md §4）', () => {
    const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'grep')!
    expect(def.input_schema.required).toContain('pattern')
    expect(def.input_schema.required).not.toContain('path')
  })

  it('grep 的 path description 不再宣称单文件契约', () => {
    const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'grep')!
    const pathProp = def.input_schema.properties.path as { description: string }
    expect(pathProp).toBeDefined()
    expect(pathProp.description).not.toContain('单个文件路径')
    expect(pathProp.description).not.toContain('不支持目录递归')
  })

  it('grep description 首句改为文件/目录搜索根契约', () => {
    const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'grep')!
    expect(def.description).toContain('搜索根为文件或目录')
    expect(def.description).toContain('传入目录时递归搜索')
    expect(def.description).not.toContain('不支持目录递归')
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

describe('run_shell 能力拒绝话术边界', () => {
  it('明确区分能力拒绝与安全策略，不诱导绕过', () => {
    const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === 'run_shell')!
    expect(def.description).toContain('能力拒绝不等于安全策略拒绝')
    expect(def.description).toContain('不得通过换途径或绕过通道征求许可')
  })
})
