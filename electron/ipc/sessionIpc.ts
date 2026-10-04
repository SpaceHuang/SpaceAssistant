import { isThinkingEffort } from '../../src/shared/thinkingEffort'
import { THINKING_EFFORT_LEVELS } from '../../src/shared/thinkingEffort'
// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { dialog } from 'electron'
import { CONFIG_KEYS, stripSessionMetadataAndPersist, stripAllSessionsAndPersist, scheduleBackup } from './ipcShared'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { REMOTE_SESSION_BUSY_MESSAGE, REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE } from '../remote/remoteSessionGuardMessages'
import { SESSION_META_TITLE_USER_CUSTOM, scheduleSessionTitleOpenBackfillIfNeeded } from '../sessionTitleSuggest'
import { Session, SessionSkillsState } from '../../src/shared/domainTypes'
import { UsageAttributionSummary, UsageDailyPoint, UsageDimensions, UsageStatsRangeArgs, UsageSummary } from '../../src/shared/usageStatsTypes'
import { arrayMessagePageReader } from '../sessionBackupManager'
import { assertValidOptionalAnthropicBaseUrl } from '../claudeRequestGuards'
import { clearDecisionCacheOnSessionDelete } from '../confirmation/cacheMaintenanceHooks'
import { clearSessionToolResources } from '../toolChatLoop'
import { createSession, deleteSession, deleteSessionUsage, getConfigValue, getSession, getSessionUsage, setSessionUsage, updateSession } from '../database'
import { deleteSessionChatAttachmentsWithRetry } from '../chatAttachmentManager'
import { isRemoteAgentRunning } from '../remote/remoteAgentRegistry'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { normalizeSessionSkillsState } from '../../src/shared/domainTypes'
import { queryLatestUsageAttribution, queryUsageAttribution, queryUsageDaily, queryUsageDimensions, queryUsageSummary } from '../usageStats/usageStatsQueries'
import { getMainWindow } from '../windowRef'
import { addSessionDirectoryGrant, listSessionDirectoryGrants, removeSessionDirectoryGrant } from '../sessionDirectoryGrants'
import { probeReadPathFact } from '../confirmation/extractors/readPathFacts'
import os from 'node:os'
import { withSessionContextCompactionLock, registerSessionCompactionAdmissionBlocker } from '../sessionCompactionLock'
import { compactSessionContext } from '../sessionContextCompaction'
import { getApiContextBaseline, hasActiveTurn } from '../database'
import { resolveWorkDirForSession } from '../workDirManager'
import { readStoredModels } from '../llmServiceResolver'
import { resolveLlmCredentialsForModel } from '../llmServiceResolver'
import { createAnthropicClient } from '../anthropicClientFactory'
import { summarizeSessionContext } from '../sessionContextSummary'
import { resolveModelContextWindow } from '../../src/shared/llmModelConfig'
import { readAppLocale } from './ipcShared'
import { getSessionEventSink, readCompactionReplay } from '../sessionEvents'
import { currentCompactionWindowId } from '../../src/shared/compactionEvents'
import { projectReplaySurfaceWithSources, surfaceItemIdentitiesForProjectionSubset, applyCommittedSurfaceShadow, computeReplaySurfaceFingerprint } from '../../src/shared/surfaceReplay'
import { buildToolChatMessagesFromSource } from '../chatMessageBuild'
import { createSpillStore } from '../storage/spillStore'

export function registerSessionIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
  registerSessionCompactionAdmissionBlocker(ctx.getUserDataPath(), (sessionId) => Boolean(ctx.turnRuntime?.coordinator?.listActive?.(sessionId).length))
  const trustedRenderer = (event: Electron.IpcMainInvokeEvent) => {
    const window = getMainWindow()
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents)
  }
  const validSessionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
  const isDesktopSession = (session: Session) => !['feishu', 'wechat'].includes(String(session.metadata?.source ?? '').toLowerCase())
  const directoryGrantMetadataKey = 'sessionDirectoryGrants'

  ipcMain.handle('chat:get-session-compaction-markers', async (event, sessionId: unknown) => {
    if (!trustedRenderer(event) || !validSessionId(sessionId)) return []
    const session = getSession(ctx.db, sessionId)
    if (!session || !isDesktopSession(session)) return []
    const workDir = resolveWorkDirForSession(ctx.db, sessionId,
      () => ctx.workDirManager.listProfiles(), () => ctx.workDirManager.getActiveProfileId(), () => ctx.workDirManager.getActiveWorkDir())
    if (!workDir) return []
    const sink = getSessionEventSink(workDir.workDir, session.id, session.createdAt)
    const replay = await readCompactionReplay(sink.eventsPath)
    return replay.committed.flatMap(({ compactionId, start, summary, end }) => {
      const windowId = [end, summary, start].map((item) => item.payload.windowId).find((value): value is string => typeof value === 'string')
      const outputSurfaceFingerprint = end.payload.outputSurfaceFingerprint
      return windowId && typeof outputSurfaceFingerprint === 'string' ? [{ compactionId, windowId, outputSurfaceFingerprint }] : []
    })
  })

  ipcMain.handle('chat:compact-session-context', async (event, payload: unknown) => {
    if (!trustedRenderer(event) || !payload || typeof payload !== 'object') return { status: 'forbidden' as const }
    const { sessionId, requestId } = payload as { sessionId?: unknown; requestId?: unknown }
    if (!validSessionId(sessionId) || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) return { status: 'forbidden' as const }
    const session = getSession(ctx.db, sessionId)
    if (!session) return { status: 'session-not-found' as const }
    if (!isDesktopSession(session)) return { status: 'forbidden' as const }
    const locked = await withSessionContextCompactionLock(sessionId, async () => {
      const busy = () => hasActiveTurn(ctx.db, sessionId) || Boolean(ctx.turnRuntime?.coordinator.listActive(sessionId).length) || isRemoteAgentRunning(sessionId)
      if (busy()) return { status: 'busy' as const }
      const workDir = resolveWorkDirForSession(ctx.db, sessionId,
        () => ctx.workDirManager.listProfiles(), () => ctx.workDirManager.getActiveProfileId(), () => ctx.workDirManager.getActiveWorkDir())
      if (!workDir) return { status: 'failed' as const }
      const baseline = getApiContextBaseline(ctx.db, sessionId, 500)
      const initialMessages = baseline.entries.map((entry) => entry.message)
      if (initialMessages.length < 3) return { status: 'no-op' as const }
      const initialCurrentUser = [...initialMessages].reverse().find((message) => message.role === 'user')
      if (!initialCurrentUser) return { status: 'no-op' as const }
      const sink = getSessionEventSink(workDir.workDir, session.id, session.createdAt)
      const replay = await readCompactionReplay(sink.eventsPath)
      const windowId = currentCompactionWindowId(replay, `session:${sessionId}`)
      const makeSurface = async (sourceMessages: typeof initialMessages) => {
        const latestUser = [...sourceMessages].reverse().find((message) => message.role === 'user')
        if (!latestUser) return []
        const built = await buildToolChatMessagesFromSource({ userDataDir: ctx.getUserDataPath(), workDir: workDir.workDir, sourceMessages, currentUserMessageId: latestUser.id, sessionId })
        const projection = projectReplaySurfaceWithSources(built)
        const identities = surfaceItemIdentitiesForProjectionSubset(projection, projection)
        const surface = projection.messages.map((message, index) => ({ ...message, id: message.id ?? identities[index]! }))
        return applyCommittedSurfaceShadow(surface, replay, [latestUser.id], windowId, (items) => computeReplaySurfaceFingerprint('', items))
      }
      const messages = await makeSurface(initialMessages)
      const modelWindow = resolveModelContextWindow(session.model, readStoredModels(ctx.db))
      const trustedContextWindow = modelWindow.trusted ? modelWindow.contextWindow : undefined
      const totalInputBudget = Math.max(1, (trustedContextWindow ?? 100_000) - session.maxTokens)
      const latestFingerprint = async () => {
        const latest = getApiContextBaseline(ctx.db, sessionId, 500).entries.map((entry) => entry.message)
        return computeReplaySurfaceFingerprint('', await makeSurface(latest))
      }
      const result = await compactSessionContext({
        sessionId, requestId, windowId, messages, totalInputBudget,
        locale: readAppLocale(ctx.db) === 'en-US' ? 'en-US' : 'zh-CN', sink,
        summarize: async (summaryMessages, locale) => {
          const credentials = await resolveLlmCredentialsForModel(ctx.db, session.model, {
            serviceId: session.llmServiceId,
            models: readStoredModels(ctx.db)
          })
          if (credentials.error) throw new Error('SESSION_CONTEXT_SUMMARY_MODEL_UNAVAILABLE')
          const apiKey = await credentials.getApiKey()
          if (!apiKey) throw new Error('SESSION_CONTEXT_SUMMARY_CREDENTIALS_UNAVAILABLE')
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 90_000)
          try {
            return await summarizeSessionContext({
              model: session.model, apiKey, baseUrl: credentials.baseUrl, locale,
              messages: summaryMessages, signal: controller.signal
            })
          } finally {
            clearTimeout(timeout)
          }
        },
        currentFingerprint: latestFingerprint, isBusy: busy
      })
      return result.status === 'committed' ? { ...result, status: 'committed' as const } : result
    })
    return locked.status === 'busy' ? { status: 'busy' as const } : locked.value
  })


  ipcMain.handle('session-directory-grants:list', async (event, sessionId: unknown) => {
    if (!trustedRenderer(event) || !validSessionId(sessionId)) return []
    const session = getSession(ctx.db, sessionId)
    if (!session || !isDesktopSession(session)) return []
    return listSessionDirectoryGrants(session)
  })

  ipcMain.handle('session-directory-grants:add', async (event, sessionId: unknown) => {
    if (!trustedRenderer(event) || !validSessionId(sessionId)) return { status: 'forbidden' as const }
    const session = getSession(ctx.db, sessionId)
    const window = getMainWindow()
    if (!session) return { status: 'session-not-found' as const }
    if (!isDesktopSession(session) || !window) return { status: 'forbidden' as const }
    try {
      const result = await addSessionDirectoryGrant({
        session,
        selectDirectory: async () => {
          const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
          return selected.canceled ? undefined : selected.filePaths[0]
        },
        updateSession: (next) => { updateSession(ctx.db, next.id, { metadata: next.metadata }) },
        isSensitivePath: async (realPath) => {
          const facts = await probeReadPathFact({ rawPath: realPath, workDir: ctx.getWorkDir(), userDataDir: ctx.getUserDataPath(), homeDir: os.homedir(), customSensitivePrefixes: [] })
          return facts.zone === 'sensitive-file' || facts.zone === 'system-dir'
        }
      })
      return result
    } catch {
      return { status: 'error' as const }
    }
  })

  ipcMain.handle('session-directory-grants:remove', (event, payload: unknown) => {
    if (!trustedRenderer(event) || !payload || typeof payload !== 'object') return { error: 'forbidden' }
    const { sessionId, grantId } = payload as { sessionId?: unknown; grantId?: unknown }
    if (!validSessionId(sessionId) || typeof grantId !== 'string' || !grantId || grantId.length > 128) return { error: 'invalid-input' }
    const session = getSession(ctx.db, sessionId)
    if (!session || !isDesktopSession(session)) return { error: 'session-not-found' }
    return { removed: removeSessionDirectoryGrant({ session, grantId, updateSession: (next) => { updateSession(ctx.db, next.id, { metadata: next.metadata }) } }) }
  })

  ipcMain.handle('session:list', (): Session[] => {
    const profileId = ctx.workDirManager.getActiveProfileId()
    // 偏差 7：用户可见视图（排除 internal/hidden；section 分区行透传给渲染端分组）
    return stripAllSessionsAndPersist(ctx.db, { view: 'user-visible' }).filter((s) => {
      if (!s.workDirProfileId) return false
      return s.workDirProfileId === profileId
    })
  })

  ipcMain.handle(
    'session:create',
    async (
      _e,
      payload: { name: string; model?: string; llmServiceId?: string; temperature?: number; maxTokens?: number; metadata?: Record<string, unknown>; thinkingEffort?: import('../../src/shared/agent/invocation').AgentReasoningEffort }
    ): Promise<Session> => {
      // 评审 N4:非法档位拒绝(与 session:update / config:set 同口径),不做静默丢弃
      if (payload.thinkingEffort !== undefined && !isThinkingEffort(payload.thinkingEffort)) {
        throw new Error(`无效的 Thinking 强度档位:${String(payload.thinkingEffort)}(允许 ${THINKING_EFFORT_LEVELS.join(' / ')})`)
      }
      const metadata = { ...payload.metadata }
      delete metadata[directoryGrantMetadataKey]
      const s = createSession(ctx.db, {
        ...payload,
        metadata,
        workDirProfileId: ctx.workDirManager.getActiveProfileId()
      })
      await fs.mkdir(ctx.getWorkDir(), { recursive: true })
      void ctx.backup.backupWithRetry(s, arrayMessagePageReader([])).catch((error) => {
        logAgentEvent('warn', 'session.backup.create_failed', {
          sessionId: s.id,
          message: error instanceof Error ? error.message : String(error)
        })
      })
      return s
    }
  )

  ipcMain.handle('session:get', (_e, sessionId: string): Session | undefined => {
    const session = getSession(ctx.db, sessionId)
    if (!session) return undefined
    return stripSessionMetadataAndPersist(ctx.db, session)
  })

  ipcMain.handle(
    'session:backfill-auto-title-if-needed',
    async (event, payload: { sessionId: string }): Promise<Session | undefined> => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!sessionId) return undefined
      const baseUrlRaw = getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? undefined
      const baseUrl = assertValidOptionalAnthropicBaseUrl(baseUrlRaw)
      const next = scheduleSessionTitleOpenBackfillIfNeeded({
        db: ctx.db,
        onTitleGenerated: (session) => event.sender.send('session:title-generated', { session }),
        sessionId,
        baseUrl,
        getApiKey: ctx.getApiKey
      })
      if (next) scheduleBackup(ctx, next.id)
      return next
    }
  )

  ipcMain.handle(
    'session:update',
    async (
      _e,
      payload: {
        sessionId: string
        name?: string
        model?: string
        llmServiceId?: string
        temperature?: number
        maxTokens?: number
        skillsState?: SessionSkillsState
        metadata?: Record<string, unknown>
        workDirProfileId?: string
        thinkingEffort?: import('../../src/shared/agent/invocation').AgentReasoningEffort | null
      }
    ): Promise<Session | undefined> => {
      if (payload.thinkingEffort !== undefined && payload.thinkingEffort !== null
        && !isThinkingEffort(payload.thinkingEffort)) {
        throw new Error(`无效的 Thinking 强度档位:${String(payload.thinkingEffort)}(允许 ${THINKING_EFFORT_LEVELS.join(' / ')} 或 null 清除覆盖)`)
      }
      const cur = getSession(ctx.db, payload.sessionId)
      if (!cur) return undefined
      if (
        payload.workDirProfileId !== undefined &&
        payload.workDirProfileId !== cur.workDirProfileId &&
        isRemoteAgentRunning(payload.sessionId)
      ) {
        throw new Error(`${ErrorCodes.REMOTE_WORKDIR_SWITCH_BUSY}: ${REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE}`)
      }
      const mergedMetadata: Record<string, unknown> = { ...cur.metadata }
      if (payload.metadata !== undefined) {
        const rendererMetadata = { ...payload.metadata }
        delete rendererMetadata[directoryGrantMetadataKey]
        Object.assign(mergedMetadata, rendererMetadata)
      }
      const trimmedName = payload.name !== undefined ? payload.name.trim() : undefined
      const nameChanged =
        payload.name !== undefined &&
        trimmedName !== '' &&
        trimmedName !== (cur.name ?? '').trim()
      if (nameChanged) {
        mergedMetadata[SESSION_META_TITLE_USER_CUSTOM] = true
      }
      const hasMetaChange = payload.metadata !== undefined || nameChanged
      const next = updateSession(ctx.db, payload.sessionId, {
        ...(nameChanged && trimmedName !== undefined ? { name: trimmedName } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.llmServiceId !== undefined ? { llmServiceId: payload.llmServiceId } : {}),
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        ...(payload.maxTokens !== undefined ? { maxTokens: payload.maxTokens } : {}),
        ...(payload.skillsState !== undefined ? { skillsState: normalizeSessionSkillsState(payload.skillsState) } : {}),
        ...(payload.workDirProfileId !== undefined ? { workDirProfileId: payload.workDirProfileId } : {}),
        ...(payload.thinkingEffort !== undefined ? { thinkingEffort: payload.thinkingEffort } : {}),
        ...(hasMetaChange ? { metadata: mergedMetadata } : {})
      })
      if (next) scheduleBackup(ctx, next.id)
      return next
    }
  )

  ipcMain.handle('session:delete', async (_e, sessionId: string): Promise<void> => {
    const s = getSession(ctx.db, sessionId)
    if (isRemoteAgentRunning(sessionId)) {
      throw new Error(`${ErrorCodes.REMOTE_SESSION_BUSY}: ${REMOTE_SESSION_BUSY_MESSAGE}`)
    }
    clearSessionToolResources(sessionId)
    await fs.mkdir(ctx.getUserDataPath(), { recursive: true })
    await createSpillStore(`${ctx.getUserDataPath()}/spill`).withSpillRootFence(async () => {
      deleteSession(ctx.db, sessionId, { flush: false })
    })
    ctx.wakeSourceTruthSpillGc?.()
    // §5.3：会话删除时清空会话级 decision_cache 条目；清理失败不阻塞删除流程
    try {
      clearDecisionCacheOnSessionDelete(ctx.db, sessionId)
    } catch (e) {
      logAgentEvent('warn', 'confirmation.cache.session_scope_clear_failed', {
        sessionId,
        message: e instanceof Error ? e.message : String(e)
      })
    }
    void Promise.all([
      deleteSessionChatAttachmentsWithRetry(ctx.getUserDataPath(), sessionId),
      s
        ? (ctx.backup.deleteBackupWithRetry(s, 3, (error) => {
            logAgentEvent('warn', 'session.cleanup.backup_failed', {
              sessionId,
              message: error instanceof Error ? error.message : String(error)
            })
          }), Promise.resolve())
        : Promise.resolve()
    ]).catch((error) => {
      logAgentEvent('warn', 'session.cleanup_failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
  })

  ipcMain.handle(
    'usage:set',
    (_e, payload: { sessionId: string; usage: import('../../src/shared/sessionUsage').SessionUsage }): void => {
      setSessionUsage(ctx.db, payload.sessionId, payload.usage)
    }
  )

  ipcMain.handle(
    'usage:get',
    (_e, sessionId: string): import('../../src/shared/sessionUsage').SessionUsage | undefined =>
      getSessionUsage(ctx.db, sessionId)
  )

  ipcMain.handle('usage:delete', (_e, sessionId: string): void => {
    deleteSessionUsage(ctx.db, sessionId)
    ctx.db.save()
  })

  ipcMain.handle('usage-stats:daily', (_e, args: UsageStatsRangeArgs): UsageDailyPoint[] =>
    queryUsageDaily(ctx.db, args))

  ipcMain.handle('usage-stats:summary', (_e, args: UsageStatsRangeArgs): UsageSummary =>
    queryUsageSummary(ctx.db, args))

  ipcMain.handle('usage-stats:attribution', (_e, args: UsageStatsRangeArgs): UsageAttributionSummary =>
    queryUsageAttribution(ctx.db, args))

  ipcMain.handle('usage-stats:latest-attribution', (_e, sessionId: string) =>
    queryLatestUsageAttribution(ctx.db, sessionId))

  ipcMain.handle('usage-stats:dimensions', (): UsageDimensions => queryUsageDimensions(ctx.db))
}
