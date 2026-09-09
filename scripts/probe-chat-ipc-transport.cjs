const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const sampleCount = Number(process.env.SPACEASSISTANT_IPC_SAMPLES || 1000)
const preload = path.join(__dirname, 'probe-chat-ipc-transport-preload.cjs')

app.disableHardwareAcceleration()
ipcMain.handle('probe:ipc-roundtrip', (_event, value) => value)

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload }
  })
  try {
    await window.loadURL('data:text/html,<html><body>ipc transport probe</body></html>')
    const result = await window.webContents.executeJavaScript(
      `window.ipcTransportProbe.run(${sampleCount})`,
      true
    )
    console.log(`[chat-ipc-transport] ${JSON.stringify(result)}`)
    window.destroy()
    app.quit()
  } catch (error) {
    console.error('[chat-ipc-transport] failed:', error)
    window.destroy()
    app.exit(1)
  }
})
