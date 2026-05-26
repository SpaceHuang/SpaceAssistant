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
import { getMainWindow } from '../windowRef'
import type { AppConfig } from '../../src/shared/domainTypes'
import { mergeToolsConfig } from '../../src/shared/domainTypes'

const FEISHU_CONFIG_KEY = 'config.feishu'
const WORKDIR_PROFILES_KEY = 'config.workDirProfiles'
const ACTIVE_WORKDIR_KEY = 'config.activeWorkDirProfileId'

export type FeishuServiceBundle = {
  runner: LarkCliRunner
  processedStore: FeishuProcessedStore
  confirmManager: FeishuConfirmManager
  auditLogger: FeishuAuditLogger
  eventService: FeishuEventService | null
  router: RemoteCommandRouter | null
}

let bundle: FeishuServiceBundle | null = null

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
  const confirmManager = new FeishuConfirmManager()
  const auditLogger = new FeishuAuditLogger(userData)

  const routerDeps: RemoteCommandRouterDeps = {
    db: deps.db,
    runner,
    processedStore,
    confirmManager,
    auditLogger,
    getFeishuConfig: readCfg,
    getAppConfig: () => ({
      defaultModel: deps.getModel(),
      maxParallelChatSessions: deps.getMaxParallel(),
      workDirProfiles: readWorkDirProfiles(deps.db),
      activeWorkDirProfileId: getConfigValue(deps.db, ACTIVE_WORKDIR_KEY) ?? ''
    }),
    getWorkDir: deps.getWorkDir,
    getUserDataPath: deps.getUserDataPath,
    getApiKey: deps.getApiKey,
    getBaseUrl: deps.getBaseUrl,
    getMainWebContents: () => getMainWindow()?.webContents ?? null,
    getModel: deps.getModel,
    getToolsConfig: deps.getToolsConfig
  }

  const router = new RemoteCommandRouter(routerDeps)
  const eventService = new FeishuEventService(runner, (msg) => void router.handleInbound(msg), () => {})

  bundle = { runner, processedStore, confirmManager, auditLogger, eventService, router }
  return bundle
}

export function getFeishuBundle(): FeishuServiceBundle | null {
  return bundle
}

export async function autoStartFeishuEventIfNeeded(db: AppDatabase): Promise<void> {
  const cfg = readFeishuConfigFromDb(db)
  if (cfg.enabled && cfg.remoteEnabled && cfg.appConfigured && bundle?.eventService) {
    await bundle.eventService.start()
  }
}

export function registerFeishuIpcHandlers(
  ipcMain: IpcMain,
  deps: {
    db: AppDatabase
    getUserDataPath: () => string
    getWorkDir: () => string
    getApiKey: () => Promise<string | null>
    getBaseUrl: () => string
    getModel: () => string
    getMaxParallel: () => number
    getToolsConfig: () => ReturnType<typeof mergeToolsConfig>
  }
): void {
  if (!bundle) createFeishuBundle(deps)
  const b = bundle!

  ipcMain.handle('feishu:detect-cli', async () => b.runner.detect())

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
      return { success: r.success, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, stderr: msg }
    }
  })

  ipcMain.handle('feishu:install-skill', async () => {
    try {
      const r = await runNpxCommand(['-y', 'skills', 'add', 'https://open.feishu.cn', '--skill', '-y'])
      return { success: r.success, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
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
      const r = await runFeishuCliWithBrowserFlow(b.runner, ['config', 'init', '--new'], {
        onProgress: (line) => wc?.send('feishu:config-init-progress', { line })
      })
      return {
        success: r.success,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        authUrl: r.authUrl
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
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
      return { success: r.success, authUrl: r.authUrl, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, stderr: msg }
    }
  })

  ipcMain.handle('feishu:auth-status', async () => {
    try {
      const r = await b.runner.run({ args: ['auth', 'status'], timeoutSec: 30 })
      return {
        authorized: r.exitCode === 0 && !/not logged/i.test(r.stdout + r.stderr),
        stdout: r.stdout,
        stderr: r.stderr
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { authorized: false, stdout: '', stderr: msg }
    }
  })

  ipcMain.handle('feishu:event-start', async () => {
    await b.eventService?.start()
    return b.eventService?.getStatus()
  })

  ipcMain.handle('feishu:event-stop', async () => {
    await b.eventService?.stop()
    return b.eventService?.getStatus()
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
    return {
      cli,
      event,
      lastInboundAt: b.router?.getLastInboundAt(),
      lastReplyAt: b.router?.getLastReplyAt(),
      pendingConfirms: b.confirmManager.countPending(),
      pendingPlans: b.confirmManager.listPending().filter((p) => p.kind === 'plan_execute').length
    }
  })

  ipcMain.handle('feishu:check-cli-update', async () => {
    const r = await runNpmCommand(['view', '@larksuite/cli', 'version'], { timeoutMs: 60_000 })
    return { latest: r.stdout.trim() || undefined }
  })
}

export function persistFeishuConfig(db: AppDatabase, partial: Partial<FeishuConfig>): FeishuConfig {
  const next = mergeFeishuConfig({ ...readFeishuConfigFromDb(db), ...partial })
  setConfigValue(db, FEISHU_CONFIG_KEY, JSON.stringify(next))
  return next
}
