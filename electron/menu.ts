import { app, Menu, shell } from 'electron'
import { getMainWindow } from './windowRef'
import type { LocalizedMessage, TranslateFn } from '../src/shared/localization'

/**
 * 应用菜单（偏差 13 收口）：主进程不产出文案——本文件只持有键化消息（MENU_LABEL_MESSAGES），
 * 显示处经注入的 translate 端口解析；文案唯一真源是渲染端 i18n 资源（menu 命名空间）。
 */

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const w = getMainWindow()
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

export type MenuLabelKey =
  | 'file'
  | 'edit'
  | 'view'
  | 'help'
  | 'closeWindow'
  | 'quit'
  | 'devTools'
  | 'usageStats'
  | 'settings'
  | 'about'
  | 'docs'

export const MENU_LABEL_MESSAGES: Record<MenuLabelKey, LocalizedMessage> = {
  file: { key: 'menu.file' },
  edit: { key: 'menu.edit' },
  view: { key: 'menu.view' },
  help: { key: 'menu.help' },
  closeWindow: { key: 'menu.closeWindow' },
  quit: { key: 'menu.quit' },
  devTools: { key: 'menu.devTools' },
  usageStats: { key: 'menu.usageStats' },
  settings: { key: 'menu.settings' },
  about: { key: 'menu.about' },
  docs: { key: 'menu.docs' }
}

export type MenuLabels = Record<MenuLabelKey, string>

export interface MenuTemplateOptions {
  isMac: boolean
  /** mac 应用菜单标题（Electron 运行时传 app.name；纯 node 环境（测试）显式传入）。 */
  appName?: string
}

/** 纯函数构造菜单模板：label 一律来自外部解析好的 labels（键化 → translate 端口），本模块零文案。 */
export function buildMenuTemplate(labels: MenuLabels, options: MenuTemplateOptions): Electron.MenuItemConstructorOptions[] {
  const { isMac } = options

  const fileSubmenu: Electron.MenuItemConstructorOptions[] = []
  if (isMac) {
    fileSubmenu.push({ role: 'close', label: labels.closeWindow })
  } else {
    fileSubmenu.push({
      label: labels.quit,
      accelerator: 'Ctrl+Q',
      click: () => app.quit()
    })
  }

  const template: Electron.MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: options.appName ?? app?.name ?? 'SpaceAssistant',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: labels.file,
    submenu: fileSubmenu
  })

  if (isMac) {
    template.push({ role: 'editMenu', label: labels.edit })
  }

  template.push({
    label: labels.view,
    submenu: [
      {
        label: labels.devTools,
        accelerator: isMac ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
        click: () => {
          const w = getMainWindow()
          if (!w) return
          w.webContents.toggleDevTools()
        }
      },
      { type: 'separator' },
      {
        label: labels.usageStats,
        click: () => sendToRenderer('app:open-usage-stats')
      },
      { type: 'separator' },
      {
        label: labels.settings,
        accelerator: isMac ? 'Cmd+,' : 'Ctrl+,',
        click: () => sendToRenderer('app:open-settings')
      }
    ]
  })

  template.push({
    label: labels.help,
    submenu: [
      {
        label: labels.about,
        click: () => sendToRenderer('app:open-about')
      },
      {
        label: labels.docs,
        click: () => void shell.openExternal('https://github.com/SpaceHuang/SpaceAssistant')
      }
    ]
  })

  if (isMac) {
    template.push({ role: 'windowMenu' })
  }

  return template
}

export function resolveMenuLabels(translate: TranslateFn): MenuLabels {
  return Object.fromEntries(
    (Object.keys(MENU_LABEL_MESSAGES) as MenuLabelKey[]).map((k) => [k, translate(MENU_LABEL_MESSAGES[k])])
  ) as MenuLabels
}

export function setupAppMenu(translate: TranslateFn): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate(resolveMenuLabels(translate), { isMac: process.platform === 'darwin', appName: app?.name })
    )
  )
}

export function rebuildAppMenu(translate: TranslateFn): void {
  setupAppMenu(translate)
}
