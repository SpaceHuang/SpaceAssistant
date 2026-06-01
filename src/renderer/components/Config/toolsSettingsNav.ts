import type { ToolsSettingsSubTab } from '../../store/configSlice'

export const DEFAULT_TOOLS_SETTINGS_SUB_TAB: ToolsSettingsSubTab = 'switches'

export const TOOLS_SETTINGS_NAV: {
  id: ToolsSettingsSubTab
  label: string
  hint: string
}[] = [
  { id: 'switches', label: '工具开关', hint: '控制 Agent 在对话中可调用的能力' },
  { id: 'file', label: '文件操作', hint: '写入确认方式与历史备份' },
  { id: 'script', label: '脚本执行', hint: 'Python 路径与脚本超时' },
  { id: 'shell', label: 'Shell 命令', hint: '终端执行与安全规则' },
  { id: 'browser', label: '网络访问', hint: '浏览器自动化与依赖检测' }
]

export function getToolsSettingsSectionLabel(id: ToolsSettingsSubTab): string {
  return TOOLS_SETTINGS_NAV.find((s) => s.id === id)?.label ?? '工具'
}

export function getToolsSettingsSectionHint(id: ToolsSettingsSubTab): string {
  return TOOLS_SETTINGS_NAV.find((s) => s.id === id)?.hint ?? ''
}
