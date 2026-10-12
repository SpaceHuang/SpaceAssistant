import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const packagedApp = process.argv.find((argument) => argument.startsWith('--app='))?.slice('--app='.length)
const asNode = Boolean(process.env.ELECTRON_RUN_AS_NODE)
const electron = asNode ? { app: { whenReady: () => Promise.resolve(), quit: () => undefined } } : await import('electron')
const { app } = electron
const appRoot = packagedApp ? (packagedApp.endsWith('.app') ? path.resolve(packagedApp, 'Contents', 'Resources', 'app') : path.resolve(packagedApp)) : path.resolve('.')
const require = createRequire(import.meta.url)
const { runStorageProfileWorker } = require(path.join(appRoot, 'dist-electron/electron/storageProfile/storageProfileWorkerClient.js'))

const timeout = setTimeout(() => { console.error('[storage-profile-worker-smoke] timed out'); process.exit(1) }, 30_000)
let root
app.whenReady().then(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-storage-worker-smoke-'))
  const dbPath = path.join(root, 'smoke.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, thinking TEXT, attachments TEXT, content_segments TEXT); INSERT INTO sessions VALUES('s1', 'smoke')")
  } finally { db.close() }
  const response = await runStorageProfileWorker({ type: 'overview', dbPath })
  if (response.type !== 'overview' || response.result.database.complete !== true || response.result.tables.messages?.rows !== 0) throw new Error(`unexpected worker response: ${JSON.stringify(response)}`)
  let ipcMs = null
  let ipcDelayMs = null
  if (!asNode) {
    const { BrowserWindow, ipcMain } = electron
    ipcMain.handle('storage-profile-smoke:overview', (_event, requestedPath) => runStorageProfileWorker({ type: 'overview', dbPath: requestedPath }))
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } })
    const ipcStart = performance.now()
    const probeStart = performance.now()
    const eventLoopProbe = new Promise((resolve) => setTimeout(() => resolve(performance.now() - probeStart), 0))
    const ipcResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IPC smoke timed out')), 10_000)
      ipcMain.once('storage-profile-smoke:done', (_event, result) => { clearTimeout(timer); resolve(result) })
      const script = `const { ipcRenderer } = require('electron'); ipcRenderer.invoke('storage-profile-smoke:overview', ${JSON.stringify(dbPath)}).then((value) => ipcRenderer.send('storage-profile-smoke:done', value)).catch((error) => ipcRenderer.send('storage-profile-smoke:done', { error: error.message }))`
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<script>${script}</script>`)}`)
    }).finally(() => window.destroy())
    ipcMs = Number((performance.now() - ipcStart).toFixed(3))
    ipcDelayMs = Number((await eventLoopProbe).toFixed(3))
    if (ipcResult?.type !== 'overview' || ipcDelayMs >= 50) throw new Error(`IPC smoke failed response/event-loop check (${ipcMs}ms total, ${ipcDelayMs}ms event loop)`)
  }
  console.log(`[storage-profile-worker-smoke] ok electron=${process.versions.electron} ipcTotalMs=${ipcMs ?? 'n/a'} eventLoopDelayMs=${ipcDelayMs ?? 'n/a'} worker=${path.join(appRoot, 'dist-electron/electron/storageProfile/storageProfileWorker.js')}`)
}).catch((error) => { console.error('[storage-profile-worker-smoke] failed', error); process.exitCode = 1 }).finally(() => {
  clearTimeout(timeout)
  if (root) fs.rmSync(root, { recursive: true, force: true })
  app.quit()
})
