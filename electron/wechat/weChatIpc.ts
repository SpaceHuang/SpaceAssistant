import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { type IpcMain } from 'electron'
import type { AppDatabase } from '../database'
import { getConfigValue, setConfigValue } from '../database'
import {
  mergeWeChatConfig,
  weChatConfigNeedsPolicyMigration,
  type WeChatConfig
} from '../../src/shared/wechatTypes'
import { WeChatProcessedStore } from './weChatProcessedStore'
import { WeChatAuditLogger } from './weChatAuditLogger'
import { WeChatConfirmManager } from './weChatConfirmManager'
import { WeChatBotService, detectWeChatSdk } from './weChatBotService'
import { WeChatCommandRouter } from './weChatCommandRouter'
import type { WorkDirManager } from '../workDirManager'
import { getMainWindow } from '../windowRef'
import { mergeToolsConfig } from '../../src/shared/domainTypes'
import { readBrowserConfigFromDb } from '../browser/browserConfigDb'
import { readShellConfigFromDb } from '../shell/shellConfigDb'
import { cancelAllActiveChats } from '../chatCancelRegistry'
import { flushWeChatCliLogger, logWeChatCliEvent } from './weChatCliLogger'
import { isTrayEnabled } from '../tray'

const WECHAT_CONFIG_KEY = 'config.wechat'

export type WeChatServiceBundle = {
  processedStore: WeChatProcessedStore
  confirmManager: WeChatConfirmManager
  auditLogger: WeChatAuditLogger
  botService: WeChatBotService
  router: WeChatCommandRouter | null
}

let bundle: WeChatServiceBundle | null = null

export function readWeChatConfigFromDb(db: AppDatabase): WeChatConfig {
  const raw = getConfigValue(db, WECHAT_CONFIG_KEY)
  if (!raw) return mergeWeChatConfig(null)
  try {
    const stored = JSON.parse(raw) as Partial<WeChatConfig>
    const merged = mergeWeChatConfig(stored)
    if (weChatConfigNeedsPolicyMigration(stored, merged)) {
      setConfigValue(db, WECHAT_CONFIG_KEY, JSON.stringify(merged))
      logWeChatCliEvent('info', 'wechat.config.migrated', {
        from: stored.remoteConfirmPolicy,
        to: merged.remoteConfirmPolicy
      })
    }
    return merged
  } catch {
    return mergeWeChatConfig(null)
  }
}

export function createWeChatBundle(deps: {
  db: AppDatabase
  getUserDataPath: () => string
  getWorkDir: () => string
  workDirManager: WorkDirManager
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  getMaxParallel: () => number
  getToolsConfig: () => ReturnType<typeof mergeToolsConfig>
  appVersion: string
}): WeChatServiceBundle {
  const userData = deps.getUserDataPath()
  const storageDir = path.join(userData, 'wechatbot')
  const readCfg = () => readWeChatConfigFromDb(deps.db)
  const processedStore = new WeChatProcessedStore(userData)
  const auditLogger = new WeChatAuditLogger(userData)

  const getWc = () => getMainWindow()?.webContents ?? null

  const botService = new WeChatBotService({
    storageDir,
    appVersion: deps.appVersion,
    getWebContents: getWc,
    onInbound: (msg) => {
      void bundle?.router?.handleSdkInbound(msg)
    }
  })

  const confirmManager = new WeChatConfirmManager(auditLogger, getWc, () => botService.getBot() ?? undefined)

  const router = new WeChatCommandRouter({
    db: deps.db,
    botService,
    processedStore,
    confirmManager,
    auditLogger,
    getWeChatConfig: readCfg,
    getAppConfig: () => ({
      defaultModel: deps.getModel(),
      maxParallelChatSessions: deps.getMaxParallel()
    }),
    getWorkDir: deps.getWorkDir,
    workDirManager: deps.workDirManager,
    getUserDataPath: deps.getUserDataPath,
    getApiKey: deps.getApiKey,
    getBaseUrl: deps.getBaseUrl,
    getMainWebContents: getWc,
    getModel: deps.getModel,
    getToolsConfig: deps.getToolsConfig,
    getBrowserConfig: () => readBrowserConfigFromDb(deps.db),
    getShellConfig: () => readShellConfigFromDb(deps.db)
  })

  const cfg = readCfg()
  const hasStoredCredentials = fs.existsSync(path.join(storageDir, 'credentials.json'))
  if (cfg.loggedIn && hasStoredCredentials) {
    botService.setLoggedInMirror({
      loggedIn: cfg.loggedIn,
      displayName: cfg.displayName,
      botIdSuffix: cfg.botIdSuffix
    })
  } else if (cfg.loggedIn && !hasStoredCredentials) {
    logWeChatCliEvent('warn', 'wechat.bundle.stale_login', { storageDir })
  }

  bundle = { processedStore, confirmManager, auditLogger, botService, router }
  logWeChatCliEvent('info', 'wechat.service.bundle_created', {
    loggedIn: cfg.loggedIn && hasStoredCredentials,
    remoteEnabled: cfg.remoteEnabled,
    storageDir
  })
  return bundle
}

export function getWeChatBundle(): WeChatServiceBundle | null {
  return bundle
}

export async function autoStartWeChatPollIfNeeded(db: AppDatabase): Promise<void> {
  const cfg = readWeChatConfigFromDb(db)
  if (!cfg.enabled || !cfg.remoteEnabled || !cfg.loggedIn || !bundle?.botService) {
    logWeChatCliEvent('info', 'wechat.poll.auto_start_skipped', {
      enabled: cfg.enabled,
      remoteEnabled: cfg.remoteEnabled,
      loggedIn: cfg.loggedIn,
      hasBundle: Boolean(bundle?.botService)
    })
    return
  }
  const status = await bundle.botService.startPoll()
  logWeChatCliEvent(status.pollState === 'polling' ? 'info' : 'error', 'wechat.poll.auto_start', {
    pollState: status.pollState,
    lastError: status.lastError
  })
}

export async function pauseWeChatPollIfWindowClosed(): Promise<void> {
  if (isTrayEnabled()) return
  await bundle?.botService?.stopPoll()
  logWeChatCliEvent('info', 'wechat.poll.paused_window_closed', {})
}

export async function shutdownWeChatServices(): Promise<void> {
  cancelAllActiveChats()
  bundle?.confirmManager.cancelAllPending()
  await bundle?.botService?.stopPoll()
  logWeChatCliEvent('info', 'wechat.service.shutdown', {})
  await flushWeChatCliLogger()
}

export function registerWeChatIpcHandlers(
  ipcMain: IpcMain,
  deps: {
    db: AppDatabase
    getUserDataPath: () => string
    getWorkDir: () => string
    workDirManager: WorkDirManager
    getApiKey: () => Promise<string | null>
    getBaseUrl: () => string
    getModel: () => string
    getMaxParallel: () => number
    getToolsConfig: () => ReturnType<typeof mergeToolsConfig>
    appVersion: string
  }
): void {
  if (!bundle) createWeChatBundle(deps)
  const b = bundle!

  ipcMain.handle('wechat:detect-sdk', async () => {
    const result = await detectWeChatSdk()
    logWeChatCliEvent('info', 'wechat.ipc.detect_sdk', { ...result })
    return result
  })

  ipcMain.handle('wechat:login-start', async (_e, opts?: { force?: boolean }) => {
    const cfg = readWeChatConfigFromDb(deps.db)
    const r = await b.botService.loginStart(cfg.remoteRateLimitPerMinute, {
      force: Boolean(opts?.force)
    })
    if (r.ok) {
      const status = b.botService.getStatus()
      persistWeChatConfig(deps.db, {
        enabled: true,
        loggedIn: true,
        remoteEnabled: true,
        displayName: status.displayName,
        botIdSuffix: status.botIdSuffix
      })
      const pollStatus = await b.botService.startPoll()
      logWeChatCliEvent(pollStatus.pollState === 'polling' ? 'info' : 'error', 'wechat.ipc.login_start', {
        ok: r.ok,
        pollState: pollStatus.pollState,
        lastError: pollStatus.lastError
      })
    } else {
      logWeChatCliEvent('warn', 'wechat.ipc.login_start', { ok: false, error: r.error })
    }
    return r
  })

  ipcMain.handle('wechat:login-stop', async () => {
    await b.botService.loginStop()
    return { ok: true }
  })

  ipcMain.handle('wechat:submit-verify-code', async (_e, code: string) => {
    return b.botService.submitVerifyCode(typeof code === 'string' ? code : '')
  })

  ipcMain.handle('wechat:logout', async () => {
    await b.botService.logout()
    const storageDir = path.join(deps.getUserDataPath(), 'wechatbot')
    try {
      await fsPromises.rm(storageDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    persistWeChatConfig(deps.db, {
      loggedIn: false,
      displayName: undefined,
      botIdSuffix: undefined,
      enabled: false,
      remoteEnabled: false
    })
    logWeChatCliEvent('info', 'wechat.ipc.logout', {})
    return { ok: true }
  })

  ipcMain.handle('wechat:connection-status', async () => b.botService.getStatus())

  ipcMain.handle('wechat:poll-start', async () => {
    const status = await b.botService.startPoll()
    logWeChatCliEvent(status.pollState === 'polling' ? 'info' : 'error', 'wechat.poll.start', {
      pollState: status.pollState,
      lastError: status.lastError
    })
    persistWeChatConfig(deps.db, { remoteEnabled: true })
    return status
  })

  ipcMain.handle('wechat:poll-stop', async () => {
    const status = await b.botService.stopPoll()
    persistWeChatConfig(deps.db, { remoteEnabled: false })
    logWeChatCliEvent('info', 'wechat.ipc.poll_stop', { pollState: status.pollState })
    return status
  })

  ipcMain.handle('wechat:audit-tail', async (_e, limit?: number) => b.auditLogger.tail(limit ?? 50))

  ipcMain.handle(
    'wechat:audit-query',
    async (_e, opts: { since?: number; types?: string[]; limit?: number }) => b.auditLogger.query(opts ?? {})
  )

  ipcMain.handle('wechat:pending-confirms', async () => b.confirmManager.listPending())

  ipcMain.handle('wechat:confirm-response', async (_e, payload: { requestId: string; approved: boolean }) => {
    const ok = b.confirmManager.resolveFromDesktop(payload.requestId, payload.approved)
    return { ok }
  })

  ipcMain.handle(
    'wechat:send',
    async (_e, payload: { userId: string; text: string; imagePath?: string; filePath?: string }) => {
      const { executeWeChatSend } = await import('../tools/weChatToolExecutor')
      return executeWeChatSend(payload, {
        workDir: deps.getWorkDir(),
        botService: b.botService,
        getWeChatConfig: () => readWeChatConfigFromDb(deps.db)
      })
    }
  )

  ipcMain.handle(
    'wechat:reply',
    async (_e, payload: { text: string; imagePath?: string; filePath?: string; sessionId?: string }) => {
      const { executeWeChatReply } = await import('../tools/weChatToolExecutor')
      return executeWeChatReply(payload, {
        workDir: deps.getWorkDir(),
        botService: b.botService,
        db: deps.db,
        sessionId: payload.sessionId
      })
    }
  )
}

export function persistWeChatConfig(db: AppDatabase, partial: Partial<WeChatConfig>): WeChatConfig {
  const next = mergeWeChatConfig({ ...readWeChatConfigFromDb(db), ...partial })
  setConfigValue(db, WECHAT_CONFIG_KEY, JSON.stringify(next))
  logWeChatCliEvent('info', 'wechat.config.persist', { keys: Object.keys(partial) })
  return next
}
