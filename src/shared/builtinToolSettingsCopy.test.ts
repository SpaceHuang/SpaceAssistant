import { describe, expect, it } from 'vitest'
import { ALL_BUILTIN_TOOL_NAMES } from './builtinToolDefinitions'
import { getBuiltinToolI18nKeys } from './builtinToolSettingsCopy'

describe('getBuiltinToolI18nKeys', () => {
  it('returns i18n keys for every builtin tool with summary and disabledHint', () => {
    for (const name of ALL_BUILTIN_TOOL_NAMES) {
      const keys = getBuiltinToolI18nKeys(name)
      expect(keys.summary, name).toBeTruthy()
      expect(keys.disabledHint, name).toBeTruthy()
    }
  })
})
