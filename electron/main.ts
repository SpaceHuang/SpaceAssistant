import path from 'path'
import http from 'http'
import https from 'https'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { registerAppIpcHandlers } from './appIpc'
import { registerClaudeStreamHandlers } from './claudeStreamHandlers'
import { mergeToolsConfig } from '../src/shared/domainTypes'
import { getConfigValue, openDatabase, setConfigValue } from './database'
import { SessionBackupManager } from './sessionBackupManager'
import { setupAppMenu } from './menu'
import { setMainWindow } from './windowRef'
import { decryptSecret, encryptSecret, isSecretStorageAvailable } from './secureApiKey'

const API_KEY_CONFIG_KEY = 'secrets.apiKeyEnc'
const TOOLS_CONFIG_KEY = 'config.tools'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForUrlOk(urlStr: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const url = new URL(urlStr)
    const mod = url.protocol === 'https:' ? https : http
    const ok = await new Promise<boolean>((resolve) => {
      const req = mod.request(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : undefined,
          path: url.pathname + url.search,
          method: 'GET',
          timeout: 1500
        },
        (res) => {
          res.resume()
          resolve(Boolean(res.statusCode && res.statusCode < 500))
        }
      )
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.on('error', () => resolve(false))
      req.end()
    })
    if (ok) return
    await sleep(250)
  }
  throw new Error(`Timeout waiting for renderer URL: ${urlStr}`)
}

function getDevServerMissingHtml(expectedUrl: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>开发服务器未就绪</title></head><body>
  <p>无法连接 <code>${expectedUrl}</code>。请先运行 <code>npm run dev</code> 或单独启动 <code>npm run dev:renderer</code>。</p></body></html>`
}

function getRendererURL(): string {
  if (process.env.ELECTRON_START_URL) return process.env.ELECTRON_START_URL
  const port = process.env.VITE_DEV_SERVER_PORT ?? '9240'
  return `http://127.0.0.1:${port}`
}

function getRendererIndexPath(): string {
  return path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html')
}

let workDirState = ''

async function createMainWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setMainWindow(win)

  if (app.isPackaged) {
    await win.loadFile(getRendererIndexPath())
  } else {
    const url = getRendererURL()
    try {
      await waitForUrlOk(url, 90_000)
      await win.loadURL(url)
    } catch {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: '开发服务器未就绪',
        message: `无法连接到 Vite（${url}）。请运行 npm run dev。`
      })
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(getDevServerMissingHtml(url))
      await win.loadURL(dataUrl)
    }
  }

  win.on('closed', () => {
    setMainWindow(null)
  })
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'spaceassistant-data.json')
  const db = openDatabase(dbPath)

  workDirState = getConfigValue(db, 'config.workDir') ?? path.join(app.getPath('userData'), 'workspace')

  const backup = new SessionBackupManager(workDirState)

  const getApiKey = async (): Promise<string | null> => {
    const enc = getConfigValue(db, API_KEY_CONFIG_KEY)
    if (!enc) return null
    if (!isSecretStorageAvailable()) return null
    try {
      return decryptSecret(enc)
    } catch {
      return null
    }
  }

  const setApiKey = async (value: string): Promise<void> => {
    setConfigValue(db, API_KEY_CONFIG_KEY, encryptSecret(value))
  }

  ipcMain.handle('ping', async () => 'pong')

  registerClaudeStreamHandlers(ipcMain, {
    getApiKey,
    getWorkDir: () => workDirState,
    getUserDataPath: () => app.getPath('userData'),
    getToolsConfig: () => {
      const raw = getConfigValue(db, TOOLS_CONFIG_KEY)
      if (!raw) return mergeToolsConfig(null)
      try {
        return mergeToolsConfig(JSON.parse(raw) as Parameters<typeof mergeToolsConfig>[0])
      } catch {
        return mergeToolsConfig(null)
      }
    }
  })

  registerAppIpcHandlers(ipcMain, {
    db,
    backup,
    getWorkDir: () => workDirState,
    setWorkDir: (d: string) => {
      workDirState = d
    },
    getUserDataPath: () => app.getPath('userData'),
    getApiKey,
    setApiKey
  })

  void createMainWindow()
  setupAppMenu()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
})
