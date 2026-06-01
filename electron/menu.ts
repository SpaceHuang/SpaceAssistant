import { app, Menu, shell } from 'electron'
import { getMainWindow } from './windowRef'

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const w = getMainWindow()
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

export function setupAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const fileSubmenu: Electron.MenuItemConstructorOptions[] = []
  if (isMac) {
    fileSubmenu.push({ role: 'close', label: '关闭窗口' })
  } else {
    fileSubmenu.push({
      label: '退出',
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
    label: '文件',
    submenu: fileSubmenu
  })

  template.push({
    label: '查看',
    submenu: [
      {
        label: '开发者工具',
        accelerator: isMac ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
        click: () => {
          const w = getMainWindow()
          if (!w) return
          w.webContents.toggleDevTools()
        }
      },
      { type: 'separator' },
      {
        label: '设置',
        accelerator: isMac ? 'Cmd+,' : 'Ctrl+,',
        click: () => sendToRenderer('app:open-settings')
      }
    ]
  })

  template.push({
    label: '帮助',
    submenu: [
      {
        label: '关于',
        click: () => sendToRenderer('app:open-about')
      },
      {
        label: '文档',
        click: () => void shell.openExternal('https://github.com/SpaceHuang/SpaceAssistant')
      }
    ]
  })

  if (isMac) {
    template.push({ role: 'windowMenu' })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
