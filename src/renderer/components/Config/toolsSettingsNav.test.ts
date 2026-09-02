import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_SETTINGS_SUB_TAB, TOOLS_SETTINGS_SUB_TABS } from './toolsSettingsNav'

describe('toolsSettingsNav（工具页子 Tab）', () => {
  it('工具开关是独立子 Tab，与安全页并列', () => {
    expect(TOOLS_SETTINGS_SUB_TABS).toContain('switches')
    expect(TOOLS_SETTINGS_SUB_TABS).toContain('security')
    expect(TOOLS_SETTINGS_SUB_TABS.indexOf('switches')).toBeLessThan(
      TOOLS_SETTINGS_SUB_TABS.indexOf('security')
    )
  })

  it('默认子 Tab 为工具开关', () => {
    expect(DEFAULT_TOOLS_SETTINGS_SUB_TAB).toBe('switches')
  })
})
