import { describe, expect, it } from 'vitest'
import { ALL_BUILTIN_TOOL_NAMES } from './builtinToolDefinitions'
import { BUILTIN_TOOL_SETTINGS_COPY } from './builtinToolSettingsCopy'

describe('BUILTIN_TOOL_SETTINGS_COPY', () => {
  it('covers every builtin tool with summary and disabledHint', () => {
    for (const name of ALL_BUILTIN_TOOL_NAMES) {
      const copy = BUILTIN_TOOL_SETTINGS_COPY[name]
      expect(copy?.summary, name).toBeTruthy()
      expect(copy?.disabledHint, name).toBeTruthy()
    }
  })
})
