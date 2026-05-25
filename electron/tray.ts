import fs from 'fs'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow } from 'electron'
import { logAgentEvent } from './agentLogger/agentLogger'
import {
  buildTrayMenuTemplate,
  handleShowMainWindow,
  TRAY_TOOLTIP
} from './trayLogic'
import { resolveTrayIconPath } from './trayIconPath'

export interface TrayDeps {
  createMainWindow: () => Promise<void>
  getMainWindow: () => BrowserWindow | null
  mainDirname: string
}

let trayInstance: Tray | null = null
let trayEnabled = false
let trayDeps: TrayDeps | null = null

export function isTrayEnabled(): boolean {
  return trayEnabled
}

export async function showMainWindow(): Promise<void> {
  if (!trayDeps) return
  await handleShowMainWindow(trayDeps.getMainWindow, trayDeps.createMainWindow)
}

function buildTrayImage(iconPath: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') {
    image.setTemplateImage(true)
  }
  return image
}

function attachTrayEvents(tray: Tray): void {
  tray.on('double-click', () => {
    void showMainWindow()
  })
}

export function initTray(deps: TrayDeps): boolean {
  if (trayInstance) {
    trayEnabled = true
    return true
  }

  trayDeps = deps
  const iconPath = resolveTrayIconPath(process.platform, app.isPackaged, deps.mainDirname)

  if (!iconPath || !fs.existsSync(iconPath)) {
    logAgentEvent('error', 'tray.init_failed', {
      reason: 'icon_missing',
      iconPath: iconPath ?? '(unresolved)'
    })
    if (!app.isPackaged) {
      console.error('[Tray] 托盘图标缺失，回退为关窗即退出:', iconPath)
    }
    trayEnabled = false
    return false
  }

  try {
    const tray = new Tray(buildTrayImage(iconPath))
    tray.setToolTip(TRAY_TOOLTIP)

    const menu = Menu.buildFromTemplate(
      buildTrayMenuTemplate({
        showMainWindow: () => void showMainWindow(),
        quitApp: () => app.quit()
      }) as Electron.MenuItemConstructorOptions[]
    )
    tray.setContextMenu(menu)
    attachTrayEvents(tray)

    trayInstance = tray
    trayEnabled = true
    logAgentEvent('info', 'tray.init_ok', { iconPath })
    return true
  } catch (err) {
    logAgentEvent('error', 'tray.init_failed', {
      reason: 'exception',
      message: err instanceof Error ? err.message : String(err)
    })
    if (!app.isPackaged) {
      console.error('[Tray] 初始化失败，回退为关窗即退出:', err)
    }
    trayEnabled = false
    return false
  }
}

export function destroyTray(): void {
  if (trayInstance && !trayInstance.isDestroyed()) {
    trayInstance.destroy()
  }
  trayInstance = null
  trayEnabled = false
  trayDeps = null
}
