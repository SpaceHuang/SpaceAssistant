import { app, Menu, shell } from 'electron'
import { getMainWindow } from './windowRef'
import { getMenuLabels } from '../src/shared/menuLabels'

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const w = getMainWindow()
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

export function setupAppMenu(locale: string = 'zh-CN'): void {
  const isMac = process.platform === 'darwin'
  const labels = getMenuLabels(locale)

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
      label: app.name,
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function rebuildAppMenu(locale: string): void {
  setupAppMenu(locale)
}

