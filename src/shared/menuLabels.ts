export type MenuLocale = 'zh-CN' | 'en-US'

export interface MenuLabels {
  file: string
  edit: string
  view: string
  help: string
  closeWindow: string
  quit: string
  devTools: string
  settings: string
  about: string
  docs: string
}

export const MENU_LABELS: Record<MenuLocale, MenuLabels> = {
  'zh-CN': {
    file: '文件',
    edit: '编辑',
    view: '查看',
    help: '帮助',
    closeWindow: '关闭窗口',
    quit: '退出',
    devTools: '开发者工具',
    settings: '设置',
    about: '关于',
    docs: '文档'
  },
  'en-US': {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    help: 'Help',
    closeWindow: 'Close Window',
    quit: 'Quit',
    devTools: 'Developer Tools',
    settings: 'Settings',
    about: 'About',
    docs: 'Documentation'
  }
}

export function getMenuLabels(locale: string): MenuLabels {
  return MENU_LABELS[locale as MenuLocale] ?? MENU_LABELS['zh-CN']
}
