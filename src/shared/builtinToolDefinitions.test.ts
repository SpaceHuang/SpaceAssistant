import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

describe('file-tool descriptions hint the path field name', () => {
  const fileTools = ['read_file', 'edit_file', 'write_file', 'list_directory', 'grep']
  for (const name of fileTools) {
    it(`${name} description mentions canonical field name and forbids aliases`, () => {
      const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === name)
      expect(def).toBeDefined()
      expect(def!.description).toMatch(/path/)
      // 明确「请勿使用」语义，而非仅出现别名（避免误写成「可使用 filePath」也能通过）
      expect(def!.description).toMatch(/请勿使用 filePath 或 file_path/)
    })
  }
})
