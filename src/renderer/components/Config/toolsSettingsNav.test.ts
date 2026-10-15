import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_SETTINGS_SUB_TAB, TOOLS_SETTINGS_SUB_TABS } from './toolsSettingsNav'

describe('toolsSettingsNav（工具页子 Tab）', () => {
  it('工具页不再包含全局安全策略页', () => {
    expect(TOOLS_SETTINGS_SUB_TABS).toContain('switches')
    expect(TOOLS_SETTINGS_SUB_TABS).not.toContain('security')
  })

  it('默认子 Tab 为工具开关', () => {
    expect(DEFAULT_TOOLS_SETTINGS_SUB_TAB).toBe('switches')
  })
})
