import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { type IpcMain } from 'electron'
import type { AppDatabase } from '../database'
import { getConfigValue, setConfigValue } from '../database'
import { getDbConnection } from '../database'
import { SqliteDecisionCache } from '../confirmation/sqliteDecisionCache'
import {
  mergeWeChatConfig,
  weChatConfigNeedsPolicyMigration,
  type WeChatConfig
} from '../../src/shared/wechatTypes'
import { WeChatProcessedStore } from './weChatProcessedStore'
import { WeChatAuditLogger } from './weChatAuditLogger'
import { WeChatImChannel } from './weChatImChannel'
import { WeChatBotService, detectWeChatSdk } from './weChatBotService'
import { WeChatCommandRouter, dispatchWeChatSdkInbound } from './weChatCommandRouter'
import type { WorkDirManager } from '../workDirManager'
import { resolveWorkDirForSession } from '../workDirManager'
import { getMainWindow } from '../windowRef'
import { mergeToolsConfig } from '../../src/shared/domainTypes'
import { readBrowserConfigFromDb } from '../browser/browserConfigDb'
import { readShellConfigFromDb } from '../shell/shellConfigDb'
import { cancelAllActiveChats } from '../chatCancelRegistry'
import { getRemoteTaskController } from '../remote/remoteTaskController'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { createRemoteAuthorizationRevocationCoordinator } from '../remote/remoteAuthorizationRevocationCoordinator'
import { createDeferredTodoCapacityController } from '../confirmation/deferredTodoCapacity'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { getSecurityAuditLog } from '../confirmation/audit'
import { createDeferredApprovalNotificationDelivery } from '../remote/deferredApprovalNotificationDelivery'
import { isRemoteAsyncApprovalGateEnabled } from '../confirmation/remoteAsyncApprovalGate'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createDeferredImBundleRuntime } from '../remote/deferredImBundleRuntime'
import { recheckDeferredTaskControl } from '../remote/deferredImDispatch'
import { executeDeferredImTool } from '../remote/imDeferredToolExecutor'
import { createImDeferredApprovalProducer, createImDeferredConfirmationAdapter } from '../remote/imDeferredApprovalProducer'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredResumeRequestStore } from '../confirmation/deferredResumeRequestStore'
import { createDeferredTodoTaskControlSafetyPort } from '../remote/deferredTodoTaskControlAdapter'
import { flushWeChatCliLogger, logWeChatCliEvent } from './weChatCliLogger'
import { isTrayEnabled } from '../tray'
import type { TurnRuntime } from '../turnRuntime'

const WECHAT_CONFIG_KEY = 'config.wechat'

function requireWeChatSentMessageId(result: unknown): { messageId: string } {
  if (typeof result === 'string' && result.trim()) return { messageId: result }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const value = result as { messageId?: unknown; message_id?: unknown; id?: unknown; data?: { message_id?: unknown } }
    const messageId = value.messageId ?? value.message_id ?? value.id ?? value.data?.message_id
    if (typeof messageId === 'string' && messageId.trim()) return { messageId }
  }
  throw new Error('WECHAT_DELIVERY_MESSAGE_ID_MISSING')
}

export type WeChatServiceBundle = {
  processedStore: WeChatProcessedStore
  imChannel: WeChatImChannel
  auditLogger: WeChatAuditLogger
  botService: WeChatBotService
  router: WeChatCommandRouter | null
  recoverDeferredApprovals(): Promise<unknown>
}

let bundle: WeChatServiceBundle | null = null
let unregisterWeChatTodoInvalidator: (() => void) | null = null
let unregisterWeChatPendingCancel: (() => void) | null = null
let unregisterWeChatCacheClearer: (() => void) | null = null

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
  sessionStorage?: import('../sessionStorage/contracts').SessionStorage
  getUserDataPath: () => string
  getWorkDir: () => string
  workDirManager: WorkDirManager
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  getMaxParallel: () => number
  getToolsConfig: () => ReturnType<typeof mergeToolsConfig>
  appVersion: string
  onReachabilityChange?: (reachable: boolean) => void
  turnRuntime?: TurnRuntime
}): WeChatServiceBundle {
  let dispatchCompletionWake: ((sessionId: string) => Promise<void>) | undefined
  const userData = deps.getUserDataPath()
  const storageDir = path.join(userData, 'wechatbot')
  const readCfg = () => readWeChatConfigFromDb(deps.db)
  const processedStore = new WeChatProcessedStore(userData)
  const auditLogger = new WeChatAuditLogger(userData)
  const deferredTodoCapacity = createDeferredTodoCapacityController(deps.db)
  const deferredTodos = createDeferredTodoStore(deps.db, { capacity: deferredTodoCapacity })
  const deferredResumeRequests = createDeferredResumeRequestStore(deps.db)
  const deferredNotificationDelivery = createDeferredApprovalNotificationDelivery({
    db: deps.db,
    todoStore: deferredTodos,
    intentStore: createSecurityActionIntentStore(deps.db),
    adapter: {
      send: async (dto, recipient) => {
        if (recipient.channel !== 'wechat') throw new Error('WECHAT_NOTIFICATION_CHANNEL_MISMATCH')
        const bot = botService.getRawBot()
        if (!bot) throw new Error('WECHAT_DELIVERY_UNAVAILABLE')
        const send = bot.send as unknown as (userId: string, text: string) => Promise<unknown>
        return requireWeChatSentMessageId(await send.call(bot, recipient.ownerId, dto.text))
      }
    },
    audit: (event) => getSecurityAuditLog().record(event)
  })
  const deferredIntentStore = createSecurityActionIntentStore(deps.db)
  const deferredProducer = createImDeferredApprovalProducer({ db: deps.db, channel: 'wechat', todoStore: deferredTodos,
    capacity: deferredTodoCapacity, intentStore: deferredIntentStore, envelopeStore: createDeferredEnvelopeStore(deps.db),
    notificationDelivery: deferredNotificationDelivery,
    isEnabled: () => isRemoteAsyncApprovalGateEnabled(deps.db) && readCfg().remoteEnabled && readCfg().loggedIn,
    getAuthorizationEpoch: () => remoteAuthorizationRegistry.getAuthorizationEpoch('wechat'),
    resolveTaskDigest: (context) => {
      if (!deps.sessionStorage || !context.currentUserMessageId || !context.originSessionId) return undefined
      return deps.sessionStorage.queries.readMessages({ sessionId: context.originSessionId }).find((message) => message.id === context.currentUserMessageId)?.content
    }
  })
  const deferredApprovalRuntime = createDeferredImBundleRuntime({
    db: deps.db, channel: 'wechat', todoStore: deferredTodos, notificationDelivery: deferredNotificationDelivery,
    isEnabled: () => isRemoteAsyncApprovalGateEnabled(deps.db) && readCfg().remoteEnabled && readCfg().loggedIn,
    getAuthorizationEpoch: () => remoteAuthorizationRegistry.getAuthorizationEpoch('wechat'),
    maxParallel: deps.getMaxParallel(),
    isOwnerAuthorized: (todo) => {
      const config = readCfg()
      return config.remoteEnabled && config.loggedIn && (config.remoteSenderAllowlist ?? []).includes(todo.ownerId)
    },
    recheckTask: (todo, envelope) => recheckDeferredTaskControl(deps.db, todo, envelope),
    dispatch: async ({ todo, envelope }) => {
      const context = envelope.executionContext
      const storage = deps.sessionStorage
      if (!storage || typeof context.confirmationReceipt !== 'string' || !context.confirmationReceipt.trim() ||
        typeof context.messageId !== 'string' || typeof context.providerRouteId !== 'string' || typeof context.model !== 'string') {
        return { dispatched: false }
      }
      const resolved = resolveWorkDirForSession(storage.queries, todo.originSessionId,
        () => deps.workDirManager.listProfiles(), () => deps.workDirManager.getActiveProfileId(), () => deps.workDirManager.getActiveWorkDir())
      if (!resolved || resolved.isSensitive || resolved.profileId !== context.workDirProfileId) return { dispatched: false }
      const config = readCfg()
      const result = await executeDeferredImTool({
        db: deps.db, sessionStorage: storage, sessionId: todo.originSessionId,
        requestId: envelope.requestId, turnId: envelope.turnId, invocationId: envelope.invocationId,
        toolCallId: envelope.toolCallId, toolName: envelope.toolName, input: envelope.canonicalArgs,
        confirmationReceipt: context.confirmationReceipt, lane: 'wechat', providerRouteId: context.providerRouteId,
        remoteContext: {
          source: 'wechat', messageId: context.messageId, confirmPolicy: config.remoteConfirmPolicy,
          userId: todo.ownerId, authOwner: todo.ownerId, originSessionId: todo.originSessionId,
          workDirProfileId: resolved.profileId, requestId: envelope.requestId,
          authorizationGeneration: remoteAuthorizationRegistry.getGeneration('wechat'),
          ...(typeof context.contextToken === 'string' ? { contextToken: context.contextToken } : {}),
          wechatConfig: config
        },
        model: context.model, toolsConfig: deps.getToolsConfig(), workDir: resolved.workDir,
        userDataDir: deps.getUserDataPath(), getApiKey: deps.getApiKey, getBaseUrl: deps.getBaseUrl,
        workDirManager: deps.workDirManager, getBrowserConfig: () => readBrowserConfigFromDb(deps.db),
        getShellConfig: () => readShellConfigFromDb(deps.db), toolChatExtras: { wechatConfig: config }
      })
      return { dispatched: result !== undefined, result }
    },
    onCompletionWake: (sessionId) => dispatchCompletionWake?.(sessionId),
    audit: (event) => getSecurityAuditLog().record(event)
  })
  const taskControlSafetyPort = createDeferredTodoTaskControlSafetyPort({ todoStore: deferredTodos,
    dispatchDeferred: async ({ sessionId }) => {
      const results = await deferredApprovalRuntime.resume.dispatchPending(sessionId)
      return { dispatched: results.length > 0 && results.every(({ status }) => status === 'dispatched') }
    } })

  const getWc = () => getMainWindow()?.webContents ?? null

  const botService = new WeChatBotService({
    storageDir,
    appVersion: deps.appVersion,
    onReachabilityChange: deps.onReachabilityChange,
    getWebContents: getWc,
    onInbound: (msg) => {
      dispatchWeChatSdkInbound(bundle?.router, msg)
    }
  })

  const imChannel = new WeChatImChannel({
    auditLogger,
    getWebContents: getWc,
    getReplyBot: () => botService.getBot() ?? undefined,
    db: deps.db,
    getGeneration: (channel) => remoteAuthorizationRegistry.getGeneration(channel)
  })
  unregisterWeChatPendingCancel?.()
  unregisterWeChatPendingCancel = remoteAuthorizationRegistry.registerPendingCancel({
    cancelByChannel: (ch) => imChannel.cancelByChannel(ch)
  }, 'wechat-im-channel')
  unregisterWeChatTodoInvalidator?.()
  unregisterWeChatTodoInvalidator = remoteAuthorizationRegistry.registerDeferredTodoInvalidator({
    invalidateByAuthorizationEpoch: (ch, epoch) => {
      if (ch !== 'wechat') return
      const result = deferredTodos.invalidateOlderAuthorizationEpochs(ch, epoch)
      if (result.dispatchingTodoIds.length) throw new Error('REMOTE_AUTHORIZATION_DISPATCHING_TODO_REQUIRES_RECONCILIATION')
    },
    invalidateResumeRequests: (ch, epoch) => {
      if (ch !== 'wechat') return
      const result = deferredResumeRequests.invalidateOlderAuthorizationEpochs(ch, epoch)
      if (result.dispatching) throw new Error('REMOTE_AUTHORIZATION_DISPATCHING_RESUME_REQUIRES_RECONCILIATION')
    },
    invalidateByOriginSession: (sessionId, ch) => {
      if (ch !== 'wechat') return
      const result = deferredTodos.invalidateByOriginSession(sessionId)
      if (result.dispatchingTodoIds.length) throw new Error('REMOTE_AUTHORIZATION_DISPATCHING_TODO_REQUIRES_RECONCILIATION')
    }
  }, 'wechat-deferred-todos')
  // B3：授权撤销/换绑/登出时联动清空本链路会话级确认记忆（remote-write 记N 等）
  unregisterWeChatCacheClearer?.()
  unregisterWeChatCacheClearer = remoteAuthorizationRegistry.registerCacheClearer({
    clearByChannel: (ch) =>
      ch === 'wechat'
        ? new SqliteDecisionCache(getDbConnection(deps.db)).clearLane('wechat', 'session')
        : 0
  }, 'wechat-decision-cache')
  remoteAuthorizationRegistry.registerAuditAppender((event) => {
    void auditLogger.append(event as { type: string })
  })

  const router = new WeChatCommandRouter({
    db: deps.db,
    sessionStorage: deps.sessionStorage,
    botService,
    processedStore,
    imChannel,
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
    getShellConfig: () => readShellConfigFromDb(deps.db),
    turnRuntime: deps.turnRuntime,
    isRemoteAsyncApprovalEnabled: () => isRemoteAsyncApprovalGateEnabled(deps.db),
    retryDeferredApprovalNotifications: ({ identityKey, ownerId }) => deferredNotificationDelivery.retryForAuthenticatedInbound({
      channel: 'wechat', identityKey, ownerId, authorizationEpoch: remoteAuthorizationRegistry.getAuthorizationEpoch('wechat')
    }),
    handleDeferredApprovalReply: ({ message, text, replyToMessageId }) => deferredApprovalRuntime.handleReply({
      channel: 'wechat', identityKey: message.userId, ownerId: message.userId, messageId: message.messageId,
      replyToMessageId, text
    }).then(() => undefined),
    createDeferredConfirmationAdapter: (remoteContext) => createImDeferredConfirmationAdapter(deferredProducer, remoteContext)
    ,taskControlSafetyPort
  })
  const wakeDispatcher = createWakeEventDispatcher({ db: deps.db, maxParallel: deps.getMaxParallel(),
    launchLoop: (input) => router.dispatchWakeEventSet(input) })
  dispatchCompletionWake = (sessionId) => wakeDispatcher.dispatchSession(sessionId).catch((error) => {
    logWeChatCliEvent('error', 'wechat.approval.completion_wake_failed', {
    sessionId, message: error instanceof Error ? error.message : String(error)
    })
  })
  // The router keeps this dependency object; wiring after construction allows the dispatcher
  // closure to reference the fully assembled router without mutable module global state.
  router.setWakeEventDispatcher(wakeDispatcher)

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

  bundle = { processedStore, imChannel, auditLogger, botService, router,
    recoverDeferredApprovals: () => deferredApprovalRuntime.recoverPending() }
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
  remoteAuthorizationRegistry.invalidate('wechat', 'service_stopped')
  bundle?.imChannel.cancelAllPending()
  await bundle?.botService?.stopPoll()
  unregisterWeChatTodoInvalidator?.()
  unregisterWeChatTodoInvalidator = null
  unregisterWeChatPendingCancel?.()
  unregisterWeChatPendingCancel = null
  unregisterWeChatCacheClearer?.()
  unregisterWeChatCacheClearer = null
  logWeChatCliEvent('info', 'wechat.service.shutdown', {})
  await flushWeChatCliLogger()
}

export function registerWeChatIpcHandlers(
  ipcMain: IpcMain,
  deps: {
    db: AppDatabase
    sessionStorage?: import('../sessionStorage/contracts').SessionStorage
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
      const allowlist = status.boundUserId ? [status.boundUserId] : undefined
      persistWeChatConfig(deps.db, {
        enabled: true,
        loggedIn: true,
        remoteEnabled: true,
        displayName: status.displayName,
        botIdSuffix: status.botIdSuffix,
        ...(allowlist ? { remoteSenderAllowlist: allowlist } : {})
      })
      const pollStatus = await b.botService.startPoll()
      logWeChatCliEvent(pollStatus.pollState === 'polling' ? 'info' : 'error', 'wechat.ipc.login_start', {
        ok: r.ok,
        pollState: pollStatus.pollState,
        lastError: pollStatus.lastError,
        hasAllowlist: Boolean(allowlist)
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
    getRemoteTaskController().emergencyClose({ reason: 'emergency-close' })
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
    const boundUserId = b.botService.getBoundUserId() ?? status.boundUserId
    const cfg = readWeChatConfigFromDb(deps.db)
    const patch: Parameters<typeof persistWeChatConfig>[1] = { remoteEnabled: true }
    if (boundUserId && !cfg.remoteSenderAllowlist?.length) {
      patch.remoteSenderAllowlist = [boundUserId]
    }
    persistWeChatConfig(deps.db, patch)
    logWeChatCliEvent(status.pollState === 'polling' ? 'info' : 'error', 'wechat.poll.start', {
      pollState: status.pollState,
      lastError: status.lastError,
      allowlistBackfilled: Boolean(boundUserId && !cfg.remoteSenderAllowlist?.length)
    })
    return status
  })

  ipcMain.handle('wechat:poll-stop', async () => {
    getRemoteTaskController().emergencyClose({ reason: 'emergency-close' })
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

  ipcMain.handle('wechat:pending-confirms', async () => b.imChannel.listPending())

  ipcMain.handle('wechat:confirm-response', async (_e, payload: { requestId: string; approved: boolean }) => {
    const ok = b.imChannel.resolveFromDesktop(payload.requestId, payload.approved)
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
        sessionQueries: deps.sessionStorage!.queries,
        sessionId: payload.sessionId
      })
    }
  )
}

export function persistWeChatConfig(db: AppDatabase, partial: Partial<WeChatConfig>): WeChatConfig {
  const prev = readWeChatConfigFromDb(db)
  const next = mergeWeChatConfig({ ...prev, ...partial })

  const allowlistChanged =
    JSON.stringify(prev.remoteSenderAllowlist ?? []) !==
    JSON.stringify(next.remoteSenderAllowlist ?? [])
  const reason = (prev.enabled && !next.enabled) || (prev.remoteEnabled && !next.remoteEnabled)
    ? (!next.enabled ? 'channel_disabled' : 'remote_disabled')
    : prev.loggedIn && !next.loggedIn ? 'logout' : allowlistChanged ? 'allowlist_changed' : null
  if (reason) {
    const coordinator = createRemoteAuthorizationRevocationCoordinator({
      writeConfig: () => { setConfigValue(db, WECHAT_CONFIG_KEY, JSON.stringify(next)); return next },
      advanceEpoch: (channel, why) => remoteAuthorizationRegistry.advanceAuthorizationEpoch(channel, why),
      cascade: (channel, epoch, why) => remoteAuthorizationRegistry.cascadeAuthorizationRevocation(channel, epoch, why),
      completeRevocation: (channel, epoch) => remoteAuthorizationRegistry.completeAuthorizationRevocation(channel, epoch),
      blockChannels: (channels, why) => remoteAuthorizationRegistry.blockChannels(channels, why),
      markChannelsReady: (channels) => remoteAuthorizationRegistry.markChannelsReady(channels)
    })
    coordinator.commit({ channels: ['wechat'], reason, config: next })
  } else setConfigValue(db, WECHAT_CONFIG_KEY, JSON.stringify(next))
  logWeChatCliEvent('info', 'wechat.config.persist', { keys: Object.keys(partial) })
  return next
}
