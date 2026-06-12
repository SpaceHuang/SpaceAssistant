import { app, BrowserWindow, screen } from 'electron'
import path from 'path'
import { isWebContentsAlive } from './safeWebContentsSend'
import type { FloatingNotificationData } from '../src/shared/api'

const FLOATING_WINDOW_WIDTH = 280
const FLOATING_WINDOW_HEIGHT = 108
const EDGE_MARGIN = 20

export function calculateFloatingWindowPosition(anchorWindow?: BrowserWindow | null): { x: number; y: number } {
  const display =
    anchorWindow && !anchorWindow.isDestroyed()
      ? screen.getDisplayMatching(anchorWindow.getBounds())
      : screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea
  return {
    x: x + width - FLOATING_WINDOW_WIDTH - EDGE_MARGIN,
    y: y + height - FLOATING_WINDOW_HEIGHT - EDGE_MARGIN
  }
}

export function getFloatingNotificationDevUrl(): string {
  const port = process.env.VITE_DEV_SERVER_PORT ?? '9240'
  const base = process.env.ELECTRON_START_URL ?? `http://127.0.0.1:${port}/`
  const normalized = base.endsWith('/') ? base : `${base}/`
  return `${normalized}floating-notification.html`
}

function getFloatingNotificationHtmlPath(mainDirname: string): string {
  return path.join(mainDirname, '..', '..', 'dist', 'renderer', 'floating-notification.html')
}

export function createFloatingNotificationWindow(
  mainDirname: string,
  anchorWindow?: BrowserWindow | null
): BrowserWindow {
  const { x, y } = calculateFloatingWindowPosition(anchorWindow)

  const win = new BrowserWindow({
    width: FLOATING_WINDOW_WIDTH,
    height: FLOATING_WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(mainDirname, 'floatingNotificationPreload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(false, { forward: true })

  if (!app.isPackaged) {
    void win.loadURL(getFloatingNotificationDevUrl())
  } else {
    void win.loadFile(getFloatingNotificationHtmlPath(mainDirname))
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.show()
    win.moveTop()
  })

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
