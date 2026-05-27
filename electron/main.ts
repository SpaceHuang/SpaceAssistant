import path from 'path'
import http from 'http'
import https from 'https'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { registerAppIpcHandlers } from './appIpc'
import { registerClaudeStreamHandlers } from './claudeStreamHandlers'
import type { PlanConfig } from '../src/shared/domainTypes'
import { mergePlanConfig, mergeToolsConfig, mergeWikiConfig } from '../src/shared/domainTypes'
import {
  autoStartFeishuEventIfNeeded,
  createFeishuBundle,
  registerFeishuIpcHandlers,
  shutdownFeishuServices
} from './feishu/feishuIpc'
import { getConfigValue, openDatabase, setConfigValue } from './database'
import type { AppDatabase } from './database'
import { SessionBackupManager } from './sessionBackupManager'
import { setupAppMenu } from './menu'
import { getMainWindow, setMainWindow } from './windowRef'
import { getAgentLogDir, initAgentLogger, logAgentEvent } from './agentLogger/agentLogger'
import { initFeishuCliLogger } from './feishu/feishuCliLogger'
import { encryptSecret } from './secureApiKey'
import { loadProjectMemory, startMemoryWatcher, stopMemoryWatcher } from './projectMemory'
import {
  getActiveLlmService,
  migrateLegacyLlmServicesIfNeeded,
  persistLlmServices,
  readActiveLlmServiceId,
  readLlmServices
} from './llmServiceResolver'
import { destroyTray, initTray, isTrayEnabled, showMainWindow } from './tray'
import { setupWindowCloseHandler } from './trayLogic'

const API_KEY_CONFIG_KEY = 'secrets.apiKeyEnc'
const TOOLS_CONFIG_KEY = 'config.tools'
const WIKI_CONFIG_KEY = 'config.wiki'
const PLAN_CONFIG_KEY = 'config.plan'

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
let appDb: AppDatabase | null = null
let isQuitting = false
let quitCleanupDone = false

export function getIsQuitting(): boolean {
  return isQuitting
}

export async function createMainWindow(): Promise<void> {
  const existing = getMainWindow()
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // backgroundThrottling 默认为 true；隐藏窗口后 renderer 自动节流（NFR-10）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setMainWindow(win)

  setupWindowCloseHandler(win, getIsQuitting, isTrayEnabled)

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
  appDb = db

  workDirState = getConfigValue(db, 'config.workDir') ?? path.join(app.getPath('userData'), 'workspace')

  // Initialize project memory
  loadProjectMemory(workDirState).catch((err) => {
    console.warn('[projectMemory] init load failed:', err.message)
  })
  startMemoryWatcher(workDirState, (state) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('project-memory:state-changed', state)
    }
  })

  initAgentLogger({
    getWorkDir: () => workDirState,
    isPackaged: app.isPackaged,
    mainDirname: __dirname
  })
  const agentLogDir = getAgentLogDir()
  logAgentEvent('info', 'agent.startup', {
    workDir: workDirState,
    isPackaged: app.isPackaged,
    logDir: agentLogDir
  })
  if (!app.isPackaged && agentLogDir) {
    console.info('[AgentLogger] 开发模式日志目录:', agentLogDir)
  }

  initFeishuCliLogger({
    getWorkDir: () => workDirState,
    isPackaged: app.isPackaged,
    mainDirname: __dirname
  })

  const backup = new SessionBackupManager(workDirState)

  const getApiKey = async (): Promise<string | null> => {
    return getActiveLlmService(db).getApiKey()
  }

  const setApiKey = async (value: string): Promise<void> => {
    migrateLegacyLlmServicesIfNeeded(db)
    const activeId = readActiveLlmServiceId(db) ?? readLlmServices(db)[0]?.id
    if (activeId) {
      const services = readLlmServices(db)
      persistLlmServices(db, services, activeId, { [activeId]: value })
    } else {
      setConfigValue(db, API_KEY_CONFIG_KEY, encryptSecret(value))
    }
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
    },
    getWikiConfig: () => {
      const raw = getConfigValue(db, WIKI_CONFIG_KEY)
      if (!raw) return mergeWikiConfig(null)
      try {
        return mergeWikiConfig(JSON.parse(raw) as Parameters<typeof mergeWikiConfig>[0])
      } catch {
        return mergeWikiConfig(null)
      }
    },
    getAppDatabase: () => db,
    getProjectMemoryEnabled: () => true,
    getPlanConfig: (): PlanConfig => {
      const raw = getConfigValue(db, PLAN_CONFIG_KEY)
      if (!raw) return mergePlanConfig(null)
      try {
        return mergePlanConfig(JSON.parse(raw) as Partial<PlanConfig>)
      } catch {
        return mergePlanConfig(null)
      }
    }
  })

  registerAppIpcHandlers(ipcMain, {
    db,
    backup,
    getWorkDir: () => workDirState,
    setWorkDir: (d: string) => {
      workDirState = d
      loadProjectMemory(d).catch((err) => {
        console.warn('[projectMemory] reload failed:', err.message)
      })
      startMemoryWatcher(d, (state) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-memory:state-changed', state)
        }
      })
    },
    getUserDataPath: () => app.getPath('userData'),
    getApiKey,
    setApiKey
  })

  const modelName = () => getConfigValue(db, 'config.model') ?? 'claude-sonnet-4-20250514'
  createFeishuBundle({
    db,
    getUserDataPath: () => app.getPath('userData'),
    getWorkDir: () => workDirState,
    getApiKey,
    getBaseUrl: () => getConfigValue(db, 'config.baseUrl') ?? '',
    getModel: modelName,
    getMaxParallel: () => {
      const raw = getConfigValue(db, 'config.maxParallelChatSessions')
      return raw ? Number(raw) : 3
    },
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
  registerFeishuIpcHandlers(ipcMain, {
    db,
    getUserDataPath: () => app.getPath('userData'),
    getWorkDir: () => workDirState,
    getApiKey,
    getBaseUrl: () => getConfigValue(db, 'config.baseUrl') ?? '',
    getModel: modelName,
    getMaxParallel: () => {
      const raw = getConfigValue(db, 'config.maxParallelChatSessions')
      return raw ? Number(raw) : 3
    },
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
  void autoStartFeishuEventIfNeeded(db)

  initTray({
    createMainWindow,
    getMainWindow,
    mainDirname: __dirname
  })

  void createMainWindow()
  setupAppMenu()
})

app.on('before-quit', (event) => {
  if (quitCleanupDone) return
  event.preventDefault()
  isQuitting = true
  destroyTray()
  stopMemoryWatcher()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.destroy()
  }
  void (async () => {
    try {
      await shutdownFeishuServices()
    } catch (err) {
      console.warn('[shutdown] feishu cleanup failed:', err instanceof Error ? err.message : err)
    } finally {
      appDb?.flushSave()
      quitCleanupDone = true
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => {
  if (isTrayEnabled()) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (isTrayEnabled()) {
    void showMainWindow()
    return
  }
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
})
