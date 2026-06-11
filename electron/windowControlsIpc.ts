import { app, type IpcMain } from 'electron'
import { getMainWindow } from './windowRef'

function getFocusedMainWindow() {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return null
  return win
}

export function registerWindowControlsIpc(ipcMainInstance: IpcMain): void {
  ipcMainInstance.handle('window:get-platform', () => process.platform)

  ipcMainInstance.handle('window:is-maximized', () => {
    const win = getFocusedMainWindow()
    return win?.isMaximized() ?? false
  })

  ipcMainInstance.handle('window:minimize', () => {
    getFocusedMainWindow()?.minimize()
  })

  ipcMainInstance.handle('window:maximize-toggle', () => {
    const win = getFocusedMainWindow()
    if (!win) return false
    if (win.isMaximized()) {
      win.unmaximize()
      return false
    }
    win.maximize()
    return true
  })

  ipcMainInstance.handle('window:close', () => {
    getFocusedMainWindow()?.close()
  })

  ipcMainInstance.handle('app:quit', () => {
    app.quit()
  })

  ipcMainInstance.handle('app:toggle-devtools', () => {
    const win = getFocusedMainWindow()
    if (!win) return
    win.webContents.toggleDevTools()
  })
}

export function attachWindowMaximizeEvents(win: Electron.BrowserWindow): void {
  const notify = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximize-changed', win.isMaximized())
  }
  win.on('maximize', notify)
  win.on('unmaximize', notify)
}
