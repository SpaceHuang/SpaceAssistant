import type { ToolsSettingsSubTab } from '../../store/configSlice'
import type { NamespaceKeyMap } from '../../i18n/types'

export const DEFAULT_TOOLS_SETTINGS_SUB_TAB: ToolsSettingsSubTab = 'switches'

export const TOOLS_SETTINGS_SUB_TABS: ToolsSettingsSubTab[] = ['switches', 'file', 'script', 'shell', 'browser', 'workspaceLayout']

type ConfigT = (key: NamespaceKeyMap['config'], options?: Record<string, unknown>) => string

const NAV_LABEL_KEYS: Record<ToolsSettingsSubTab, NamespaceKeyMap['config']> = {
  switches: 'tools.nav.switches.label',
  file: 'tools.nav.file.label',
  script: 'tools.nav.script.label',
  shell: 'tools.nav.shell.label',
  browser: 'tools.nav.browser.label',
  workspaceLayout: 'tools.nav.workspaceLayout.label'
}

const NAV_HINT_KEYS: Record<ToolsSettingsSubTab, NamespaceKeyMap['config']> = {
  switches: 'tools.nav.switches.hint',
  file: 'tools.nav.file.hint',
  script: 'tools.nav.script.hint',
  shell: 'tools.nav.shell.hint',
  browser: 'tools.nav.browser.hint',
  workspaceLayout: 'tools.nav.workspaceLayout.hint'
}

export function getToolsSettingsNav(t: ConfigT) {
  return TOOLS_SETTINGS_SUB_TABS.map((id) => ({
    id,
    label: t(NAV_LABEL_KEYS[id]),
    hint: t(NAV_HINT_KEYS[id])
  }))
}

export function getToolsSettingsSectionLabel(id: ToolsSettingsSubTab, t: ConfigT): string {
  return t(NAV_LABEL_KEYS[id] ?? 'tools.defaultSectionLabel')
}

export function getToolsSettingsSectionHint(id: ToolsSettingsSubTab, t: ConfigT): string {
  return t(NAV_HINT_KEYS[id])
}
