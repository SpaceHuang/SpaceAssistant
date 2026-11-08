import path from 'path'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import http from 'http'
import https from 'https'
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { registerAppIpcHandlers } from './appIpc'
import type { StorageProfileCoordinator } from './storageProfile/storageProfileCoordinator'
import { CONFIG_KEYS, readToolsConfig } from './ipc/ipcShared'
import { resolvePrimedClaudeWorkDir, registerClaudeStreamHandlers, type ClaudeChatCreateWithToolsPayload } from './claudeStreamHandlers'
import { mergeWikiConfig, mergeToolsConfig } from '../src/shared/domainTypes'
import { readBrowserConfigFromDb } from './browser/browserConfigDb'
import { readShellConfigFromDb } from './shell/shellConfigDb'
import { readWikiConfig } from './wiki/wikiConfigReader'
import { registerButlerIpcHandlers } from './butler/butlerIpc'
import { createDeliveryHub } from './driver/deliveryHub'
import { SqliteDeliveryJournal } from './driver/sqliteDeliveryJournal'
import { registerButlerDeliveryDrivers } from './butler/butlerDelivery'
import { sendFeishuTextToTarget } from './feishu/feishuReply'
import { sendWeChatTextToUser } from './wechat/weChatReplyService'
import { ButlerTaskScheduler } from './butler/taskScheduler'
import { runButlerTask, type ButlerInvokerDeps } from './butler/butlerInvoker'
import { syncAutomationTaskRunDeliveryStatuses } from './butler/taskStore'
import { createDeferredStagehandClose } from './startupDeferredModules'
import { createRemoteAuthorizationEpochStore } from './remote/remoteAuthorizationEpochStore'
import { remoteAuthorizationRegistry } from './remote/remoteAuthorizationRegistry'
import { createDeferredTodoStore } from './confirmation/deferredTodoStore'
import { ensureImPolicySnapshotAtStartup } from './confirmation/legacyImConfigBoundary'
import { createDeferredTodoCapacityController } from './confirmation/deferredTodoCapacity'
import { createImTaskControlCoordinator } from './remote/imTaskControlCoordinator'
import { createDeferredTodoTaskControlSafetyPort } from './remote/deferredTodoTaskControlAdapter'
import {
  autoStartFeishuEventIfNeeded,
  createFeishuBundle,
  getFeishuBundle,
  readFeishuConfigFromDb,
  registerFeishuIpcHandlers,
  shutdownFeishuServices
} from './feishu/feishuIpc'
import {
  autoStartWeChatPollIfNeeded,
  createWeChatBundle,
  getWeChatBundle,
  readWeChatConfigFromDb,
  pauseWeChatPollIfWindowClosed,
  registerWeChatIpcHandlers,
  shutdownWeChatServices
} from './wechat/weChatIpc'
import { getConfigValue, getDefaultDbPath, openDatabase, setConfigValue } from './database'
import { createHash, randomUUID } from 'node:crypto'
import { setInvalidationBroadcaster } from './database/scopeVersion'
import { TurnRuntime } from './turnRuntime'
import { runWithPersistedTurnTerminalNotification } from './triggers/sources'
import { createRuntimeTriggerHostService } from './triggers/hostService'
import { createRuntimeTriggerExecutionMaterials } from './triggers/runtimeMaterials'
import { createRuntimeTriggerAuthorizationBinding, runtimeTriggerAuthorizationMatches, type RuntimeTriggerAuthoritySnapshot } from './triggers/hostAuthorization'
import { createSecuritySettingsStorage } from './confirmation/securitySettingsStorage'
import { readPolicyBehaviorSnapshot } from './confirmation/imPolicyStore'
import { readPolicyPackages, resolveEffectivePolicyRulesWithOrigin } from './confirmation/policyRulesRuntime'
import { createSessionMessageService, type SessionMessageDrain } from './capabilities/sessionMessageService'
import { createAgentSessionExecutionAuthorization, evaluateAgentSessionExecutionPolicy } from './capabilities/agentSessionExecutionAuthorization'
import { readImPolicySnapshot } from './confirmation/imPolicyStore'
import { loadEffectivePolicyRules } from './confirmation/policyRulesRuntime'
import { readImPolicyAuthorizationRevision } from './remote/imInboundGuard'
import { classifyQueueInputSource } from './database/queueInputSource'
import { createRuntimeTriggerDelivery } from './triggers/delivery'
import { createRuntimeTriggerRecovery } from './triggers/recovery'
import { evaluateRuntimeTriggerSource, readPersistedTurnTerminal, readSessionSettledStepFacts, readSettledStepFacts, SettledStepFactsTracker, turnTerminalBusForExecution } from './triggers/sources'
import { subscribeRuntimeTriggerProcessExitHandoff } from './triggers/processExitHandoff'
import { createRuntimeTriggerStartAuthorizer } from './triggers/authorization'
import { createRuntimeTriggerLifecycleAssembly, createRuntimeTriggerSyncWaitRegistry, failOrphanedRuntimeSyncTriggers } from './triggers/syncCheckpoint'
import { waitForRuntimeTriggerReceiverTurn } from './triggers/receiverStarter'
import { authorizeRuntimeTriggerImSource } from './triggers/imSourceAuthorization'
import { turnToDisplay } from '../src/shared/turnDisplayProtocol'
import { createTurnDisplayPublisher } from './turnDisplayPublisher'
import { createSessionLedgerRecoveryBindings, createSessionTurnRuntime, createSqliteProjectionBuildTask,
  createSqliteSessionStorage, createSqliteSessionStorageHost,
  createSessionBodySourceBackfillTask, startSessionProjectionRevalidationDrain } from './sessionStorage/sqliteSessionStorage'
import { projectionBuildSliceLogFields } from './sessionStorage/host/projectionBuildSliceLog'
import { createMaintenanceScheduler } from './storage/maintenanceScheduler'
import type { SessionStorage } from './sessionStorage/host/ports'
import { signalChatCancel } from './chatCancelRegistry'
import { cancelAllToolConfirmsForRequest } from './toolConfirmRegistry'
import type { AppDatabase } from './database'
import { beginSessionEventShutdown, withSessionEventWriterDrain, flushAllSessionEventSinks, getSessionEventSink, hasActiveSessionEventSink, readCompactionReplay, retireSessionEventSink, setSessionEventCommitObserver, setSessionEventFailureObserver } from './sessionEvents'
import { runSessionEventRetentionMaintenance } from './storage/sessionEventRetention'
import { pruneAgentLogs } from './storage/agentLogRetention'
import { resolveRetentionPolicyFromDb } from './storage/retentionPolicy'
import { createSpillStore, runSourceTruthSpillGcMaintenance, runSpillRetentionMaintenance, scheduleSourceTruthSpillGcMaintenance } from './storage/spillStore'
import { isSafeDbMaintenanceRequested, runSafeDbMaintenance } from './storage/safeDbMaintenance'
import { reconcileInterruptedCompaction } from './storage/sessionStorageMaintenance'
import { pruneSessionArchives } from './storage/sessionArchiveRetention'
import { schedulePeriodicSqliteMaintenance } from './storage/periodicSqliteMaintenance'
import { archiveLegacyDatabaseJsonBackup } from './storage/legacyDatabaseBackup'
import { cleanupUsageFactsByRetention, reconcileUsageTurnFacts } from './usageStats/usageStatsMaintenance'
import { setUsageStatsAppVersion } from './usageStats/usageStatsRecorder'
import { backfillUsageStats } from './usageStats/usageStatsBackfill'
import { getDbConnection, getDbConnectionEpoch } from './database/sqliteStore'
import { advanceProcessGeneration, currentProcessGeneration } from './database/processGeneration'
import { SessionProjectionMigrationApplication } from './runtime/sessionProjectionMigrationApplication'
import { DB_SCHEMA_VERSION } from './database/schema'
import { createSessionStorageCleanupProductionBoundary } from './runtime/sessionStorageCleanupProduction'
import { SESSION_STORAGE_HISTORY_FORMAT_VERSION, SESSION_STORAGE_SPILL_FORMAT_VERSION } from './runtime/sessionStorageCleanupReleaseConfig'
import { scheduleSessionMessageContentCleanupMaintenance } from './storage/sessionMessageContentCleanupMaintenance'
import { scheduleSpillReferenceBackfill } from './storage/spillReferenceBackfillScheduler'
import { ensureSessionLedgerAdmission, ensureSessionLedgerReady, runOutsideSessionLedgerLifecycleLock } from './sessionLedgerLifecycle'
import { createSessionLedgerRepairScheduler } from './sessionLedgerRepairScheduler'
import { isSessionLedgerRecoveryRootAllowed } from './sessionLedgerRecoveryRoots'
import { createProductionSessionLedgerLifecycleDependencies } from './runtime/sessionLedgerLifecycleProduction'
import { sessionLedgerLocationIdentity } from './sessionLedgerIdentity'
import { withSessionLedgerLifecycleLock } from './sessionLedgerLifecycle'
import { readSessionLedgerReadiness, refreshSessionLedgerReadyProof } from './sessionLedgerReadiness'
import { handleSessionLedgerEventFailure } from './runtime/sessionLedgerRepairFailure'
import { SCHEMA_META_KEYS } from './database/schema'
import { getSchemaMeta, setSchemaMeta } from './database/sqliteStore'
import { scriptParserService, runSelfCheck, setInitFailureListener, setNotReadyParseListener } from './shell/scriptParserService'
import { cleanupLegacyWorkspaceLayoutOnStartup } from './database/legacyWorkspaceLayoutCleanup'
import { SessionBackupLifecycle } from './sessionBackupLifecycle'
import { SessionBackupManager } from './sessionBackupManager'
import { installProcessSafetyNet } from './processSafetyNet'
import { setupAppMenu } from './menu'
import { createHostTranslator } from './i18n/hostTranslate'
import { readAppLocale } from './appIpc'
import { getMainWindow, setMainWindow } from './windowRef'
import { measureStartupPhase } from './startupTiming'
import { createStartupTaskBarrier } from './startupTaskBarrier'
import { getAgentLogDir, initAgentLogger, logAgentEvent, flushAgentLogger } from './agentLogger/agentLogger'
import { projectRendererLongTaskMessage, projectRendererSessionSwitchTraceMessage } from './agentLogger/agentLogProjection'
import { extractWebContentsConsoleMessage } from './consoleMessage'
import { setAgentLogDailyPrune } from './agentLogger/agentLogger'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createDesktopAgentRuntime } from './runtime/desktopAgentRuntime'
import { CallAdmissionGate, getCallAdmissionGate, setCallAdmissionGate } from './runtime/callAdmissionGate'
import { wakeQueuedAgentSessions } from './outbound/desktopAgentSessionWake'
import type { OutboundDrainWakeReason } from './outbound/drainWake'
import { resetActiveAdmissionOnStartup } from './storage/callAdmissionStore'
import { initFeishuCliLogger } from './feishu/feishuCliLogger'
import { initWeChatCliLogger } from './wechat/weChatCliLogger'
import { encryptSecret } from './secureApiKey'
import { loadProjectMemory, startMemoryWatcher, stopMemoryWatcher } from './projectMemory'
import { startEventLoopWatchdog } from './runtime/eventLoopWatchdog'
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
import { createWorkDirManager, resolveWorkDirForSession, workDirAuthorizationBinding, workDirAuthorizationSnapshot, type WorkDirManager } from './workDirManager'
import { FloatingNotificationManager } from './floatingNotificationManager'
import { runStartupDecisionCacheCleanup } from './confirmation/cacheMaintenanceHooks'
import { runExemptionMigrationOnce } from './confirmation/exemptionMigrationRunner'
import { runMcpConfirmPolicyMigrationOnce } from './confirmation/mcpConfirmPolicyMigration'
import { runConfirmModeRetirementMigrationOnce } from './confirmation/confirmModeRetirementMigration'
import { runShellDefaultEnableMigrationOnce } from './shellEnableDefaultMigration'
import { getSecurityAuditLog } from './confirmation/audit'
import { cleanupOrphanedChatAttachments } from './chatAttachmentManager'
import { getRendererURL, getUserDataPath, isSpaceAssistantDev } from './devEnvironment'
import { runAllShutdownCleanupTasks, type ShutdownCleanupResult } from './shutdownCleanup'
import { cleanupMcpArtifactsOnStartup } from './mcp/mcpArtifactCleanup'
import { readMcpArtifactCapacity, setMcpArtifactCapacityRequest } from './mcp/mcpArtifactCapacity'
import { setKnownHomeDir } from '../src/shared/agentSafeText'
import { homedir } from 'node:os'

// 主目录折叠（agentSafeText）依赖已知主目录；必须在任何工具结果投影前注入。
setKnownHomeDir(homedir())

let floatingManager: FloatingNotificationManager | null = null
let butlerScheduler: ButlerTaskScheduler | null = null
const safeDbMaintenanceRequested = isSafeDbMaintenanceRequested(process.argv)

const API_KEY_CONFIG_KEY = 'secrets.apiKeyEnc'
const TOOLS_CONFIG_KEY = 'config.tools'

// 开发版使用独立的 Electron userData，避免与已安装版或其他分支共用数据库。
// 必须在 app.whenReady() 前设置，否则 Electron 已经确定了默认 userData 路径。
if (isSpaceAssistantDev()) {
  app.setPath('userData', getUserDataPath(app.getPath('userData')))
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
let sessionProjectionMigrationApplication: SessionProjectionMigrationApplication | null = null
let mainIpcReady = false
let startupStatusWindow: BrowserWindow | null = null
const processStartupStartedAt = performance.now()
let initialRendererLoadReported = false
const closeStagehandOnShutdown = createDeferredStagehandClose()

async function showStartupStatus(message: string): Promise<void> {
  try {
    if (!startupStatusWindow || startupStatusWindow.isDestroyed()) {
      const win = new BrowserWindow({
        width: 440,
        height: 220,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        movable: true,
        show: false,
        backgroundColor: '#faf9f6',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      startupStatusWindow = win
      win.on('closed', () => {
        if (startupStatusWindow === win) startupStatusWindow = null
      })
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SpaceAssistant</title>
        <style>html,body{height:100%;margin:0}body{font:13px/1.55 'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#2d2a26;background:#faf9f6;display:grid;place-items:center}.card{text-align:center;padding:28px}.mark{width:26px;height:26px;margin:0 auto 14px;border:3px solid #e5e0d8;border-top-color:#f06529;border-radius:50%;animation:spin 1s linear infinite}h1{font-size:13px;font-weight:600;margin:0 0 8px}p{font-size:13px;color:#6b655e;margin:0}small{display:block;color:#6b655e;margin-top:10px}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.mark{animation:none}}</style></head>
        <body><main class="card"><div class="mark" aria-hidden="true"></div><h1>SpaceAssistant</h1><p id="status" role="status" aria-live="polite">正在准备本地数据，请稍候…</p><small>应用正在启动，请保持此窗口开启。</small></main></body></html>`
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      if (win.isDestroyed()) return
      win.show()
    }
    const win = startupStatusWindow
    if (win && !win.isDestroyed()) {
      await win.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(message)}`)
    }
  } catch (error) {
    console.warn('[startup] status window unavailable:', error instanceof Error ? error.message : String(error))
  }
}

function closeStartupStatus(): void {
  const win = startupStatusWindow
  startupStatusWindow = null
  if (win && !win.isDestroyed()) win.close()
}

function getTelemetryAppVersion(): string {
  if (app.isPackaged) return app.getVersion()
  try {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) return packageJson.version
  } catch { /* Keep Electron's fallback version if development metadata is unavailable. */ }
  return app.getVersion()
}

function getTelemetryArtifactBuildId(): string | undefined {
  if (!app.isPackaged) return undefined
  try {
    const identity = JSON.parse(readFileSync(path.join(process.resourcesPath, 'session-storage-build-identity.json'), 'utf8')) as {
      formatVersion?: unknown; version?: unknown; buildId?: unknown; target?: { platform?: unknown; arch?: unknown }
    }
    const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
    if (identity.formatVersion !== 2 || identity.version !== app.getVersion() ||
      typeof identity.buildId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.buildId) ||
      identity.target?.platform !== platform || identity.target?.arch !== process.arch) return undefined
    return identity.buildId
  } catch {
    return undefined
  }
}
/** Explicit process-level host reference used by shutdown tasks; cleared after shutdown settles. */
let appSessionStorage: SessionStorage | null = null

// 进程级 unhandledRejection 安全网（评审 1.1/1.2 防御纵深）：逐点 .catch 是正解，
// 本网兜住漏网点——只丢一条日志，不崩整个主进程。必须在任何业务代码执行前安装。
installProcessSafetyNet((event, detail) => {
  console.error(`[main] ${event}:`, detail.error)
})
/** 用量统计启动维护（回填/补齐/清理）：whenReady 内注册，主窗口创建完成后执行（评审 P1-3）。 */
let usageStatsStartupMaintenance: (() => void) | null = null
let startWindowReadyMaintenance: (() => void) | null = null
let storageLifecycleStop: ((deadlineMs: number) => Promise<{ status: 'quiescent' | 'deadline-exceeded' | 'failed' }>) | null = null
let storageProfileCoordinator: StorageProfileCoordinator | null = null
let projectionRevalidationDrainStop: { stop: () => void } | null = null
let eventLoopWatchdogStop: (() => void) | null = null
let turnDisplayPublisherStop: (() => void) | null = null
let runtimeTriggerReceiverStarter: ((input: import('./triggers/receiverStarter').RuntimeTriggerReceiverStartInput) => Promise<'started' | 'busy' | 'unavailable'>) | null = null
let runtimeTriggerRecoveryStop: (() => Promise<void>) | null = null
let runtimeTriggerSyncWaitStop: (() => void) | null = null
let safeDatabaseMaintenanceInFlight: Promise<void> | undefined
let isQuitting = false
let quitCleanupDone = false
const SHUTDOWN_TIMEOUT_MS = 12_000

export async function runShutdownCleanup(pendingTasks?: Set<string>): Promise<ShutdownCleanupResult> {
  // 让该函数自身也具备 shutdown 原子边界，避免未来其他退出入口只调用
  // cleanup 而遗漏 before-quit 的生产闸门。
  beginSessionEventShutdown()
  const tasks: Array<[string, () => Promise<unknown>]> = [
    ['session-event-flush', flushAllSessionEventSinks],
    ['stagehand-close', closeStagehandOnShutdown],
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
  // macOS may emit `activate` while async startup recovery is still running.
  // Do not expose a renderer until every main-process IPC handler is registered.
  if (!mainIpcReady) return
  const existing = getMainWindow()
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    startWindowReadyMaintenance?.()
    return
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...getMainWindowFrameOptions(),
    show: false,
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

  let rendererLoadOutcome: 'ok' | 'degraded' = 'ok'
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void openExternalLink(url)
    }
    return { action: 'deny' }
  })

  setupWindowCloseHandler(win, getIsQuitting, isTrayEnabled)

  win.webContents.on('console-message', (event, level, rawMessage) => {
    const message = extractWebContentsConsoleMessage(event, level, rawMessage)
    if (!message) return
    if (message.startsWith('[startup]')) console.info(message)
    const rendererLongTask = projectRendererLongTaskMessage(message, win.webContents.mainFrame.processId)
    if (rendererLongTask) logAgentEvent('warn', 'renderer.long-task', rendererLongTask)
    const rendererTrace = projectRendererSessionSwitchTraceMessage(message, win.webContents.mainFrame.processId)
    if (rendererTrace) logAgentEvent('info', 'session.switch.trace', rendererTrace)
  })

  if (!initialRendererLoadReported) {
    win.once('ready-to-show', () => {
      console.info('[startup]', JSON.stringify({
        phase: 'app.start-to-window-ready-to-show',
        durationMs: Math.max(0, Math.round(performance.now() - processStartupStartedAt)),
        outcome: rendererLoadOutcome
      }))
      startWindowReadyMaintenance?.()
    })
    win.webContents.once('did-finish-load', () => {
      console.info('[startup]', JSON.stringify({
        phase: 'app.start-to-renderer-did-finish-load',
        durationMs: Math.max(0, Math.round(performance.now() - processStartupStartedAt)),
        outcome: rendererLoadOutcome
      }))
    })
    win.webContents.once('dom-ready', () => {
      console.info('[startup]', JSON.stringify({
        phase: 'app.start-to-renderer-dom-ready',
        durationMs: Math.max(0, Math.round(performance.now() - processStartupStartedAt)),
        outcome: rendererLoadOutcome
      }))
    })
  }

  if (app.isPackaged) {
    await win.loadFile(getRendererIndexPath())
  } else {
    const url = getRendererURL()
    try {
      await waitForUrlOk(url, 90_000)
      await win.loadURL(url)
    } catch {
      rendererLoadOutcome = 'degraded'
      await dialog.showMessageBox(win, {
        type: 'error',
        title: '开发服务器未就绪',
        message: `无法连接到 Vite（${url}）。请运行 npm run dev。`
      })
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(getDevServerMissingHtml(url))
      await win.loadURL(dataUrl)
    }
  }
  if (!initialRendererLoadReported) {
    initialRendererLoadReported = true
    const sqliteVersion = appDb
      ? (getDbConnection(appDb).prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
      : null
    console.info('[startup]', JSON.stringify({
      phase: 'app.start-to-renderer-loaded', durationMs: Math.max(0, Math.round(performance.now() - processStartupStartedAt)),
      outcome: rendererLoadOutcome, appVersion: getTelemetryAppVersion(), electronVersion: process.versions.electron,
      nodeVersion: process.versions.node, sqliteVersion
    }))
  }
  win.show()
  win.focus()
  closeStartupStatus()

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

  await showStartupStatus('正在准备本地数据，请稍候…')

  app.on('second-instance', () => {
    void showMainWindow()
  })

  await showStartupStatus('正在清理上次启动留下的临时文件…')
  const waitForMcpArtifactCleanup = createStartupTaskBarrier(
    () => cleanupMcpArtifactsOnStartup(app.getPath('userData')),
    (error) => {
    console.warn('[mcp] startup artifact cleanup failed:', error instanceof Error ? error.message : String(error))
    }
  )

  const dbPath = getDefaultDbPath(app.getPath('userData'))
  let db: ReturnType<typeof openDatabase>
  try {
    await showStartupStatus('正在检查或升级本地数据库，请稍候…')
    // 压缩换入崩溃对账必须在 openDatabase 之前：DatabaseSync 打开缺失路径会静默建空库。
    measureStartupPhase('database.compact-recovery', () => reconcileInterruptedCompaction(dbPath))
    db = await measureStartupPhase('database.open-and-migrations', () => openDatabase(dbPath))
    await measureStartupPhase('database.process-generation-fence', () => advanceProcessGeneration(getDbConnection(db)))
    remoteAuthorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))
  } catch (e) {
    await waitForMcpArtifactCleanup()
    const msg = e instanceof Error ? e.message : String(e)
    closeStartupStatus()
    dialog.showErrorBox(
      '数据库初始化失败',
      `无法打开本地数据库，应用即将退出。\n\n路径：${dbPath}\n错误：${msg}`
    )
    app.quit()
    return
  }
  await waitForMcpArtifactCleanup()
  appDb = db
  try {
    ensureImPolicySnapshotAtStartup(db)
  } catch (error) {
    // Keep startup available, but leave IM dispatch fail-closed when legacy policy cannot be read.
    console.error('[im-policy] startup snapshot migration failed; IM tool calls will remain blocked:', error instanceof Error ? error.message : String(error))
  }
  let turnRuntime!: TurnRuntime
  const logSessionLedgerGateTrace = (trace: import('./sessionLedgerLifecycle').SessionLedgerLifecycleTrace) => {
    logAgentEvent('info', 'session.history.recovery', {
      kind: 'session-ledger-gate', phase: trace.operation, status: trace.status, durationMs: trace.durationMs,
      baselineScanCount: trace.baselineScanCount, projectedCount: trace.projectedCount,
      ...(trace.failureClass ? { reasonCode: trace.failureClass } : {})
    })
  }
  const recoveryWorkDir = getConfigValue(db, 'config.workDir') ?? path.join(app.getPath('userData'), 'workspace')
  const ledgerRecovery = createSessionLedgerRecoveryBindings()
  const userDataDir = app.getPath('userData')
  const getConfiguredRecoveryWorkDirs = () => ledgerRecovery.getAllowedRoots({
    configuredWorkDir: getConfigValue(db, 'config.workDir') ?? recoveryWorkDir,
    profilesJson: getConfigValue(db, 'config.workDirProfiles')
  })
  const recoveryWorkDirs = getConfiguredRecoveryWorkDirs()
  const isAuthorizedLedgerRoot = (workDir: string, sessionId: string): boolean => {
    return isSessionLedgerRecoveryRootAllowed({ userDataDir, workDir, sessionId,
      configuredRoots: getConfiguredRecoveryWorkDirs(),
      hasButlerTaskSessionLink: (taskId, ownerSessionId) => Boolean(getDbConnection(db).prepare(`SELECT 1 FROM automation_task_runs
        WHERE task_id=? AND session_id=? LIMIT 1`).get(taskId, ownerSessionId)) })
  }
  const sessionLedgerLifecycleDependencies = createProductionSessionLedgerLifecycleDependencies(getDbConnection(db))
  const processGeneration = currentProcessGeneration(getDbConnection(db))
  let getSessionForLedgerRepair: ((sessionId: string) => { id: string; createdAt: number; generation: string } | undefined) | undefined
  let sessionLedgerRepairRequestGeneration = 0
  const sessionLedgerRepairScheduler = createSessionLedgerRepairScheduler({
    repair: async (location, retireSink) => runOutsideSessionLedgerLifecycleLock(async () => {
      if (!isAuthorizedLedgerRoot(location.workDir, location.sessionId)) return { status: 'skipped', reason: 'location-not-authorized' }
      const session = getSessionForLedgerRepair?.(location.sessionId)
      if (!session || session.createdAt !== location.createdAt) return { status: 'skipped', reason: 'session-identity-mismatch' }
      try {
        if (retireSink) await retireSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        const result = await ensureSessionLedgerReady({ conn: getDbConnection(db), location,
          sessionGeneration: session.generation, processGeneration, retryBlocked: true,
          dependencies: sessionLedgerLifecycleDependencies, onTrace: logSessionLedgerGateTrace })
        if (result.status !== 'ready') return false
        // Reacquire immediately after successful repair; old references stay fenced by retire().
        const repairedSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        await readCompactionReplay(repairedSink.eventsPath)
        return true
      } catch {
        return false
      }
    }),
    onAttempt: ({ status, attempt, retryInMs, location, reason }) => logAgentEvent(status === 'recovered' ? 'info' : 'warn', 'session.history.recovery', {
      kind: 'session-ledger-auto-repair', status, attempt, retryInMs,
      ...(location ? { sessionId: location.sessionId, workDir: location.workDir } : {}), ...(reason ? { reason } : {})
    })
  })
  setSessionEventFailureObserver((location) => handleSessionLedgerEventFailure({ conn: getDbConnection(db),
    scheduler: sessionLedgerRepairScheduler, location, generation: ++sessionLedgerRepairRequestGeneration }))
  setSessionEventCommitObserver(async (location) => {
    const identity = sessionLedgerLocationIdentity(location)
    const proof = await sessionLedgerLifecycleDependencies.readProof(location)
    if (proof) refreshSessionLedgerReadyProof(getDbConnection(db), identity.key, proof)
  })
  let requestMcpArtifactCapacitySweep: (() => void) | undefined
  let requestAgentLogRetention: (() => void) | undefined
  const dailyRetentionTask = (taskId: string, policyFingerprint: () => string | Promise<string>, rootFingerprint: () => string | undefined,
    run: (signal: AbortSignal) => Promise<number>, onStarted?: (handle: { request?(reason: import('./sessionStorage/host/ports').MaintenanceReason): void }) => void) => {
    const scheduler = createMaintenanceScheduler({
      watermarkPath: path.join(app.getPath('userData'), 'maintenance', `${taskId}.json`),
      policyFingerprint, rootFingerprint, algorithmVersion: 1,
      run: async ({ signal }) => {
        const processedCount = await run(signal)
        return { success: true, scannedCount: processedCount, processedCount }
      },
      onResult: (result) => { if (!result.success) console.warn(`[maintenance] ${taskId} failed`, result.errorCode) }
    })
    return { taskId, category: 'retention' as const, start: () => {
      const handle = scheduler.start()
      onStarted?.(handle)
      return handle
    } }
  }
  const sessionStorageHost = createSqliteSessionStorageHost(db, {
    ledgerRecovery,
    storage: {
    getTurnRuntime: () => turnRuntime,
    getUserDataDir: () => app.getPath('userData'),
    projectionBlobRoot: path.join(app.getPath('userData'), 'session-projections'),
    ensureSessionLedgerReady: async ({ session, workDir, retryBlocked = true }) => {
      const result = await ensureSessionLedgerAdmission({
        conn: getDbConnection(db),
        location: { workDir, sessionId: session.id, createdAt: session.createdAt },
        sessionGeneration: session.generation,
        processGeneration,
        retryBlocked,
        dependencies: sessionLedgerLifecycleDependencies,
        onTrace: logSessionLedgerGateTrace
      })
      if (result.status === 'blocked') {
        logAgentEvent('warn', 'session.history.repair.failed', {
          kind: 'session-ledger-gate', reasonCode: result.readiness.failureClass ?? 'unknown'
        })
        sessionLedgerRepairScheduler.request({ workDir, sessionId: session.id, createdAt: session.createdAt }, {
          retireSink: result.readiness.failureClass === 'ledger_missing' || result.readiness.failureClass === 'physical_proof_mismatch',
          generation: `${result.readiness.ledgerGeneration}:${result.readiness.canonicalWatermark ?? ''}:${result.readiness.failureClass ?? ''}`
        })
      }
      return { ready: result.status === 'ready', canonicalReadVersion: result.readiness.canonicalReadVersion }
    },
    getWorkDirForSession: (sessionId) => {
      if (!workDirManager) return recoveryWorkDir
      return resolveWorkDirForSession(
        sessionStorage.queries, sessionId,
        () => workDirManager!.listProfiles(),
        () => workDirManager!.getActiveProfileId(),
        () => workDirManager!.getActiveWorkDir()
      )?.workDir
    }
    },
    startup: {
      recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
      recoverSessionLedgers: async () => ({ repairFailureCount: 0 })
    },
    maintenanceTasks: [
      createSqliteProjectionBuildTask({ db, dbPath, blobRoot: path.join(app.getPath('userData'), 'session-projections'),
        processGeneration: () => processGeneration, connectionEpoch: () => getDbConnectionEpoch(db), now: Date.now,
        onFailure: (code) => console.warn(`[storage] ${code}`),
        onSlice: (slice) => logAgentEvent('info', 'session.projection.build.slice', projectionBuildSliceLogFields(slice)),
        onResult: (_item, result) => {
          if (result.kind !== 'checkpointed' && result.kind !== 'published') {
            console.warn(`[storage] projection build ${result.kind}`)
          }
        } }),
      createSessionBodySourceBackfillTask({ db, blobRoot: path.join(app.getPath('userData'), 'session-projections'),
        onResult: (result) => {
          if (result.status === 'failed') console.warn(`[storage] session body source backfill failed (${result.sessionId}):`, result.error)
          else console.info('[storage] session body source backfill complete:', result)
        } }),
      {
        taskId: 'spill-reference-index-backfill', category: 'derived-index',
        start: () => scheduleSpillReferenceBackfill(db, {
          onResult: (result) => {
            if (result.status === 'failed') console.warn(`[storage] spill reference index ${result.task} paused:`, result.error)
            else if (result.processed > 0) console.info(`[storage] spill reference index ${result.task} progress:`, result)
          }
        })
      },
      dailyRetentionTask('mcp-artifact-cleanup', async () => {
        const capacity = await readMcpArtifactCapacity(path.join(app.getPath('userData'), 'shell-output', 'mcp'))
        return `ttl=7d;quota=256MiB;v1;generation=${capacity.generation};dirty=${capacity.dirty}`
      }, () => path.join(app.getPath('userData'), 'shell-output', 'mcp'), async () => {
        const result = await cleanupMcpArtifactsOnStartup(app.getPath('userData'))
        return result.scanned
      }, (handle) => { requestMcpArtifactCapacitySweep = () => handle.request?.('capacity-pressure') }),
      ...recoveryWorkDirs.map((workDir) => dailyRetentionTask(`session-event-retention-${createHash('sha256').update(workDir).digest('hex').slice(0, 12)}`,
        () => JSON.stringify(resolveRetentionPolicyFromDb(db).sessionEventMaxSessions), () => workDir, async () => {
        const shouldRetain = sessionStorageHost.storage.shouldRetainSessionEventDirectory
        const prepareProjectionForRetention = sessionStorageHost.storage.prepareSessionEventRetentionProjection
        const result = await runSessionEventRetentionMaintenance(db, workDir, {
          prepareProjectionForRetention, shouldRetainSessionDir: shouldRetain,
          withSessionLifecycleLock: async (sessionName, root, operation) => {
            const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1] ?? sessionName
            const session = sessionStorage.queries.readSession(sessionId)
            const key = sessionLedgerLocationIdentity({ workDir: root, sessionId, createdAt: session?.createdAt ?? 0 }).key
            return session
              ? withSessionEventWriterDrain(root, sessionId, () => withSessionLedgerLifecycleLock(key, operation))
              : withSessionLedgerLifecycleLock(key, operation)
          },
          ensureReadyBeforeDelete: async (sessionName, root) => {
            const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1]
            const session = sessionId ? sessionStorage.queries.readSession(sessionId) : undefined
            if (!sessionId || !session) return false
            const result = await ensureSessionLedgerReady({ conn: getDbConnection(db),
              location: { workDir: root, sessionId, createdAt: session.createdAt }, sessionGeneration: session.generation,
              processGeneration, retryBlocked: true, dependencies: sessionLedgerLifecycleDependencies, onTrace: logSessionLedgerGateTrace })
            return result.status === 'ready'
          },
          verifyReadyBeforeDelete: async (sessionName, root) => {
            const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1]
            const session = sessionId ? sessionStorage.queries.readSession(sessionId) : undefined
            if (!sessionId || !session) return false
            const location = { workDir: root, sessionId, createdAt: session.createdAt }
            const key = sessionLedgerLocationIdentity(location).key
            const readiness = readSessionLedgerReadiness(getDbConnection(db), key)
            const pending = getDbConnection(db).prepare("SELECT 1 FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status='pending' LIMIT 1").get(key)
            return readiness?.state === 'ready' && !pending && !hasActiveSessionEventSink(root, sessionId, session.createdAt)
          }
        })
        for (const failure of result.summary.failures) console.warn('[sessionEvents] retention cleanup failed:', failure.sessionName, failure.error)
        if (result.summary.failures.length) {
          // 透传首个失败的平台错误码（EPERM/EBUSY…），watermark 报告的 lastError 才有诊断价值
          const firstCode = result.summary.failures.find((failure) => failure.error && typeof failure.error === 'object' && 'code' in failure.error)?.error as { code?: string } | undefined
          throw Object.assign(new Error('session-event-retention-incomplete'), { code: firstCode?.code ?? 'RETENTION_INCOMPLETE' })
        }
        return result.summary.removed + result.summary.retained.length
      })),
      dailyRetentionTask('spill-degradable-retention', () => String(resolveRetentionPolicyFromDb(db).degradableSpillRetentionDays), () => path.join(app.getPath('userData'), 'spill'), async () => {
        const removed = await runSpillRetentionMaintenance(db, path.join(app.getPath('userData'), 'spill'), Date.now())
        return removed.length
      }),
      dailyRetentionTask('agent-log-retention', () => String(resolveRetentionPolicyFromDb(db).agentLogRetentionDays), () => getAgentLogDir() ?? '', async () => {
        const result = await pruneAgentLogs({ logDir: getAgentLogDir() ?? '', retentionDays: resolveRetentionPolicyFromDb(db).agentLogRetentionDays })
        if (result.failed) throw new Error(`agent-log-retention-delete-failed:${result.failed}`)
        return result.removed
      }, (handle) => { requestAgentLogRetention = () => handle.request?.('startup') }),
      dailyRetentionTask('usage-facts-retention', () => String(getConfigValue(db, 'config.usageStatsRetentionDays') ?? 'default'), () => undefined, async () => {
        const result = cleanupUsageFactsByRetention(db)
        return result ? result.deletedStepRows + result.deletedTurnRows : 0
      }),
      {
        taskId: 'sqlite-upkeep', category: 'derived-index',
        start: () => safeDbMaintenanceRequested ? undefined : (() => {
          const task = schedulePeriodicSqliteMaintenance(db, {
            onResult: (result) => {
              if (result !== 'checkpointed') console.info('[storage] periodic database maintenance skipped:', result)
            }
          })
          return Object.freeze({ stop: task, quiesce: task.quiesce })
        })()
      },
      {
        taskId: 'source-truth-spill-gc', category: 'pending-reclamation',
        start: () => {
          const task = scheduleSourceTruthSpillGcMaintenance(db, path.join(app.getPath('userData'), 'spill'), {
          onResult: (summary) => {
            if (summary === 'failed' || summary.failed > 0) console.warn('[storage] source-truth spill collection remains pending', summary)
          }
          })
          return Object.freeze({ stop: task, quiesce: task.quiesce })
        }
      },
      {
        taskId: 'session-content-cleanup', category: 'retention',
        start: () => {
          if (safeDbMaintenanceRequested || !app.isPackaged) return undefined
          const cleanupBoundary = createSessionStorageCleanupProductionBoundary({
            resourcesPath: process.resourcesPath,
            appVersion: app.getVersion(),
            schemaVersion: DB_SCHEMA_VERSION,
            historyFormatVersion: SESSION_STORAGE_HISTORY_FORMAT_VERSION,
            spillFormatVersion: SESSION_STORAGE_SPILL_FORMAT_VERSION,
            platform: process.platform,
            arch: process.arch,
          }, (targetDb) => targetDb === db ? sessionStorage.cleanup : createSqliteSessionStorage(targetDb).cleanup)
          const cleanupGate = cleanupBoundary.checkGate()
          if (!cleanupGate.allowed) {
            if (cleanupGate.reason !== 'deployment-disabled') console.warn('[storage] session content cleanup remains disabled:', cleanupGate.reason)
            return undefined
          }
          const cleanupScope = cleanupBoundary.checkAuthorizationScope(db)
          if (!cleanupScope.allowed) {
            console.info('[storage] session content cleanup worker not registered:', cleanupScope.reason)
            return undefined
          }
          const task = scheduleSessionMessageContentCleanupMaintenance(db, cleanupBoundary, {
            initialDelayMs: 60_000,
            intervalMs: 15 * 60_000,
            batchSize: 100,
            maxSessionsPerRun: 2,
            maxBatchesPerSession: 1,
            onResult: (summary) => {
              if (summary === 'failed') console.warn('[storage] session content cleanup maintenance failed; pending sessions remain resumable')
              else if (summary.status === 'blocked') console.warn('[storage] session content cleanup gate closed:', summary.gateReason)
              else if (summary.completed || summary.batches || summary.writeStopped || summary.ineligible) {
                console.info('[storage] session content cleanup maintenance progress:', summary)
              }
            },
          })
          return Object.freeze({ stop: task, quiesce: task.quiesce })
        }
      }
    ],
    quiesceMaintenance: async () => { await safeDatabaseMaintenanceInFlight }
  })
  const sessionStorage = sessionStorageHost.storage
  let requestDesktopDrain: SessionMessageDrain = () => { throw new Error('SESSION_MESSAGE_DRAIN_UNAVAILABLE') }
  const resolveSessionWorkDir = (sessionId: string) => {
    if (!workDirManager) return undefined
    return resolveWorkDirForSession(sessionStorage.queries, sessionId,
      () => workDirManager!.listProfiles(),
      () => workDirManager!.getActiveProfileId(),
      () => workDirManager!.getActiveWorkDir())
  }
  const resolveSessionWorkDirProfileId = (sessionId: string): string | undefined => {
    return workDirAuthorizationBinding(resolveSessionWorkDir(sessionId))
  }
  const sessionMessages = createSessionMessageService({ storage: sessionStorage,
    requestDesktopDrain: (sessionId) => requestDesktopDrain(sessionId),
    onRecoveryIssue: ({ sessionId, requestId, stage }) => logAgentEvent('warn', 'session.message.recovery.pending', { sessionId, requestId, stage }),
    resolveWorkDirProfileId: resolveSessionWorkDirProfileId })
  const agentSessionExecutionAuthorization = createAgentSessionExecutionAuthorization({ storage: sessionStorage,
    resolveWorkDirProfileId: resolveSessionWorkDirProfileId,
    resolveWorkDirSnapshot: (sessionId) => workDirAuthorizationSnapshot(resolveSessionWorkDir(sessionId)),
    evaluateCurrentPolicy: ({ sessionId }) => evaluateAgentSessionExecutionPolicy({ sessionId,
      rules: resolveEffectivePolicyRulesWithOrigin(db, 'desktop').rules, config: readToolsConfig(db) }),
    requestUserConfirmation: async ({ sessionId, requestId, messageId, ruleId, decisionTraceRef }) => {
      const target = sessionStorage.queries.readSession(sessionId)
      const messageContent = sessionStorage.queries.readAgentSessionMessageContent({ sessionId, messageId })
      if (!target || target.ownership !== 'user' || target.visibility === 'hidden' || messageContent === undefined) return 'waiting'
      const translate = createHostTranslator({ locale: readAppLocale(db) })
      const audit = getSecurityAuditLog()
      const auditBase = { lane: 'desktop' as const, sessionId, requestId, toolUseId: messageId, toolName: 'toolkit.call',
        actionClass: 'execute' as const, riskLevel: 'medium' as const, factsSummary: '跨会话来信执行权限重审',
        signals: ['toolkit-capability'], decisionId: decisionTraceRef, decisionRuleId: ruleId }
      audit.record({ ...auditBase, ts: Date.now(), event: 'policy.decision', decision: 'require-confirm',
        answerer: 'user', ruleId, reason: '跨会话来信执行授权在启动恢复时需要人工重审。', actor: 'system' })
      audit.record({ ...auditBase, ts: Date.now(), event: 'confirm.request', actor: 'user' })
      let result: 'approved' | 'rejected' | 'waiting' = 'waiting'
      try {
        const parent = getMainWindow()
        const options = {
          type: 'warning' as const,
          title: translate({ key: 'notification.sessionMessageConfirmTitle' }),
          message: translate({ key: 'notification.sessionMessageConfirmMessage', params: { session: target.name } }),
          detail: translate({ key: 'notification.sessionMessageConfirmDetail', params: { ruleId, content: messageContent } }),
          buttons: [translate({ key: 'notification.sessionMessageConfirmApprove' }), translate({ key: 'notification.sessionMessageConfirmReject' }),
            translate({ key: 'notification.sessionMessageConfirmDefer' })],
          defaultId: 2, cancelId: 2, noLink: true
        }
        const response = await (parent
          ? dialog.showMessageBox(parent, options)
          : dialog.showMessageBox(options))
        result = response.response === 0 ? 'approved' : response.response === 1 ? 'rejected' : 'waiting'
      } catch { result = 'waiting' }
      audit.record({ ...auditBase, ts: Date.now(), event: 'confirm.outcome', actor: result === 'waiting' ? 'system' : 'user',
        outcome: result === 'approved' ? 'approved' : result === 'rejected' ? 'rejected' : 'cancelled',
        cause: result === 'approved' ? 'user-approved' : result === 'rejected' ? 'user-denied' : 'cancelled' })
      return result
    },
    readCurrentAuthority: () => {
      try {
        const conn = getDbConnection(db)
        const snapshot = readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] })
        const epoch = conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='desktop'").get() as { epoch?: number } | undefined
        if (!epoch || !Number.isSafeInteger(epoch.epoch)) return undefined
        const policyBinding = { domain: 'desktop' as const, policyBehaviorVersion: snapshot.policyBehaviorVersion,
          revision: snapshot.revision, epoch: epoch.epoch! }
        const origin = resolveEffectivePolicyRulesWithOrigin(db, 'desktop')
        const authorizationGeneration = createHash('sha256').update(JSON.stringify({
          effectiveRules: origin.rules, lanePackage: readPolicyPackages(db).desktop, policyOrigins: origin.origins, policyBinding
        })).digest('hex')
        return { policyRevision: String(snapshot.revision), authorizationGeneration,
          runtimeGeneration: `process:${process.pid}:${currentProcessGeneration(conn)}` }
      } catch { return undefined }
    } })
  const runtimeTriggerSyncWaiters = createRuntimeTriggerSyncWaitRegistry()
  runtimeTriggerSyncWaitStop = runtimeTriggerSyncWaiters.cancelAll
  const runtimeTriggerService = createRuntimeTriggerHostService({ commands: sessionStorage.commands,
    queries: sessionStorage.queries, execution: sessionStorage.execution,
    authorizeImSource: (source) => {
      const { channel } = source
      const policyRevision = readImPolicyAuthorizationRevision(db)
      const authorizationGeneration = `${channel}:${remoteAuthorizationRegistry.getGeneration(channel)}:${remoteAuthorizationRegistry.getAuthorizationEpoch(channel)}`
      if (channel === 'feishu') {
        const config = readFeishuConfigFromDb(db)
        return authorizeRuntimeTriggerImSource({ source, config: { enabled: config.enabled, ready: config.appConfigured && config.userAuthorized,
          remoteEnabled: config.remoteEnabled, loggedIn: true, remoteSenderAllowlist: config.remoteSenderAllowlist },
        policyRules: loadEffectivePolicyRules(db, 'feishu'), policyRevision, authorizationGeneration })
      }
      const config = readWeChatConfigFromDb(db)
      return authorizeRuntimeTriggerImSource({ source, config: { enabled: config.enabled, ready: true, remoteEnabled: config.remoteEnabled,
        loggedIn: config.loggedIn, remoteSenderAllowlist: config.remoteSenderAllowlist }, policyRules: loadEffectivePolicyRules(db, 'wechat'),
      policyRevision, authorizationGeneration })
    },
    accepting: () => !isQuitting,
    cancelSyncWait: (trigger) => runtimeTriggerSyncWaiters.cancel(trigger.id) })
  const runtimeTriggerSecuritySettings = createSecuritySettingsStorage(db)
  const runtimeTriggerQueueScope = (receiverSessionId: string) => runtimeTriggerService.resolveQueueScope(receiverSessionId)
  const runtimeTriggerAuthoritySnapshot = (trigger: import('./sessionStorage/public/model').RuntimeTriggerRecord): RuntimeTriggerAuthoritySnapshot | undefined => {
    try {
      const condition = trigger.definition.condition
      const imChannel = condition.type === 'im_message' ? condition.channel : undefined
      const policyRevision = imChannel
        ? (() => { const snapshot = readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2', 'im-standard-v3'] }); return `${snapshot.policyBehaviorVersion}:${snapshot.revision}` })()
      : `desktop-v1:${runtimeTriggerSecuritySettings.readDesktopPolicySnapshot().revision}`
      const authorizationGeneration = imChannel
        ? `${imChannel}:${remoteAuthorizationRegistry.getGeneration(imChannel)}:${remoteAuthorizationRegistry.getAuthorizationEpoch(imChannel)}`
        : `desktop:${currentProcessGeneration(getDbConnection(db))}`
      return { policyRevision, authorizationGeneration, runtimeGeneration: `process:${process.pid}:${currentProcessGeneration(getDbConnection(db))}` }
    } catch { return undefined }
  }
  const resolveRuntimeTriggerBinding = (trigger: import('./sessionStorage/public/model').RuntimeTriggerRecord) => {
    const queueScope = runtimeTriggerQueueScope(trigger.receiverSessionId)
    const authority = runtimeTriggerAuthoritySnapshot(trigger)
    if (!queueScope || !authority) return null
    const sourceAuthorization = runtimeTriggerService.authorizeSource(trigger.ownerSessionId, trigger.receiverSessionId,
      trigger.definition.condition, trigger.definition.sourceBaseline, trigger.event)
    if (!sourceAuthorization.allowed) return null
    return createRuntimeTriggerAuthorizationBinding({ trigger, queueScope, authority, isAuthorized: () => true,
      ...(sourceAuthorization.policyTrace ? { sourceDecisionTrace: { kind: 'im-ingress', decisions: sourceAuthorization.policyTrace } } : {}) })
  }
  const runtimeTriggerExecutionMaterials = createRuntimeTriggerExecutionMaterials({
    read: (triggerId) => sessionStorage.commands.runtimeTriggers.read(triggerId),
    verifyPersistedAdmission: (trigger, admission) => {
      try {
        if (typeof admission.invocationId !== 'string' || typeof admission.contextEventId !== 'string' ||
          typeof admission.contextDigest !== 'string' || typeof admission.requestDigest !== 'string') return false
        const binding = trigger.result?.authorization as import('./triggers/delivery').RuntimeTriggerAuthorizationBinding | undefined
        if (!binding || binding.bindingVersion !== 1 || binding.requestId !== `runtime-trigger:${trigger.id}` ||
          binding.ownerSessionId !== trigger.ownerSessionId || binding.receiverSessionId !== trigger.receiverSessionId ||
          JSON.stringify(binding.sourceIdentity) !== JSON.stringify(trigger.definition.condition) || !trigger.event ||
          createHash('sha256').update(JSON.stringify(trigger.event)).digest('hex') !== binding.payloadDigest) return false
        const row = getDbConnection(db).prepare(`SELECT payload_json FROM agent_history_events
          WHERE invocation_id=? AND event_id=? AND kind='invocation-context-committed'`).get(admission.invocationId, admission.contextEventId) as { payload_json: string } | undefined
        if (!row) return false
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        const requestSnapshot = payload.requestSnapshot
        const requestDigestPayload = requestSnapshot ?? { requestId: admission.requestId }
        return createHash('sha256').update(JSON.stringify(payload)).digest('hex') === admission.contextDigest &&
          createHash('sha256').update(JSON.stringify(requestDigestPayload)).digest('hex') === admission.requestDigest &&
          (requestSnapshot === undefined || (requestSnapshot !== null && typeof requestSnapshot === 'object' &&
            (requestSnapshot as Record<string, unknown>).requestId === admission.requestId))
      } catch { return false }
    },
    isCurrentAuthorization: (trigger, approved) => {
      const queueScope = runtimeTriggerQueueScope(trigger.receiverSessionId)
      const authority = runtimeTriggerAuthoritySnapshot(trigger)
      if (!queueScope || !authority) return false
      const sourceAuthorization = runtimeTriggerService.authorizeSource(trigger.ownerSessionId, trigger.receiverSessionId,
        trigger.definition.condition, trigger.definition.sourceBaseline, trigger.event)
      if (!sourceAuthorization.allowed) return false
      return runtimeTriggerAuthorizationMatches(trigger, queueScope, authority, approved,
        sourceAuthorization.policyTrace ? { kind: 'im-ingress', decisions: sourceAuthorization.policyTrace } : undefined)
    }
  })
  const runtimeTriggerReadReceipt = (trigger: import('./sessionStorage/public/model').RuntimeTriggerRecord) => {
    const scope = runtimeTriggerQueueScope(trigger.receiverSessionId)
    return scope ? sessionStorage.commands.scopedQueue.readReceipt({ sessionId: trigger.receiverSessionId,
      requestId: `runtime-trigger:${trigger.id}`, queueScope: scope }) : undefined
  }
  const runtimeTriggerDelivery = createRuntimeTriggerDelivery({
    read: (id) => sessionStorage.commands.runtimeTriggers.read(id),
    update: (id, revision, patch) => sessionStorage.commands.runtimeTriggers.update(id, revision, patch),
    expire: (id, revision) => sessionStorage.commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: Date.now() }),
    authorize: (trigger, scope) => {
      const resolved = resolveRuntimeTriggerBinding(trigger)
      return resolved && JSON.stringify(resolved.queueScope) === JSON.stringify(scope) ? resolved : null
    },
    queueScope: (receiver) => runtimeTriggerQueueScope(receiver) ?? { kind: 'desktop' },
    enqueue: (request) => sessionStorage.commands.scopedQueue.enqueue(request),
    readReceipt: (receipt) => sessionStorage.commands.scopedQueue.readReceipt(receipt)
  })
  const runtimeTriggerSyncLifecycle = (sessionId: string, history: import('./sessionStorage/public/ports').SessionHistoryPort) => {
    const stepFactsTrackers = new Map<string, SettledStepFactsTracker>()
    return createRuntimeTriggerLifecycleAssembly({
      sessionId,
      listWaitingSync: (targetSessionId) => sessionStorage.commands.runtimeTriggers.listByState('waiting', 4_096).filter((trigger) =>
        trigger.definition.condition.type === 'session_steps' && trigger.definition.condition.mode === 'sync' &&
        trigger.definition.condition.targetSessionId === targetSessionId),
      listMatchedForExecution: (invocationId, turnId) => sessionStorage.commands.runtimeTriggers.listByState('matched', 4_096).filter((trigger) =>
        trigger.event?.invocationId === invocationId && trigger.event?.targetTurnId === turnId),
      readStepFacts: async (invocationId) => {
        let tracker = stepFactsTrackers.get(invocationId)
        if (!tracker) {
          tracker = new SettledStepFactsTracker()
          stepFactsTrackers.set(invocationId, tracker)
          const initial = await history.read(invocationId)
          const facts = tracker.update(initial)
          return { historyVersion: tracker.currentVersion, facts }
        }
        let facts = { ok: true, settledCount: 0, settledStepIds: [], pendingStepIds: [] } as import('./triggers/sources').SettledStepFacts
        while (true) {
          const page = await history.readEventsAfter(invocationId, tracker.currentVersion)
          facts = tracker.appendEvents({ invocationId, fromVersion: tracker.currentVersion, version: Math.min(page.version, tracker.currentVersion + page.events.length), events: page.events })
          if (!facts.ok || tracker.currentVersion >= page.version) break
          if (page.events.length === 0) { facts = { ok: false, settledCount: 0, settledStepIds: [], pendingStepIds: [], code: 'SOURCE_GAP', case: 'history-incremental-page-gap' }; break }
        }
        return { historyVersion: tracker.currentVersion, facts }
      },
      saveProgress: (id, revision, progress) => {
        const current = sessionStorage.commands.runtimeTriggers.read(id)
        if (!current || current.revision !== revision || current.state !== 'waiting') return null
        return sessionStorage.commands.runtimeTriggers.update(id, revision, {
          result: { ...(current.result ?? {}), syncStepProgress: progress }, updatedAt: Date.now()
        })
      },
      match: (id, revision, event) => sessionStorage.commands.runtimeTriggers.update(id, revision,
        { state: 'matched', matchedAt: Date.now(), event, updatedAt: Date.now() }),
      expire: (id, revision) => sessionStorage.commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: Date.now() }),
      read: (id) => sessionStorage.commands.runtimeTriggers.read(id),
      acceptPause: ({ trigger }) => sessionStorage.commands.runtimeTriggers.update(trigger.id, trigger.revision,
        { result: { ...(trigger.result ?? {}), pauseAcceptedBySdk: true }, updatedAt: Date.now() }),
      activateDelivery: async (trigger, { signal }) => {
        const delivered = runtimeTriggerDelivery(trigger.id)
        if (delivered.kind !== 'enqueued') throw new Error(`TRIGGER_SYNC_DELIVERY_${delivered.kind}`)
        const scope = runtimeTriggerQueueScope(trigger.receiverSessionId)
        const starter = runtimeTriggerReceiverStarter
        if (!scope || !starter) throw new Error('TRIGGER_SYNC_RECEIVER_UNAVAILABLE')
        const started = await starter({ sessionId: trigger.receiverSessionId, requestId: `runtime-trigger:${trigger.id}`, messageId: delivered.messageId, queueScope: scope })
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'sync wait aborted'))
        if (started === 'busy') return 'busy'
        if (started === 'unavailable') throw new Error('TRIGGER_SYNC_RECEIVER_UNAVAILABLE')
        const receipt = runtimeTriggerReadReceipt(trigger)
        if (!receipt?.turnId) throw new Error('TRIGGER_SYNC_RECEIVER_TURN_MISSING')
        return { sessionId: trigger.receiverSessionId, turnId: receipt.turnId }
      },
      waitForReceiverTurn: async (trigger, { signal, deadlineAt }) => {
        const scope = runtimeTriggerQueueScope(trigger.receiverSessionId)
        if (!scope) throw new Error('TRIGGER_SYNC_RECEIVER_UNAVAILABLE')
        const receipt = runtimeTriggerReadReceipt(trigger)
        if (!receipt?.queuedMessageId) throw new Error('TRIGGER_SYNC_RECEIVER_RECEIPT_MISSING')
        const turnId = await waitForRuntimeTriggerReceiverTurn({ readReceipt: () => runtimeTriggerReadReceipt(trigger),
          expectedMessageId: receipt.queuedMessageId, signal, deadlineAt })
        return { sessionId: trigger.receiverSessionId, turnId }
      },
      cancelPendingDelivery: (trigger) => {
        const queueScope = runtimeTriggerQueueScope(trigger.receiverSessionId)
        if (queueScope) sessionStorage.commands.scopedQueue.cancelUndispatchedRuntimeInput({ sessionId: trigger.receiverSessionId,
          requestId: `runtime-trigger:${trigger.id}`, queueScope })
      },
      subscribeReceiver: (receiverSessionId, receiverTurnId, listener) => turnTerminalBusForExecution(sessionStorage.execution)
        .subscribe(receiverSessionId, receiverTurnId, listener),
      readReceiver: async (receiverSessionId, receiverTurnId) => readPersistedTurnTerminal(
        sessionStorage.execution.readTurn({ sessionId: receiverSessionId, turnId: receiverTurnId }), receiverSessionId, receiverTurnId),
      registerWaiter: (triggerId, cancel) => {
        return runtimeTriggerSyncWaiters.register(triggerId, cancel)
      },
      fail: (id, revision, code, caseId) => sessionStorage.commands.runtimeTriggers.update(id, revision,
        { state: 'failed', result: { code, case: caseId }, updatedAt: Date.now() })
    })
  }
  getSessionForLedgerRepair = (sessionId) => {
    const session = sessionStorage.queries.readSession(sessionId)
    return session ? { id: session.id, createdAt: session.createdAt, generation: session.generation } : undefined
  }
  setMcpArtifactCapacityRequest(() => requestMcpArtifactCapacitySweep?.())
  startWindowReadyMaintenance = () => {
    sessionStorageHost.lifecycle.allowBackgroundWork()
    void measureStartupPhase('usage-stats-startup-maintenance', () => usageStatsStartupMaintenance?.())
    usageStatsStartupMaintenance = null
  }
  appSessionStorage = sessionStorage
  storageLifecycleStop = async (deadlineMs) => {
    sessionLedgerRepairScheduler.stop()
    const [sessionResult, profileResult] = await Promise.allSettled([
      sessionStorageHost.lifecycle.stop({ deadlineMs }),
      storageProfileCoordinator?.shutdown({ deadlineMs }) ?? Promise.resolve({ status: 'quiescent' as const })
    ])
    if (sessionResult.status === 'rejected' || profileResult.status === 'rejected' ||
      sessionResult.value.status === 'failed') return { status: 'failed' as const }
    const [sessionStatus, profileStatus] = [sessionResult.value, profileResult.value]
    return sessionStatus.status === 'quiescent' && profileStatus.status === 'quiescent'
      ? { status: 'quiescent' as const }
      : { status: 'deadline-exceeded' as const }
  }
  // Main-process owner only. Execution remains closed until a separately authorized cohort is started.
  sessionProjectionMigrationApplication = new SessionProjectionMigrationApplication(sessionStorage.projectionMigration)
  sessionProjectionMigrationApplication.initialize()
  initAgentLogger({
    getWorkDir: () => workDirManager?.getActiveWorkDir() ?? (workDirState || recoveryWorkDir),
    isPackaged: app.isPackaged,
    appVersion: getTelemetryAppVersion(),
    artifactBuildId: getTelemetryArtifactBuildId(),
    mainDirname: __dirname
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

  workDirState = recoveryWorkDir
  // 默认 workDir 可能尚不存在，提前创建避免 file:list-directory 等处理器 ENOENT
  try {
    mkdirSync(workDirState, { recursive: true })
  } catch (err) {
    console.warn('[workDir] ensure default dir failed:', err instanceof Error ? err.message : String(err))
  }

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
    sessionQueries: sessionStorage.queries,
    sessionCommands: sessionStorage.commands,
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

  // A2(偏差 18):宿主装配单例 runtime——必须经 createDesktopAgentRuntime 注入完整组件集
  // (空参 createAgentRuntime 全组件 no-op 桩:内置工具/取消/撤销/confirmId/MCP 限流/审计静默失效,
  //  评审 batch3-runtime-admission-sdk-review P0-1);旧全局注册函数经兼容转发落到本实例
  setDefaultAgentRuntime(createDesktopAgentRuntime())
  // S3(偏差 14):跨天节流清理——新日志文件开启时读统一保留策略并删除超期日志(每日至多一次)
  setAgentLogDailyPrune(() => {
    requestAgentLogRetention?.()
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

  // 脚本安全解析服务（P0-T4，§2.3/§3 不变量 8）：初始化前置到启动（三语法全量加载，
  // fire-and-forget 不阻断），失败/未就绪运行期一律 ask 兜底（fail-closed），降级可观测：
  // 初始化失败 → treesitter.init.failed；自检失败 → treesitter.selfcheck.failed；
  // 运行期 not_initialized → 每会话首次 treesitter.parse.not_ready。
  setInitFailureListener(({ failedReason }) => {
    logAgentEvent('error', 'treesitter.init.failed', { reason: failedReason })
  })
  setNotReadyParseListener(({ language, notReadyParseCount }) => {
    logAgentEvent('warn', 'treesitter.parse.not_ready', { language, notReadyParseCount })
  })
  void scriptParserService
    .ensureInitialized()
    .then(() => runSelfCheck())
    .then(() => {
      logAgentEvent('info', 'treesitter.selfcheck.passed', {})
    })
    .catch((err) => {
      // ensureInitialized 失败已由 setInitFailureListener 记录 treesitter.init.failed；
      // 此处只补记「初始化成功但自检失败」的自检分支，避免同一失败双写。
      if (scriptParserService.getStatus().ready) {
        logAgentEvent('error', 'treesitter.selfcheck.failed', {
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    })

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
  // confirmMode 退役（§5.7）：一次性删除存量 config.tools JSON 的 confirmMode 键（幂等、失败不阻塞）
  runConfirmModeRetirementMigrationOnce(db)
  // 存量「Shell 命令默认关闭」固化迁移：旧版本（bd5b5a01 前）保存过设置的用户，deniedTools 被
  // 旧默认固化为 ['run_shell']，覆盖新默认（开启）。识别旧默认指纹一次性打开（幂等、失败不阻塞）。
  runShellDefaultEnableMigrationOnce(db)
  runStartupDecisionCacheCleanup(db)

  const backup = new SessionBackupLifecycle(new SessionBackupManager(workDirState))
  const activeSessionIds = new Set(sessionStorage.queries.listSessions().map((session) => session.id))
  const isSessionActive = (sessionId: string) => Boolean(sessionStorage.queries.readSession(sessionId))
  void cleanupOrphanedChatAttachments(app.getPath('userData'), activeSessionIds, isSessionActive).catch((error) => {
    console.warn('[chatAttachment] orphan cleanup failed:', error instanceof Error ? error.message : String(error))
  })
  // 偏差 11:失效通知出口——Storage 版本递增后经主窗口广播 { scope, version }
  setInvalidationBroadcaster((scope, version) => {
    getMainWindow()?.webContents.send('scope:invalidated', { scope, version })
  })
  const turnDisplayPublisher = createTurnDisplayPublisher<Parameters<typeof turnToDisplay>[0], { type: string }>((turn, event) => {
    const display = turnToDisplay(turn)
    if (event.type === 'source-cancelled') display.outcome = 'cancelled'
    else if (event.type === 'source-timeout') display.outcome = 'timed-out'
    else if (event.type === 'source-failed') display.outcome = 'failed'
    else if (event.type === 'source-completed') display.outcome = 'completed'
    getMainWindow()?.webContents.send('chat:turn-display', { display })
  })
  turnDisplayPublisherStop = () => turnDisplayPublisher.dispose()
  const runtimeTriggerStartAuthorizer = createRuntimeTriggerStartAuthorizer({
    read: (id) => sessionStorage.commands.runtimeTriggers.read(id),
    update: (id, revision, patch) => sessionStorage.commands.runtimeTriggers.update(id, revision, patch),
    resolveQueueScope: (turn) => runtimeTriggerQueueScope(turn.sessionId),
    readReceipt: (receipt) => sessionStorage.commands.scopedQueue.readReceipt(receipt),
    classify: (source) => classifyQueueInputSource(db, source),
    verifyAdmission: (trigger, turn) => runtimeTriggerExecutionMaterials.verifyAdmission(turn),
    readCurrentAuthorization: (trigger) => runtimeTriggerAuthoritySnapshot(trigger),
    reauthorize: (trigger, scope) => {
      const resolved = resolveRuntimeTriggerBinding(trigger)
      return resolved && JSON.stringify(resolved.queueScope) === JSON.stringify(scope) ? resolved : null
    },
    cancel: ({ sessionId, requestId, queueScope, turnId }) => sessionStorage.commands.scopedQueue.cancelUndispatchedRuntimeInput({ sessionId, requestId, queueScope, expectedTurnId: turnId }),
    fail: (trigger, caseId) => { sessionStorage.commands.runtimeTriggers.update(trigger.id, trigger.revision, {
      state: 'failed', result: { ...(trigger.result ?? {}), code: 'TRIGGER_AUTHORIZATION_REVOKED', case: caseId }, updatedAt: Date.now()
    }) }
  })
  turnRuntime = createSessionTurnRuntime(sessionStorage, {
    deps: { now: Date.now, id: randomUUID },
    authorizeRuntimeTriggerStart: runtimeTriggerStartAuthorizer,
    onCancel: (turn) => {
      signalChatCancel(turn.turnId)
      // 撤确认卡必须按 requestId 索引（toolConfirmRegistry 的 pending 按 requestId 登记）；
      // signalChatCancel 收到的钥匙是 turnId，查不到确认卡，这里用完整 turn 对象上的真实 requestId 补齐
      cancelAllToolConfirmsForRequest(turn.requestId)
    },
    onEvent: (turn, event) => {
      turnDisplayPublisher.enqueue(turn, event)
      if (event.type === 'usage-updated') {
        const usage = (event as { usage?: unknown }).usage
        if (usage && typeof usage === 'object') getMainWindow()?.webContents.send('chat:turn-usage', { sessionId: turn.sessionId, usage, projected: Boolean((event as { projected?: boolean }).projected) })
      }
    }
  })
  // 启动只建立数据库与当前进程写入围栏；历史恢复、孤儿处置与spill回收由目标访问或既有维护触发。

  // 用量统计启动维护（需求 §7.3.1 / §7.4 / §7.5）：
  // 一次性历史台账回填（机会不可逆，schema_meta 标记保证只跑一次）→ 崩溃 Turn 补齐 → 保留期清理（删除留痕）。
  // 回填要同步扫描各 workDir 的全部台账（上限 100 个会话），大台账下会拖延启动数秒（评审 P1-3），
  // 因此这里只定义，推迟到主窗口创建完成后执行；统计非关键路径，晚几秒完成无碍。
  const runUsageStatsStartupMaintenance = (): void => {
    try {
      if (!getSchemaMeta(getDbConnection(db), SCHEMA_META_KEYS.usageStatsBackfillAt)) {
        const backfillWorkDirs = [workDirState, ...workDirManager!.listProfiles().map((profile) => profile.path)]
        const backfill = backfillUsageStats(db, Array.from(new Set(backfillWorkDirs.filter((dir) => dir))), sessionStorage.queries)
        setSchemaMeta(getDbConnection(db), SCHEMA_META_KEYS.usageStatsBackfillAt, String(Date.now()))
        logAgentEvent('info', 'usageStats.backfill.completed', {
          scannedSessionDirs: backfill.scannedSessionDirs,
          stepRowsWritten: backfill.stepRowsWritten,
          turnRowsWritten: backfill.turnRowsWritten,
          skippedMalformedFiles: backfill.skippedMalformedFiles
        })
      }
      const patched = reconcileUsageTurnFacts(db)
      if (patched > 0) {
        console.log(`[usageStats] reconciled ${patched} interrupted turn(s) after crash`)
      }
    } catch (error) {
      console.warn('[usageStats] startup maintenance failed:', error instanceof Error ? error.message : String(error))
    }
  }
  // 版本快照必须同步注入（仅缓存字符串、无 IO）：飞书/微信 autoStart 与 butler 调度器
  // 都在窗口创建之前启动，启动窗口期内触发的回合若拿到 undefined 会把 app_version 落成
  // null，且版本枚举查询（WHERE app_version IS NOT NULL）会漏掉这些行（评审跟进项）。
  setUsageStatsAppVersion(getTelemetryAppVersion())
  // 注册维护任务；实际执行时机在下方 createMainWindow 完成之后（评审 P1-3）。
  usageStatsStartupMaintenance = runUsageStatsStartupMaintenance

  // P0-③（评审 S1）：重校验队列的常驻生产 drain——入队方（读路径 stale / 终态检查点）之外
  // 必须有消费方，否则 mismatch verdict 永不重验/清除。unref 不阻碍进程退出。
  projectionRevalidationDrainStop = startSessionProjectionRevalidationDrain(db)
  // P3-③（评审 S3）：常驻事件循环延迟采样——p99 超阈值（200ms）落 agent 日志，作为
  // monitorEventLoopDelay 门禁证据；只告警不干预。
  const eventLoopWatchdog = startEventLoopWatchdog({ thresholdMs: 200 })
  eventLoopWatchdogStop = eventLoopWatchdog.stop

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
    sessionStorage.queries,
    process.platform,
    createHostTranslator({ locale: readAppLocale(db) }),
    () => createMainWindow()
  )

  const executeClaudeRequest = registerClaudeStreamHandlers(ipcMain, {
    getApiKey,
    getWorkDir: () => workDirState,
    getWorkDirManager: () => workDirManager ?? undefined,
    resolveWorkDirForSession: (sessionId, requestId, turnId) => {
      const resolved = resolveSessionWorkDir(sessionId)
      const snapshot = workDirAuthorizationSnapshot(resolved)
      return requestId && turnId
        ? resolvePrimedClaudeWorkDir({ sessionId, requestId, turnId }, snapshot?.binding, snapshot?.workDir ?? workDirState)
        : snapshot?.workDir ?? resolved?.workDir ?? workDirState
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
      const raw = getConfigValue(db, CONFIG_KEYS.wiki)
      if (!raw) return mergeWikiConfig(null)
      try {
        return mergeWikiConfig(JSON.parse(raw) as Parameters<typeof mergeWikiConfig>[0])
      } catch {
        return mergeWikiConfig(null)
      }
    },
    getAppDatabase: () => db,
    sessionMessages,
    getProjectMemoryEnabled: () => true,
    getBrowserConfig: () => readBrowserConfigFromDb(db),
    getShellConfig: () => readShellConfigFromDb(db),
    getBrowserDetectContext: () => ({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      devRoot: path.join(__dirname, '..', '..')
    }),
    floatingNotificationManager: floatingManager,
    notifyMainWindow: (channel, payload) => getMainWindow()?.webContents.send(channel, payload),
    turnRuntime,
    sessionStorage,
    runtimeTriggers: runtimeTriggerService,
    runtimeTriggerAdmission: (request) => runtimeTriggerExecutionMaterials.admission(request),
    runtimeTriggerSourceContext: (request) => runtimeTriggerExecutionMaterials.sourceContext(request),
    runtimeTriggerLifecycle: ({ sessionId, turnId, history }) => ({
      ...runtimeTriggerSyncLifecycle(sessionId, history)
    })
  })

  const executeTurn = async (
    sender: Electron.WebContents | null,
    payload: ClaudeChatCreateWithToolsPayload,
    skillTurnScope?: import('./skills/skillTurnScope').SkillTurnScope
  ) => {
    if (!payload.turnId || !payload.turnStartToken) throw new Error('TURN_EXECUTION_CREDENTIALS_REQUIRED')
    const { turnId, turnStartToken, requestId } = payload
    const targetTurn = turnRuntime.getTurn(turnId)
    if (!targetTurn) throw new Error('UNKNOWN_TURN')
    turnRuntime.bindRequest(requestId, turnId)
    let executionClaimed = false
    try {
      return await runWithPersistedTurnTerminalNotification(sessionStorage.execution, targetTurn, () => turnRuntime.executeWithSource(turnId, turnStartToken, async (_turn) => {
        executionClaimed = true
        const result = await executeClaudeRequest(sender, { ...payload, ...(skillTurnScope ? { skillTurnScope } : {}) }) as { ok?: boolean; error?: string; usage?: unknown; outcome?: 'commit-uncertain' }
        if (result.ok) {
          turnRuntime.consumeForRequest(requestId, { type: 'source-completed' }, turnId)
          return { outcome: 'completed' as const, usage: result.usage }
        }
        if (result.outcome === 'commit-uncertain') {
          turnRuntime.consumeForRequest(requestId, { type: 'source-uncertain', message: result.error }, turnId)
          return {
            outcome: 'commit-uncertain' as const,
            error: { code: 'SESSION_TRANSCRIPT_COMMIT_UNCERTAIN', message: result.error ?? 'Session transcript commit is uncertain' }
          }
        }
        turnRuntime.consumeForRequest(requestId, { type: 'source-failed', message: result.error }, turnId)
        return { outcome: 'failed' as const, error: { code: 'source-failed', message: result.error ?? 'Claude execution failed' } }
      }))
    } finally {
      if (executionClaimed) skillTurnScope?.close()
    }
  }

  storageProfileCoordinator = registerAppIpcHandlers(ipcMain, {
    db,
    sessionStorage,
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
    isTrayEnabled,
    turnRuntime,
    publishRuntimeTriggerReceiverStarter: (starter) => { runtimeTriggerReceiverStarter = starter },
    publishDesktopDrainRequester: (requester) => { requestDesktopDrain = requester },
    agentSessionExecutionAuthorization,
    wakeSourceTruthSpillGc: () => {
      const spillRoot = path.join(app.getPath('userData'), 'spill')
      void runSourceTruthSpillGcMaintenance(db, spillRoot).catch((error) => {
        logAgentEvent('warn', 'storage.spill.source_truth_gc_failed', {
          phase: 'delete-wakeup', reason: error instanceof Error ? error.name : 'unknown'
        })
      })
    },
    executeTurn
  })

  const runtimeTriggerRecovery = createRuntimeTriggerRecovery({
    listWaiting: () => sessionStorage.commands.runtimeTriggers.listByState('waiting', 4_096),
    listMatched: (after) => sessionStorage.commands.runtimeTriggers.listByState('matched', 4_096, after),
    read: (id) => sessionStorage.commands.runtimeTriggers.read(id),
    evaluateWaiting: (trigger, now) => evaluateRuntimeTriggerSource(trigger, {
      now, queries: sessionStorage.queries,
      readSettledSteps: (targetSessionId) => readSessionSettledStepFacts(sessionStorage.execution, targetSessionId),
      readTurnCompletion: async (targetSessionId, targetTurnId) => {
        const turn = sessionStorage.execution.readTurn({ sessionId: targetSessionId, turnId: targetTurnId })
        const terminal = readPersistedTurnTerminal(turn, targetSessionId, targetTurnId)
        if (terminal.kind === 'pending') return { kind: 'pending' }
        if (terminal.kind === 'source-gap') return { kind: 'source-gap', case: terminal.case }
        const occurredAt = Number(turn?.updatedAt)
        if (!Number.isSafeInteger(occurredAt)) return { kind: 'source-gap', case: 'turn-terminal-time-unavailable' }
        const outcome = terminal.outcome === 'completed' ? 'completed' : terminal.outcome === 'cancelled' ? 'cancelled'
          : terminal.outcome === 'timed-out' || terminal.outcome === 'timed_out' ? 'timed-out' : 'failed'
        return { kind: 'terminal', sessionId: terminal.sessionId, turnId: terminal.turnId, outcome, occurredAt }
      },
      readAgentSettlement: (ownerSessionId, requestId) => sessionStorage.commands.agentSessionMessages.readSettlement({ ownerSessionId, requestId })
    }),
    match: (id, revision, event) => sessionStorage.commands.runtimeTriggers.update(id, revision,
      { state: 'matched', matchedAt: Date.now(), event, updatedAt: Date.now() }),
    expire: (id, revision) => sessionStorage.commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: Date.now() }),
    fail: (id, revision, code, caseId) => sessionStorage.commands.runtimeTriggers.update(id, revision,
      { state: 'failed', result: { code, case: caseId }, updatedAt: Date.now() }),
    deliver: runtimeTriggerDelivery,
    update: (id, revision, patch) => sessionStorage.commands.runtimeTriggers.update(id, revision, patch),
    readReceipt: runtimeTriggerReadReceipt,
    cancelQueuedMarker: (trigger) => {
      const queueScope = runtimeTriggerQueueScope(trigger.receiverSessionId)
      return queueScope ? sessionStorage.commands.scopedQueue.cancelUnstartedInput({ sessionId: trigger.receiverSessionId,
        requestId: `runtime-trigger:${trigger.id}`, queueScope, expectedSource: 'runtime-trigger' }) : false
    },
    onQueueReleased: (sessionId) => {
      void Promise.resolve().then(() => requestDesktopDrain(sessionId, 'capacity-released')).catch((error) => {
        console.warn('[session-message] failed trigger queue wake failed:', error instanceof Error ? error.message : String(error))
      })
    },
    isSessionBusy: (sessionId) => sessionStorage.execution.hasActiveTurn(sessionId),
    startReceiver: async ({ sessionId, requestId, messageId }) => {
      const scope = runtimeTriggerQueueScope(sessionId)
      return scope && runtimeTriggerReceiverStarter
        ? runtimeTriggerReceiverStarter({ sessionId, requestId, messageId, queueScope: scope })
        : 'unavailable'
    },
    readTurnTerminal: (sessionId, turnId) => {
      const terminal = readPersistedTurnTerminal(sessionStorage.execution.readTurn({ sessionId, turnId }), sessionId, turnId)
      if (terminal.kind === 'pending') return { kind: 'active' }
      if (terminal.kind === 'source-gap') return { kind: 'missing' }
      const outcome = terminal.outcome === 'completed' ? 'completed' : terminal.outcome === 'cancelled' ? 'cancelled'
        : terminal.outcome === 'timed-out' || terminal.outcome === 'timed_out' ? 'timed-out' : 'failed'
      return { kind: 'terminal', outcome }
    },
    onDeliveryError: (triggerId, error) => logAgentEvent('error', 'runtime-trigger.delivery.failed', {
      triggerId, reason: error instanceof Error ? error.message : String(error)
    })
  })
  subscribeRuntimeTriggerProcessExitHandoff(sessionStorage.commands)
  failOrphanedRuntimeSyncTriggers(sessionStorage.commands, Date.now(), {
    resolveQueueScope: runtimeTriggerQueueScope,
    onQueueReleased: (sessionId) => {
      // Defer until startup finishes installing the admission gate, then reread and drain the new physical head.
      void Promise.resolve().then(() => requestDesktopDrain(sessionId, 'startup-recovery')).catch((error) => {
        console.warn('[session-message] orphaned sync trigger queue wake failed:', error instanceof Error ? error.message : String(error))
      })
    }
  })
  runtimeTriggerRecoveryStop = runtimeTriggerRecovery.stop
  runtimeTriggerRecovery.start()
  void runtimeTriggerRecovery.scan()

  // P4 管家执行链：单入口准入（进程级共享实例，并发=1 全局有效）+ IPC 面（CRUD + 手动触发）
  // B1(偏差 23):统一调用级准入(状态归 Storage);butlerAdmission 退役。
  // 顺序纪律(P1-1,评审):先清零 DB 活跃段、再构造门——门构造即 loadAdmissionState,
  // 反序会把上一进程的幻影票据读进内存且永无 release,并发上限被永久蚕食
  resetActiveAdmissionOnStartup(db, Date.now())
  const wakeAgentSessionQueue = (reason: OutboundDrainWakeReason) => wakeQueuedAgentSessions({
    sessionIds: () => sessionStorage.queries.listSessions({ view: 'all' }).map((session) => session.id),
    getNextQueued: (sessionId) => sessionStorage.execution.getNextDesktopQueueInput(sessionId),
    recoverTarget: (sessionId) => sessionStorage.execution.recoverExecutionTarget(sessionId),
    reason,
    drain: (sessionId, wakeReason) => requestDesktopDrain(sessionId, wakeReason),
    onError: (_sessionId, error) => console.warn('[session-message] desktop queue wake failed:',
      error instanceof Error ? error.message : String(error))
  })
  setCallAdmissionGate(new CallAdmissionGate({ db, onReleased: () => {
    // facts-only scan: global capacity release wakes persisted agent-session inputs across desktop sessions.
    wakeAgentSessionQueue('capacity-released')
  } }))
  // Startup recovery only wakes durable queued work; approval and atomic claim are rechecked by the drainer.
  wakeAgentSessionQueue('startup-recovery')
  // P6：共享投递入口（装配器持有，状态随实例走）。桌面 sink 的注册在 butlerDelivery
  // （deliveryPorts.notifyDesktop 即桌面实现，闭包与投递同源）；此处只建 hub 容器传递，
  // 避免同 id 驱动源被 butlerDelivery 覆盖注册后此处退化为死代码。
  const deliveryJournal = new SqliteDeliveryJournal(db)
  deliveryJournal.markInterruptedDispatchesUncertain()
  const sharedDeliveryHub = createDeliveryHub({ journal: deliveryJournal, onDeferredSettled: () => { syncAutomationTaskRunDeliveryStatuses(db) } })
  syncAutomationTaskRunDeliveryStatuses(db)
  const flushDeliveries = (driverId: 'feishu' | 'wechat') => {
    void sharedDeliveryHub.reportReachability(driverId)
      .then(() => { syncAutomationTaskRunDeliveryStatuses(db) })
      .catch((error) => console.error(`[Delivery] ${driverId} reachability flush failed`, error))
  }
  let feishuDeliveryReachable = false
  let wechatDeliveryReachable = false
  const butlerInvokerDeps: ButlerInvokerDeps = {
    db,
    sessionStorage,
    turnRuntime,
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
    getBrowserConfig: () => readBrowserConfigFromDb(db),
    getShellConfig: () => readShellConfigFromDb(db),
    workDirManager: workDirManager!,
    resolveWorkDirForSession: (sessionId) => {
      const resolved = resolveWorkDirForSession(
        sessionStorage.queries,
        sessionId,
        () => workDirManager!.listProfiles(),
        () => workDirManager!.getActiveProfileId(),
        () => workDirManager!.getActiveWorkDir()
      )
      return resolved?.workDir ?? workDirState
    },
    getActiveWorkDirProfileId: () => workDirManager!.getActiveProfileId(),
    getActiveWorkDirProfilePath: () => workDirManager!.getActiveProfile()?.path,
    admissionGate: getCallAdmissionGate(),
    onSessionCreated: (session) => getMainWindow()?.webContents.send('session:created', { session }),
    // P6（偏差 8 机制面）：驱动源层唯一投递入口——桌面 sink（系统通知）注册进共享 hub；
    // butler 投递经 hub 路由并落送达记录。桌面终态发送通道（notifyMainWindow 路径）与
    // 文件树/文件内容直连点不迁（驱动权路径 9/10/11 认领存量收敛）。
    deliveryHub: sharedDeliveryHub,
    deliveryPorts: {
      // v1 桌面端口用系统通知（窗口状态语义由 OS 托管）；IM 端口未接线时走 butlerDelivery
      // 的显式降级路径。浮动窗结果展示随偏差 8 整项关闭时统一。
      notifyDesktop: (summary) => {
        if (!Notification.isSupported()) return
        const notification = new Notification({
          title: createHostTranslator({ locale: readAppLocale(db) })({ key: 'notification.desktopButlerTitle' }),
          body: summary.slice(0, 280)
        })
        notification.on('click', () => void showMainWindow())
        notification.show()
      },
      isFeishuReachable: () => feishuDeliveryReachable,
      sendFeishu: async (text, rawTarget) => {
        const target = rawTarget?.trim()
        if (!target) throw new Error('FEISHU_DELIVERY_TARGET_REQUIRED')
        const bundle = getFeishuBundle()
        if (!bundle) throw new Error('FEISHU_DELIVERY_UNAVAILABLE')
        await sendFeishuTextToTarget(bundle.runner, target, text)
      },
      isWechatReachable: () => wechatDeliveryReachable,
      sendWechat: async (text, target) => {
        if (!target?.trim()) throw new Error('WECHAT_DELIVERY_TARGET_REQUIRED')
        const bot = getWeChatBundle()?.botService.getRawBot()
        if (!bot) throw new Error('WECHAT_DELIVERY_UNAVAILABLE')
        await sendWeChatTextToUser(bot, target.trim(), text)
      }
    }
  }
  registerButlerDeliveryDrivers(sharedDeliveryHub, butlerInvokerDeps.deliveryPorts ?? {})
  registerButlerIpcHandlers(ipcMain, butlerInvokerDeps)

  // P6 定时调度器：托盘前提（P0 决策 a）+ 启动恢复 + interval tick；before-quit 停机标 interrupted。
  // 实际 start() 延后到 initTray() 之后（见下方 whenReady 尾部）。
  butlerScheduler = new ButlerTaskScheduler({
    db,
    runTask: (taskId, request) => runButlerTask(butlerInvokerDeps, taskId, request),
    isTrayEnabled
  })

  const modelName = () => getConfigValue(db, 'config.model') ?? 'claude-sonnet-4-20250514'
  createFeishuBundle({
    db,
    turnRuntime,
    getUserDataPath: () => app.getPath('userData'),
    getWorkDir: () => workDirState,
    workDirManager: workDirManager!,
    sessionStorage,
    getApiKey,
    getBaseUrl: () => getConfigValue(db, 'config.baseUrl') ?? '',
    getModel: modelName,
    getMaxParallel: () => {
      const raw = getConfigValue(db, 'config.maxParallelChatSessions')
      return raw ? Number(raw) : 3
    },
    onReachabilityChange: (reachable) => { feishuDeliveryReachable = reachable; if (reachable) flushDeliveries('feishu') },
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
    sessionStorage,
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
    sessionStorage,
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
    appVersion: getTelemetryAppVersion(),
    onReachabilityChange: (reachable) => { wechatDeliveryReachable = reachable; if (reachable) flushDeliveries('wechat') }
  })
  registerWeChatIpcHandlers(ipcMain, {
    db,
    sessionStorage,
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
    appVersion: getTelemetryAppVersion()
  })

  try {
    // Run pending revocation cascades after both lane invalidators are registered and before auto-starting ingress.
    remoteAuthorizationRegistry.recoverPendingRevocations()
    const taskControlRecovery = createImTaskControlCoordinator({
      db,
      safetyPort: createDeferredTodoTaskControlSafetyPort({
        todoStore: createDeferredTodoStore(db, { capacity: createDeferredTodoCapacityController(db) }),
        dispatchDeferred: async () => { throw new Error('DEFERRED_RESUME_DISPATCH_NOT_AVAILABLE_DURING_STARTUP') }
      })
    })
    const recoveredOperations = await taskControlRecovery.recoverPendingOperations()
    const unresolvedOperations = recoveredOperations.filter(({ status }) => status !== 'cancelled' && status !== 'revised')
    if (unresolvedOperations.length) throw new Error(`IM_TASK_CONTROL_RECOVERY_INCOMPLETE:${unresolvedOperations.map(({ operationId, status }) => `${operationId}:${status}`).join(',')}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('远程授权恢复失败', `授权撤销恢复未完成，远程入口保持关闭。\n\n错误：${detail}`)
    app.quit()
    return
  }
  try {
    await Promise.all([getFeishuBundle()?.recoverDeferredApprovals(), getWeChatBundle()?.recoverDeferredApprovals()])
  } catch (error) {
    console.error('[deferredApproval] startup recovery failed:', error instanceof Error ? error.message : String(error))
  }
  void measureStartupPhase('feishu-auto-start', () => autoStartFeishuEventIfNeeded(db))

  initTray({
    createMainWindow,
    getMainWindow,
    mainDirname: __dirname
  })
  // 托盘初始化完成后才能启动定时调度器：start() 内的托盘前提校验读 isTrayEnabled()，
  // 早于 initTray 会在托盘实际启用的情况下被误判为未启用（disabled-no-tray）而永不启动。
  butlerScheduler?.start()

  void measureStartupPhase('wechat-auto-start', () => autoStartWeChatPollIfNeeded(db))

  setupWindowIconThemeListener(__dirname)
  mainIpcReady = true
  await showStartupStatus('正在准备应用窗口…')
  void createMainWindow()
    .then(() => {
      const userDataDir = app.getPath('userData')
      const legacyBackupPath = path.join(userDataDir, 'bak-spaceassistant-data.json')
      if (existsSync(legacyBackupPath)) {
        void dialog.showMessageBox({
          type: 'warning',
          title: '旧数据库备份',
          message: '发现迁移后遗留的旧 JSON 数据备份。是否将它归档到 session-archives？',
          detail: '归档会移动该文件，不会删除备份内容。选择“暂不”会保留原文件。',
          buttons: ['归档备份', '暂不'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        }).then(({ response }) => {
          const result = archiveLegacyDatabaseJsonBackup(userDataDir, response === 0)
          console.info('[storage] legacy JSON backup cleanup:', result.status)
        }).catch((error) => {
          console.warn('[storage] legacy JSON backup prompt failed:', error instanceof Error ? error.message : String(error))
        })
      }
      if (safeDbMaintenanceRequested) {
        const spillRoot = path.join(userDataDir, 'spill')
        safeDatabaseMaintenanceInFlight = measureStartupPhase('safe-db-maintenance', () => createSpillStore(spillRoot).withSpillRootFence(() => runSafeDbMaintenance(db, userDataDir, () => sessionStorage.clearProjectionCaches?.() ?? Promise.reject(new Error('SESSION_STORAGE_CACHE_CLEANUP_REQUIRED'))))).then(() => {
          console.info('[storage] safe database maintenance completed')
        }).catch((error) => {
          console.error('[storage] safe database maintenance failed; app remains available:', error instanceof Error ? error.message : String(error))
        }).finally(() => { safeDatabaseMaintenanceInFlight = undefined })
      }
    })
    .catch((error) => {
      console.warn('[main] main window creation failed; post-window maintenance remains deferred:', error instanceof Error ? error.message : String(error))
    })
  setupAppMenu(createHostTranslator({ locale: readAppLocale(db) }))
  // 归档保留策略（B1/N5）：放 whenReady 尾部而非 reconcile 旁——此时 initAgentLogger 已执行（否则
  // logAgentEvent 静默 no-op，删除完全无可观测性）；fire-and-forget，不占启动关键路径。
  // 无 protect：若 --safe-db-maintenance 的压缩仍在飞行，按宽限期整体延后。
  void pruneSessionArchives(app.getPath('userData')).catch((error) => {
    console.error('[main] archive prune failed:', error instanceof Error ? error.stack ?? error.message : error)
  })
}).catch((err) => {
  console.error('[main] whenReady failed:', err instanceof Error ? err.stack ?? err.message : err)
})

app.on('before-quit', (event) => {
  if (quitCleanupDone) return
  event.preventDefault()
  isQuitting = true
  try { getDefaultAgentRuntime().reviewScopeCache.clearAll() } catch { /* Startup may fail before runtime assembly. */ }
  turnDisplayPublisherStop?.()
  turnDisplayPublisherStop = null
  const runtimeTriggerRecoveryQuiescence = runtimeTriggerRecoveryStop?.() ?? Promise.resolve()
  runtimeTriggerRecoveryStop = null
  runtimeTriggerSyncWaitStop?.()
  runtimeTriggerSyncWaitStop = null
  runtimeTriggerReceiverStarter = null
  // 必须在启动异步 cleanup 之前同步切断事件生产，否则 flush 与最后一批
  // chunk/关键事件并发，flush 返回后仍可能接受新事件并被 app.quit 丢弃。
  beginSessionEventShutdown()
  const lifecycleStop = storageLifecycleStop
  storageLifecycleStop = null
  const storageQuiescence = lifecycleStop?.(SHUTDOWN_TIMEOUT_MS) ?? Promise.resolve({ status: 'quiescent' as const })
  void storageQuiescence.then((result) => {
    if (result.status === 'deadline-exceeded') console.warn('[shutdown] storage maintenance did not become quiescent before deadline')
    else if (result.status === 'failed') console.warn('[shutdown] storage maintenance quiescence failed; database close will be skipped')
  })
  const sessionProjectionMigrationShutdown = sessionProjectionMigrationApplication?.shutdown() ?? Promise.resolve()
  sessionProjectionMigrationApplication = null
  butlerScheduler?.stop()
  destroyTray()
  floatingManager?.destroy()
  projectionRevalidationDrainStop?.stop()
  eventLoopWatchdogStop?.()
  stopMemoryWatcher()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.destroy()
  }
  void (async () => {
    let timedOut = false
    let storageQuiescent = false
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
      const result = await Promise.race([
        Promise.all([runShutdownCleanup(pendingTasks), sessionProjectionMigrationShutdown, storageQuiescence, runtimeTriggerRecoveryQuiescence]).then(([cleanupResult, _migration, storageResult]) => {
          storageQuiescent = storageResult.status === 'quiescent'
          return cleanupResult
        }),
        timeout
      ])
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
      if (storageQuiescent && !timedOut) {
        appDb?.flushSave()
        appDb?.close()
      } else {
        console.warn('[shutdown] database flush/close skipped because storage work did not become quiescent')
      }
      appSessionStorage = null
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
