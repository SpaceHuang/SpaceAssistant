import { app, BrowserWindow, nativeTheme } from 'electron'
import { getAppIconTheme, resolveAppIconPath } from './appIconPath'
import { getMainWindow } from './windowRef'

let themeListenerRegistered = false

export function resolveWindowIconPath(mainDirname: string): string {
  const theme = getAppIconTheme(nativeTheme.shouldUseDarkColors)
  return resolveAppIconPath(process.platform, app.isPackaged, mainDirname, theme)
}

export function applyMainWindowIcon(win: BrowserWindow, mainDirname: string): void {
  win.setIcon(resolveWindowIconPath(mainDirname))
}

export function setupWindowIconThemeListener(mainDirname: string): void {
  if (themeListenerRegistered) return
  themeListenerRegistered = true

  nativeTheme.on('updated', () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      applyMainWindowIcon(win, mainDirname)
    }
  })
}
