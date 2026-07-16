import { type IpcMain } from 'electron'
import { runNpmCommand, runNpxCommand } from './npmCommandRunner'
import { runFeishuCliWithBrowserFlow } from './feishuCliFlow'
import type { AppDatabase } from '../database'
import { getConfigValue, setConfigValue } from '../database'
import { mergeFeishuConfig, type FeishuConfig } from '../../src/shared/feishuTypes'
import { LarkCliRunner } from './larkCliRunner'
import { FeishuProcessedStore } from './feishuProcessedStore'
import { FeishuConfirmManager } from './feishuConfirmManager'
import { FeishuAuditLogger } from './feishuAuditLogger'
import { FeishuEventService } from './feishuEventService'
import { RemoteCommandRouter, type RemoteCommandRouterDeps } from './remoteCommandRouter'
import type { WorkDirManager } from '../workDirManager'
import { getMainWindow } from '../windowRef'
import type { AppConfig } from '../../src/shared/domainTypes'
import { mergeToolsConfig } from '../../src/shared/domainTypes'
import { readBrowserConfigFromDb } from '../browser/browserConfigDb'
import { readShellConfigFromDb } from '../shell/shellConfigDb'
import { cancelAllActiveChats } from '../chatCancelRegistry'
import { getRemoteTaskController } from '../remote/remoteTaskController'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { flushFeishuCliLogger, logFeishuCliEvent } from './feishuCliLogger'
import { authUrlHostOnly, previewText } from './feishuCliLogFields'
import { parseLarkCliError } from './larkCliErrors'
import {
  FeishuOwnerBindController,
  ownerAllowlistFromOpenId,
  readOwnerOpenIdFromAllowlist,
  type FeishuOwnerBindSnapshot
} from './feishuOwnerBind'
import type { FeishuBindWindowResult } from '../../src/shared/feishuTypes'
import {
  commitRemoteSecurityConfig,
  type CommitResult as RemoteSecurityCommitResult
} from '../remote/remoteSecurityConfigDb'
import {
  planRemoteSecurityMigration,
  type RemoteSecurityMigrationPlan,
  type RemoteSecurityPatch
} from '../../src/shared/remoteSecurityMigration'

const FEISHU_CONFIG_KEY = 'config.feishu'
const WECHAT_CONFIG_KEY = 'config.wechat'
const WORKDIR_PROFILES_KEY = 'config.workDirProfiles'
const ACTIVE_WORKDIR_KEY = 'config.activeWorkDirProfileId'

export type FeishuServiceBundle = {
  runner: LarkCliRunner
  processedStore: FeishuProcessedStore
  confirmManager: FeishuConfirmManager
  auditLogger: FeishuAuditLogger
  eventService: FeishuEventService | null
  router: RemoteCommandRouter | null
  ownerBind: FeishuOwnerBindController
}

let bundle: FeishuServiceBundle | null = null

function notifyFeishuConfigChanged(cfg: FeishuConfig): void {
  getMainWindow()?.webContents?.send('feishu:config-changed', { feishu: cfg })
}

function syncOwnerBindWithConfig(cfg: FeishuConfig, ownerBind: FeishuOwnerBindController): void {
  // A pairing code must be surfaced to the desktop; never auto-start a hidden window.
  // If remote is enabled without an owner, inbound business messages fail closed (unbound).
  if (!cfg.remoteEnabled) {
    ownerBind.dispose()
  }
}

export function readFeishuConfigFromDb(db: AppDatabase): FeishuConfig {
  const raw = getConfigValue(db, FEISHU_CONFIG_KEY)
  if (!raw) return mergeFeishuConfig(null)
  try {
    return mergeFeishuConfig(JSON.parse(raw) as Partial<FeishuConfig>)
  } catch {
    return mergeFeishuConfig(null)
  }
}

function readWorkDirProfiles(db: AppDatabase): AppConfig['workDirProfiles'] {
  const raw = getConfigValue(db, WORKDIR_PROFILES_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as AppConfig['workDirProfiles']
  } catch {
    return []
  }
}

export function createFeishuBundle(deps: {
  db: AppDatabase
  getUserDataPath: () => string
  getWorkDir: () => string
  workDirManager: WorkDirManager
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  getMaxParallel: () => number
  getToolsConfig: () => ReturnType<typeof mergeToolsConfig>
}): FeishuServiceBundle {
  const userData = deps.getUserDataPath()
  const readCfg = () => readFeishuConfigFromDb(deps.db)
  const runner = new LarkCliRunner(() => readCfg().cliPath ?? '')
  const processedStore = new FeishuProcessedStore(userData)
  const auditLogger = new FeishuAuditLogger(userData)
  const confirmManager = new FeishuConfirmManager(auditLogger, runner, deps.db)
  remoteAuthorizationRegistry.registerPendingCancel({
    cancelByChannel: (ch) => confirmManager.cancelByChannel(ch)
  })
  remoteAuthorizationRegistry.registerAuditAppender((event) => {
    void auditLogger.append(event as { type: string })
  })

  const ownerBind = new FeishuOwnerBindController({
    getOwnerOpenId: () => readOwnerOpenIdFromAllowlist(readCfg().remoteSenderAllowlist),
    setOwnerOpenId: (ownerOpenId) => {
      persistFeishuConfig(deps.db, {
        remoteSenderAllowlist: ownerAllowlistFromOpenId(ownerOpenId)
      })
    },
    setRemoteEnabled: (enabled) => {
      const next = persistFeishuConfig(deps.db, { remoteEnabled: enabled })
      notifyFeishuConfigChanged(next)
      if (!enabled) {
        // Emergency close: cancel executions / queue / pending confirms BEFORE stop listening.
        getRemoteTaskController().emergencyClose({ reason: 'emergency-close' })
        void bundle?.router?.clearPendingDisambiguation()
        void bundle?.eventService?.stop()
      }
    },
    onAudit: (event, fields) => {
      logFeishuCliEvent('info', event, fields ?? {})
      if (event === 'feishu.bind.timeout') {
        getMainWindow()?.webContents?.send('feishu:bind-timeout', {})
      }
    }
  })

  const routerDeps: RemoteCommandRouterDeps = {
    db: deps.db,
    runner,
    processedStore,
    confirmManager,
    auditLogger,
    getFeishuConfig: readCfg,
    ownerBind,
    getAppConfig: () => ({
      defaultModel: deps.getModel(),
      maxParallelChatSessions: deps.getMaxParallel(),
      workDirProfiles: readWorkDirProfiles(deps.db),
      activeWorkDirProfileId: getConfigValue(deps.db, ACTIVE_WORKDIR_KEY) ?? ''
    }),
    getWorkDir: deps.getWorkDir,
    workDirManager: deps.workDirManager,
    getUserDataPath: deps.getUserDataPath,
    getApiKey: deps.getApiKey,
    getBaseUrl: deps.getBaseUrl,
    getMainWebContents: () => getMainWindow()?.webContents ?? null,
    getModel: deps.getModel,
    getToolsConfig: deps.getToolsConfig,
    getBrowserConfig: () => readBrowserConfigFromDb(deps.db),
    getShellConfig: () => readShellConfigFromDb(deps.db)
  }

  const router = new RemoteCommandRouter(routerDeps)
  const eventService = new FeishuEventService(runner, (msg) => void router.handleInbound(msg), () => {})

  const cfg = readCfg()
  bundle = { runner, processedStore, confirmManager, auditLogger, eventService, router, ownerBind }
  syncOwnerBindWithConfig(cfg, ownerBind)
  logFeishuCliEvent('info', 'feishu.service.bundle_created', {
    hasRunner: true,
    remoteEnabled: cfg.remoteEnabled
  })
  return bundle
}

export function getFeishuBundle(): FeishuServiceBundle | null {
  return bundle
}

export async function autoStartFeishuEventIfNeeded(db: AppDatabase): Promise<void> {
  const cfg = readFeishuConfigFromDb(db)
  if (cfg.enabled && cfg.remoteEnabled && cfg.appConfigured && bundle?.eventService) {
    await bundle.eventService.start()
    logFeishuCliEvent('info', 'feishu.ipc.auto_start', { started: true })
    return
  }
  const reason = !cfg.enabled
    ? 'disabled'
    : !cfg.remoteEnabled
      ? 'remote_off'
      : !cfg.appConfigured
        ? 'not_configured'
        : !bundle?.eventService
          ? 'no_event_service'
          : 'unknown'
  logFeishuCliEvent('info', 'feishu.ipc.auto_start', { started: false, reason })
}

export async function shutdownFeishuServices(): Promise<void> {
  cancelAllActiveChats()
  remoteAuthorizationRegistry.invalidate('feishu', 'service_stopped')
  bundle?.confirmManager.cancelAllPending()
  await bundle?.eventService?.stop()
  logFeishuCliEvent('info', 'feishu.service.shutdown', {})
  await flushFeishuCliLogger()
}

export function registerFeishuIpcHandlers(
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
  }
): void {
  if (!bundle) createFeishuBundle(deps)
  const b = bundle!

  ipcMain.handle('feishu:detect-cli', async () => {
    const r = await b.runner.detect()
    logFeishuCliEvent('info', 'feishu.ipc.detect_cli', {
      installed: r.installed,
      version: r.version,
      nodeAvailable: r.nodeAvailable,
      npmAvailable: r.npmAvailable
    })
    return r
  })

  ipcMain.handle('feishu:install-cli', async () => {
    try {
      const detect = await b.runner.detect()
      if (!detect.npmAvailable) {
        return {
          success: false,
          stderr: '未检测到 npm。请先安装 Node.js（https://nodejs.org），并确保终端中可运行 npm --version。'
        }
      }
      const r = await runNpmCommand(['install', '-g', '@larksuite/cli'])
      const result = { success: r.success, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
      logFeishuCliEvent(r.success ? 'info' : 'warn', 'feishu.ipc.install_cli', {
        success: r.success,
        timedOut: r.timedOut,
        stderr: r.stderr
      })
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logFeishuCliEvent('warn', 'feishu.ipc.install_cli', { success: false, stderr: msg })
      return { success: false, stderr: msg }
    }
  })

  ipcMain.handle('feishu:install-skill', async () => {
    try {
      const r = await runNpxCommand(['-y', 'skills', 'add', 'https://open.feishu.cn', '--skill', '-y'])
      const result = { success: r.success, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
      logFeishuCliEvent(r.success ? 'info' : 'warn', 'feishu.ipc.install_skill', {
        success: r.success,
        timedOut: r.timedOut,
        stderr: r.stderr
      })
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logFeishuCliEvent('warn', 'feishu.ipc.install_skill', { success: false, stderr: msg })
      return { success: false, stderr: msg }
    }
  })

  ipcMain.handle('feishu:config-init', async () => {
    try {
      const detect = await b.runner.detect()
      if (!detect.installed) {
        return { success: false, stderr: '未检测到 lark-cli，请先点击「安装 CLI」。' }
      }
      const wc = getMainWindow()?.webContents
      let lastProgressLog = 0
      const r = await runFeishuCliWithBrowserFlow(b.runner, ['config', 'init', '--new'], {
        onProgress: (line) => {
          wc?.send('feishu:config-init-progress', { line })
          const now = Date.now()
          if (now - lastProgressLog >= 2000) {
            lastProgressLog = now
            logFeishuCliEvent('info', 'feishu.ipc.config_init.progress', {
              linePreview: previewText(line, 300)
            })
          }
        }
      })
      const result = {
        success: r.success,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        authUrl: r.authUrl
      }
      logFeishuCliEvent('info', 'feishu.ipc.config_init', {
        success: r.success,
        timedOut: r.timedOut,
        authUrlHost: authUrlHostOnly(r.authUrl)
      })
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logFeishuCliEvent('warn', 'feishu.ipc.config_init', { success: false, stderr: msg })
      return { success: false, stderr: msg }
    }
  })

  ipcMain.handle('feishu:auth-login', async () => {
    try {
      const detect = await b.runner.detect()
      if (!detect.installed) {
        return { success: false, stderr: '未检测到 lark-cli，请先点击「安装 CLI」。' }
      }
      const r = await runFeishuCliWithBrowserFlow(b.runner, ['auth', 'login', '--recommend'])
      const result = { success: r.success, authUrl: r.authUrl, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
      logFeishuCliEvent('info', 'feishu.ipc.auth_login', {
        success: r.success,
        timedOut: r.timedOut,
        browserOpened: Boolean(r.authUrl)
      })
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logFeishuCliEvent('warn', 'feishu.ipc.auth_login', { success: false, stderr: msg })
      return { success: false, stderr: msg }
    }
  })

  ipcMain.handle('feishu:auth-status', async () => {
    try {
      const detect = await b.runner.detect()
      if (!detect.installed) {
        const parsed = parseLarkCliError('不是内部或外部命令')
        logFeishuCliEvent('info', 'feishu.ipc.auth_status', { authorized: false, exitCode: 1, cliMissing: true })
        return { authorized: false, stdout: '', stderr: parsed.message, hint: parsed.hint }
      }
      const r = await b.runner.run({ args: ['auth', 'status'], timeoutSec: 30 })
      const authorized = r.exitCode === 0 && !/not logged/i.test(r.stdout + r.stderr)
      const parsed = authorized ? null : parseLarkCliError(r.stderr)
      logFeishuCliEvent('info', 'feishu.ipc.auth_status', { authorized, exitCode: r.exitCode })
      return {
        authorized,
        stdout: r.stdout,
        stderr: parsed?.message ?? r.stderr,
        hint: parsed?.hint
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logFeishuCliEvent('info', 'feishu.ipc.auth_status', { authorized: false, exitCode: 1 })
      return { authorized: false, stdout: '', stderr: msg }
    }
  })

  ipcMain.handle('feishu:event-start', async () => {
    await b.eventService?.start()
    const status = b.eventService?.getStatus()
    logFeishuCliEvent('info', 'feishu.ipc.event_start', { status })
    return status
  })

  ipcMain.handle('feishu:event-stop', async () => {
    await b.eventService?.stop()
    const status = b.eventService?.getStatus()
    logFeishuCliEvent('info', 'feishu.ipc.event_stop', { status })
    return status
  })

  ipcMain.handle('feishu:event-status', async () => b.eventService?.getStatus())

  ipcMain.handle('feishu:pending-confirms', async () => b.confirmManager.listPending())

  ipcMain.handle('feishu:cancel-confirm', async (_e, id: string) => b.confirmManager.cancel(id))

  ipcMain.handle('feishu:audit-tail', async (_e, limit?: number) => b.auditLogger.tail(limit ?? 50))

  ipcMain.handle(
    'feishu:audit-query',
    async (_e, opts: { since?: number; types?: string[]; limit?: number }) => b.auditLogger.query(opts ?? {})
  )

  ipcMain.handle('feishu:health-check', async () => {
    const cli = await b.runner.detect()
    const event = b.eventService?.getStatus() ?? { state: 'stopped' as const, processedCount: 0 }
    const pendingConfirms = b.confirmManager.countPending()
    const result = {
      cli,
      event,
      lastInboundAt: b.router?.getLastInboundAt(),
      lastReplyAt: b.router?.getLastReplyAt(),
      pendingConfirms
    }
    if (!cli.installed || event.state === 'error') {
      logFeishuCliEvent('info', 'feishu.ipc.health_check', {
        cliInstalled: cli.installed,
        eventState: event.state,
        pendingConfirms
      })
    }
    return result
  })

  ipcMain.handle('feishu:check-cli-update', async () => {
    const r = await runNpmCommand(['view', '@larksuite/cli', 'version'], { timeoutMs: 60_000 })
    const latest = r.stdout.trim() || undefined
    logFeishuCliEvent('info', 'feishu.ipc.check_cli_update', { latest })
    return { latest }
  })

  ipcMain.handle('feishu:owner-bind-status', async (): Promise<FeishuOwnerBindSnapshot> => {
    return b.ownerBind.getSnapshot()
  })

  ipcMain.handle('feishu:owner-begin-bind', async (): Promise<FeishuBindWindowResult> => {
    const cfg = readFeishuConfigFromDb(deps.db)
    const windowMs = (cfg.remoteOwnerBindWindowMinutes ?? 5) * 60_000
    await b.router?.clearPendingDisambiguation()
    const next = persistFeishuConfig(deps.db, { remoteEnabled: true })
    notifyFeishuConfigChanged(next)
    const code = b.ownerBind.startBindingWindow(windowMs)
    return { code, snapshot: b.ownerBind.getSnapshot() }
  })

  ipcMain.handle('feishu:owner-rebind', async (): Promise<FeishuBindWindowResult> => {
    const cfg = readFeishuConfigFromDb(deps.db)
    const windowMs = (cfg.remoteOwnerBindWindowMinutes ?? 5) * 60_000
    await b.router?.clearPendingDisambiguation()
    persistFeishuConfig(deps.db, { remoteEnabled: true, remoteSenderAllowlist: undefined })
    const code = b.ownerBind.startRebind(windowMs)
    const next = readFeishuConfigFromDb(deps.db)
    notifyFeishuConfigChanged(next)
    return { code, snapshot: b.ownerBind.getSnapshot() }
  })

  ipcMain.handle('feishu:owner-bind-cancel', async () => {
    await b.router?.clearPendingDisambiguation()
    b.ownerBind.cancelBinding()
    return b.ownerBind.getSnapshot()
  })

  ipcMain.handle('feishu:owner-clear', async () => {
    await b.router?.clearPendingDisambiguation()
    b.ownerBind.clearOwner()
    return b.ownerBind.getSnapshot()
  })

  ipcMain.handle('remote-security:plan', async () => {
    return buildRemoteSecurityPlanFromDb(deps.db)
  })

  ipcMain.handle(
    'remote-security:commit',
    async (_e, patch: RemoteSecurityPatch): Promise<RemoteSecurityCommitResult> => {
      const result = commitRemoteSecurityConfig(deps.db, patch)
      notifyFeishuConfigChanged(result.feishu)
      getMainWindow()?.webContents?.send('wechat:config-changed', { wechat: result.wechat })
      return result
    }
  )
}

function buildRemoteSecurityPlanFromDb(db: AppDatabase): RemoteSecurityMigrationPlan {
  const feishuRaw = getConfigValue(db, FEISHU_CONFIG_KEY)
  const wechatRaw = getConfigValue(db, WECHAT_CONFIG_KEY)
  const feishu = feishuRaw ? (safeParse(feishuRaw) as Partial<FeishuConfig>) : undefined
  const wechat = wechatRaw ? (safeParse(wechatRaw) as Record<string, unknown>) : undefined
  const isNewInstall = !feishuRaw && !wechatRaw
  return planRemoteSecurityMigration({ feishu, wechat: wechat as never, isNewInstall })
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function persistFeishuConfig(db: AppDatabase, partial: Partial<FeishuConfig>): FeishuConfig {
  const prev = readFeishuConfigFromDb(db)
  const next = mergeFeishuConfig({ ...prev, ...partial })

  // Authorization revoke linearization BEFORE persistence / async stop.
  const allowlistChanged =
    JSON.stringify(prev.remoteSenderAllowlist ?? []) !==
    JSON.stringify(next.remoteSenderAllowlist ?? [])
  const ownerCleared =
    Boolean(readOwnerOpenIdFromAllowlist(prev.remoteSenderAllowlist)) &&
    !readOwnerOpenIdFromAllowlist(next.remoteSenderAllowlist)
  if ((prev.enabled && !next.enabled) || (prev.remoteEnabled && !next.remoteEnabled)) {
    remoteAuthorizationRegistry.invalidate(
      'feishu',
      !next.enabled ? 'channel_disabled' : 'remote_disabled'
    )
  } else if (ownerCleared) {
    remoteAuthorizationRegistry.invalidate('feishu', 'owner_cleared')
  } else if (allowlistChanged) {
    remoteAuthorizationRegistry.invalidate('feishu', 'allowlist_changed')
  }

  setConfigValue(db, FEISHU_CONFIG_KEY, JSON.stringify(next))
  logFeishuCliEvent('info', 'feishu.config.persist', { keys: Object.keys(partial) })
  if (bundle?.ownerBind) {
    const wasRemote = prev.remoteEnabled
    const nowRemote = next.remoteEnabled
    // Binding windows are only opened via the explicit begin-bind / rebind IPC (code must be shown).
    if (!nowRemote && wasRemote) {
      bundle.ownerBind.dispose()
      void bundle.router?.clearPendingDisambiguation()
      void bundle.eventService?.stop()
    }
  }
  return next
}
