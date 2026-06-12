import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { isWebContentsAlive } from './safeWebContentsSend'
import type { FloatingNotificationData } from '../src/shared/api'

const FLOATING_WINDOW_WIDTH = 280
const FLOATING_WINDOW_HEIGHT = 108
const EDGE_MARGIN = 20

export function calculateFloatingWindowPosition(): { x: number; y: number } {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { x, y, width, height } = primaryDisplay.workArea
  return {
    x: x + width - FLOATING_WINDOW_WIDTH - EDGE_MARGIN,
    y: y + height - FLOATING_WINDOW_HEIGHT - EDGE_MARGIN
  }
}

function getFloatingNotificationUrl(): string {
  if (process.env.ELECTRON_START_URL) {
    return `${process.env.ELECTRON_START_URL}#/floating-notification`
  }
  const port = process.env.VITE_DEV_SERVER_PORT ?? '9240'
  return `http://127.0.0.1:${port}#/floating-notification`
}

function getFloatingNotificationHtmlPath(mainDirname: string): string {
  return path.join(mainDirname, '..', '..', 'dist', 'renderer', 'floating-notification.html')
}

export function createFloatingNotificationWindow(mainDirname: string): BrowserWindow {
  const { x, y } = calculateFloatingWindowPosition()

  const win = new BrowserWindow({
    width: FLOATING_WINDOW_WIDTH,
    height: FLOATING_WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(mainDirname, 'floatingNotificationPreload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 非内容区域鼠标事件穿透
  win.setIgnoreMouseEvents(false, { forward: true })

  if (process.env.ELECTRON_START_URL || process.env.VITE_DEV_SERVER_PORT) {
    void win.loadURL(getFloatingNotificationUrl())
  } else {
    void win.loadFile(getFloatingNotificationHtmlPath(mainDirname))
  }

  return win
}

export function pushDataToFloatingWindow(
  win: BrowserWindow | null,
  data: FloatingNotificationData
): void {
  if (!win || win.isDestroyed() || !isWebContentsAlive(win.webContents)) return
  win.webContents.send('notification:update', data)
}

export function sendCloseToFloatingWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || !isWebContentsAlive(win.webContents)) return
  win.webContents.send('notification:close')
}

export function destroyFloatingNotificationWindow(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) {
    win.destroy()
  }
}
