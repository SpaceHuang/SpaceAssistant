import path from 'path'
import http from 'http'
import https from 'https'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { registerAppIpcHandlers } from './appIpc'
import { registerClaudeStreamHandlers, type ClaudeChatCreateWithToolsPayload } from './claudeStreamHandlers'
import { mergeWikiConfig, mergeToolsConfig } from '../src/shared/domainTypes'
import { readBrowserConfigFromDb } from './browser/browserConfigDb'
import { readShellConfigFromDb } from './shell/shellConfigDb'
import { stagehandService } from './browser/stagehandService'
import {
  autoStartFeishuEventIfNeeded,
  createFeishuBundle,
  registerFeishuIpcHandlers,
  shutdownFeishuServices
} from './feishu/feishuIpc'
import {
  autoStartWeChatPollIfNeeded,
  createWeChatBundle,
  pauseWeChatPollIfWindowClosed,
  registerWeChatIpcHandlers,
  shutdownWeChatServices
} from './wechat/weChatIpc'
import { getConfigValue, getDefaultDbPath, getMessage, listPersistedTurns, openDatabase, setConfigValue } from './database'
import { randomUUID } from 'node:crypto'
import { createTurnCoordinatorStorage } from './turnCoordinatorStorage'
import { TurnRuntime } from './turnRuntime'
import { signalChatCancel } from './chatCancelRegistry'
import type { AppDatabase } from './database'
import { cleanupStreamingResiduesOnStartup } from './database/streamingCleanup'
import { beginSessionEventShutdown, enforceSessionEventRetentionDetailed, flushAllSessionEventSinks, reconcileSessionEventFilesDetailed } from './sessionEvents'
import { cleanupOrphanProcess } from './shell/orphanProcessCleanup'
import { cleanupPersistedOrphansOnStartup } from './shell/startupOrphanCleanup'
import { cleanupLegacyWorkspaceLayoutOnStartup } from './database/legacyWorkspaceLayoutCleanup'
import { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
import { SessionBackupManager } from './sessionBackupManager'
import { setupAppMenu } from './menu'
import { readAppLocale } from './appIpc'
import { getMainWindow, setMainWindow } from './windowRef'
import { getAgentLogDir, initAgentLogger, logAgentEvent, flushAgentLogger } from './agentLogger/agentLogger'
import { initFeishuCliLogger } from './feishu/feishuCliLogger'
import { initWeChatCliLogger } from './wechat/weChatCliLogger'
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
import { applyMainWindowIcon, setupWindowIconThemeListener } from './windowIcon'
import { getMainWindowFrameOptions } from './windowFrame'
import { attachWindowMaximizeEvents, registerWindowControlsIpc } from './windowControlsIpc'
import { isAllowedExternalUrl, openExternalLink } from './externalLink'
import { createWorkDirManager, resolveWorkDirForSession, type WorkDirManager } from './workDirManager'
import { FloatingNotificationManager } from './floatingNotificationManager'
import { runStartupDecisionCacheCleanup } from './confirmation/cacheMaintenanceHooks'
import { runExemptionMigrationOnce } from './confirmation/exemptionMigrationRunner'
import { runMcpConfirmPolicyMigrationOnce } from './confirmation/mcpConfirmPolicyMigration'
import { getSecurityAuditLog } from './confirmation/audit'
import { getRendererURL, isSpaceAssistantDev } from './devEnvironment'
import { runAllShutdownCleanupTasks, type ShutdownCleanupResult } from './shutdownCleanup'

let floatingManager: FloatingNotificationManager | null = null

const API_KEY_CONFIG_KEY = 'secrets.apiKeyEnc'
const TOOLS_CONFIG_KEY = 'config.tools'
const WIKI_CONFIG_KEY = 'config.wiki'

// 开发版使用独立的 Electron userData，避免与已安装版或其他分支共用数据库。
// 必须在 app.whenReady() 前设置，否则 Electron 已经确定了默认 userData 路径。
if (isSpaceAssistantDev()) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

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

function getRendererIndexPath(): string {
  return path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html')
}

let workDirState = ''
let workDirManager: WorkDirManager | null = null
let appDb: AppDatabase | null = null
let isQuitting = false
let quitCleanupDone = false
const SHUTDOWN_TIMEOUT_MS = 12_000

export async function runShutdownCleanup(pendingTasks?: Set<string>): Promise<ShutdownCleanupResult> {
  // 让该函数自身也具备 shutdown 原子边界，避免未来其他退出入口只调用
  // cleanup 而遗漏 before-quit 的生产闸门。
  beginSessionEventShutdown()
  const tasks: Array<[string, () => Promise<unknown>]> = [
    ['session-event-flush', flushAllSessionEventSinks],
    ['stagehand-close', () => stagehandService.closeAll()],
    ['feishu-shutdown', shutdownFeishuServices],
    ['wechat-shutdown', shutdownWeChatServices]
  ]
  const tracked = tasks.map(([task, run]) => [task, async () => {
    pendingTasks?.add(task)
    try {
      return await run()
    } finally {
      pendingTasks?.delete(task)
    }
  }] as const)
  return runAllShutdownCleanupTasks(tracked)
}

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
    ...getMainWindowFrameOptions(),
    // backgroundThrottling 默认为 true；隐藏窗口后 renderer 自动节流（NFR-10）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  setMainWindow(win)
  applyMainWindowIcon(win, __dirname)
  win.setMenuBarVisibility(false)
  attachWindowMaximizeEvents(win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void openExternalLink(url)
    }
    return { action: 'deny' }
  })

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
    void pauseWeChatPollIfWindowClosed()
  })

  // 浮动通知：窗口状态事件
  win.on('focus', () => floatingManager?.onMainWindowFocus())
  win.on('blur', () => floatingManager?.onMainWindowBlur())
  win.on('hide', () => floatingManager?.onMainWindowHide())
  win.on('show', () => floatingManager?.onMainWindowShow())
  win.on('minimize', () => floatingManager?.onMainWindowMinimize())
  win.on('restore', () => floatingManager?.onMainWindowRestore())
}

app.whenReady().then(async () => {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    void showMainWindow()
  })

  const dbPath = getDefaultDbPath(app.getPath('userData'))
  let db: ReturnType<typeof openDatabase>
  try {
    db = openDatabase(dbPath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    dialog.showErrorBox(
      '数据库初始化失败',
      `无法打开本地数据库，应用即将退出。\n\n路径：${dbPath}\n错误：${msg}`
    )
    app.quit()
    return
  }
  appDb = db
  // 进程重启 cleanup 必须先于 Runtime recovery：仅对带 owner token 的本机 run_shell 执行校验，
  // 无身份或不属于本应用的 PID 交给后续 turn recovery 收敛，绝不裸杀。
  await cleanupPersistedOrphansOnStartup({
    listTurns: () => listPersistedTurns(db),
    getMessage: (id) => getMessage(db, id),
    cleanup: cleanupOrphanProcess,
    audit: ({ turnId, toolUseId, result }) => logAgentEvent('info', 'shell.orphan_cleanup', { turnId, toolUseId, result })
  })
  try {
    cleanupLegacyWorkspaceLayoutOnStartup(db)
  } catch (err) {
    console.warn(
      '[legacyWorkspaceLayoutCleanup] failed:',
      err instanceof Error ? err.message : String(err)
    )
  }
  void import('./shell/shellCommandTrust').then(({ persistExpiredTrustedCommandMarks }) => {
    persistExpiredTrustedCommandMarks(db)
  })

  workDirState = getConfigValue(db, 'config.workDir') ?? path.join(app.getPath('userData'), 'workspace')

  const applyWorkDirSideEffects = (d: string) => {
    workDirState = d
    void import('./fileContentWatcher').then(({ stopAllContentWatches }) => stopAllContentWatches())
    loadProjectMemory(d).catch((err) => {
      console.warn('[projectMemory] reload failed:', err.message)
    })
    startMemoryWatcher(d, (state) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('project-memory:state-changed', state)
      }
    })
  }

  workDirManager = createWorkDirManager({
    db,
    getWorkDir: () => workDirState,
    setWorkDir: applyWorkDirSideEffects,
    onBeforeSwitch: () => flushAgentLogger(),
    onAfterSwitch: (fromId, toId) => {
      const profiles = workDirManager!.listProfiles()
      const from = profiles.find((p) => p.id === fromId)
      const to = profiles.find((p) => p.id === toId)
      logAgentEvent('info', 'workdir.switch.done', {
        fromProfileId: fromId,
        fromProfileName: from?.name ?? fromId,
        toProfileId: toId,
        toProfileName: to?.name ?? toId
      })
    }
  })
  workDirManager.migrateFromLegacy()
  workDirState = workDirManager.getActiveWorkDir()

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
    getWorkDir: () => workDirManager?.getActiveWorkDir() ?? workDirState,
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
    getWorkDir: () => workDirManager?.getActiveWorkDir() ?? workDirState,
    isPackaged: app.isPackaged,
    mainDirname: __dirname
  })

  initWeChatCliLogger({
    getWorkDir: () => workDirManager?.getActiveWorkDir() ?? workDirState,
    isPackaged: app.isPackaged,
    mainDirname: __dirname
  })

  // 确认框架启动维护（§5.3/§6，DB 初始化之后、审计 logger 就绪之后）：
  // 先做一次性的存量豁免迁移（版本门控、幂等、失败不阻塞），再做启动缓存清理
  // （清空会话级条目 = "进程消亡即失效"语义等价物 + 过期/休眠清理）。
  runExemptionMigrationOnce(db, { audit: getSecurityAuditLog() })
  runMcpConfirmPolicyMigrationOnce(db, { audit: getSecurityAuditLog() })
  runStartupDecisionCacheCleanup(db)

  const backup = new DebouncedSessionBackupManager(new SessionBackupManager(workDirState))
  const turnRuntime = new TurnRuntime({
    storage: createTurnCoordinatorStorage(db),
    deps: { now: Date.now, id: randomUUID },
    onCancel: (turn) => signalChatCancel(turn.requestId),
    onEvent: (turn, event) => {
      const { executionConfig: _executionConfig, ...publicTurn } = turn
      getMainWindow()?.webContents.send('chat:turn-projection', { turn: publicTurn, event })
    }
  })
  // Runtime 已建立后再处理无 turn 的孤儿消息，随后由 appIpc 的同一 recovery 装配继续恢复持久化 turn。
  cleanupStreamingResiduesOnStartup(db)
  try {
    const recovery = await reconcileSessionEventFilesDetailed(workDirState)
    for (const session of recovery.sessions) {
      for (const issue of session.issues) {
        console.warn('[sessionEvents] startup event integrity issue:', {
          sessionName: session.sessionName,
          eventsPath: issue.eventsPath,
          line: issue.line,
          code: issue.code,
          truncated: issue.truncated,
          dataLossPossible: issue.dataLossPossible,
          message: issue.message
        })
      }
    }
    for (const failure of recovery.failures) {
      console.warn('[sessionEvents] startup recovery degraded:', {
        sessionName: failure.sessionName,
        phase: failure.phase,
        eventsPath: failure.eventsPath,
        jsonlCommitted: failure.jsonlCommitted,
        error: failure.error instanceof Error ? failure.error.message : String(failure.error)
      })
    }
    const retention = await enforceSessionEventRetentionDetailed(workDirState, 100)
    for (const failure of retention.failures) {
      console.warn('[sessionEvents] retention cleanup failed:', {
        sessionName: failure.sessionName,
        error: failure.error instanceof Error ? failure.error.message : String(failure.error)
      })
    }
  } catch (error) {
    // 目录级扫描失败也不能阻断 IPC 注册和窗口创建；下一次启动继续重试。
    console.warn('[sessionEvents] startup maintenance failed:', error instanceof Error ? error.message : String(error))
  }

  const getApiKey = async (): Promise<string | null> => {
    return getActiveLlmService(db).getApiKey()
  }

  const setApiKey = async (value: string): Promise<void> => {
    migrateLegacyLlmServicesIfNeeded(db)
    const activeId = readActiveLlmServiceId(db) ?? readLlmServices(db)[0]?.id
    if (activeId) {
      const services = readLlmServices(db)
      persistLlmServices(db, services, [activeId], { [activeId]: value })
    } else {
      setConfigValue(db, API_KEY_CONFIG_KEY, encryptSecret(value))
    }
  }

  ipcMain.handle('ping', async () => 'pong')

  registerWindowControlsIpc(ipcMain)

  floatingManager = new FloatingNotificationManager(
    () => getMainWindow(),
    __dirname,
    db
  )

  const executeClaudeRequest = registerClaudeStreamHandlers(ipcMain, {
    getApiKey,
    getWorkDir: () => workDirState,
    resolveWorkDirForSession: (sessionId) => {
      const resolved = resolveWorkDirForSession(
        db,
        sessionId,
        () => workDirManager!.listProfiles(),
        () => workDirManager!.getActiveProfileId(),
        () => workDirManager!.getActiveWorkDir()
      )
      return resolved?.workDir ?? workDirState
    },
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
    getBrowserConfig: () => readBrowserConfigFromDb(db),
    getShellConfig: () => readShellConfigFromDb(db),
    getBrowserDetectContext: () => ({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      devRoot: path.join(__dirname, '..', '..')
    }),
    floatingNotificationManager: floatingManager,
    turnRuntime
  })

  const executeTurn = async (sender: Electron.WebContents, payload: ClaudeChatCreateWithToolsPayload) => {
    if (!payload.turnId || !payload.turnStartToken) throw new Error('TURN_EXECUTION_CREDENTIALS_REQUIRED')
    turnRuntime.bindRequest(payload.requestId, payload.turnId)
    return turnRuntime.executeWithSource(payload.turnId, payload.turnStartToken, async (turn) => {
      const result = await executeClaudeRequest(sender, payload) as { ok?: boolean; error?: string; usage?: unknown }
      if (result.ok) {
        turnRuntime.consumeForRequest(payload.requestId, { type: 'source-completed' })
        return { outcome: 'completed' as const, usage: result.usage }
      }
      turnRuntime.consumeForRequest(payload.requestId, { type: 'source-failed' })
      return { outcome: 'failed' as const, error: { code: 'source-failed', message: result.error ?? 'Claude execution failed' } }
    })
  }

  registerAppIpcHandlers(ipcMain, {
    db,
    backup,
    workDirManager: workDirManager!,
    getWorkDir: () => workDirState,
    setWorkDir: applyWorkDirSideEffects,
    getUserDataPath: () => app.getPath('userData'),
    getApiKey,
    setApiKey,
    getBrowserDetectContext: () => ({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      devRoot: path.join(__dirname, '..', '..')
    }),
    floatingNotificationManager: floatingManager,
    turnRuntime,
    executeTurn
  })

  const modelName = () => getConfigValue(db, 'config.model') ?? 'claude-sonnet-4-20250514'
  createFeishuBundle({
    db,
    turnRuntime,
    getUserDataPath: () => app.getPath('userData'),
    getWorkDir: () => workDirState,
    workDirManager: workDirManager!,
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
    workDirManager: workDirManager!,
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
  createWeChatBundle({
    db,
    turnRuntime,
    getUserDataPath: () => app.getPath('userData'),
    getWorkDir: () => workDirState,
    workDirManager: workDirManager!,
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
    },
    appVersion: app.getVersion()
  })
  registerWeChatIpcHandlers(ipcMain, {
    db,
    getUserDataPath: () => app.getPath('userData'),
    getWorkDir: () => workDirState,
    workDirManager: workDirManager!,
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
    },
    appVersion: app.getVersion()
  })
  void autoStartFeishuEventIfNeeded(db)

  initTray({
    createMainWindow,
    getMainWindow,
    mainDirname: __dirname
  })

  void autoStartWeChatPollIfNeeded(db)

  setupWindowIconThemeListener(__dirname)
  void createMainWindow()
  setupAppMenu(readAppLocale(db))
}).catch((err) => {
  console.error('[main] whenReady failed:', err instanceof Error ? err.stack ?? err.message : err)
})

app.on('before-quit', (event) => {
  if (quitCleanupDone) return
  event.preventDefault()
  isQuitting = true
  // 必须在启动异步 cleanup 之前同步切断事件生产，否则 flush 与最后一批
  // chunk/关键事件并发，flush 返回后仍可能接受新事件并被 app.quit 丢弃。
  beginSessionEventShutdown()
  destroyTray()
  floatingManager?.destroy()
  stopMemoryWatcher()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.destroy()
  }
  void (async () => {
    let timedOut = false
    const pendingTasks = new Set<string>()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        console.warn(`[shutdown] cleanup exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing quit`)
        resolve(undefined)
      }, SHUTDOWN_TIMEOUT_MS)
    })
    try {
      const result = await Promise.race([runShutdownCleanup(pendingTasks), timeout])
      if (result && result.failures.length > 0) {
        console.warn('[shutdown] cleanup completed with failures:', result.failures.map(({ task, error }) => ({
          task,
          error: error instanceof Error ? error.message : String(error)
        })))
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      if (timedOut) {
        console.warn('[shutdown] resources not settled before timeout:', Array.from(pendingTasks))
      }
      appDb?.flushSave()
      appDb?.close()
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
