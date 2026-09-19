import { isThinkingEffort } from '../../src/shared/thinkingEffort'
// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { CONFIG_KEYS, stripSessionMetadataAndPersist, stripAllSessionsAndPersist, scheduleBackup } from './ipcShared'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { REMOTE_SESSION_BUSY_MESSAGE, REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE } from '../remote/remoteSessionGuardMessages'
import { SESSION_META_TITLE_USER_CUSTOM, scheduleSessionTitleOpenBackfillIfNeeded } from '../sessionTitleSuggest'
import { Session, SessionSkillsState } from '../../src/shared/domainTypes'
import { UsageDailyPoint, UsageDimensions, UsageStatsRangeArgs, UsageSummary } from '../../src/shared/usageStatsTypes'
import { arrayMessagePageReader } from '../sessionBackupManager'
import { assertValidOptionalAnthropicBaseUrl } from '../claudeRequestGuards'
import { clearDecisionCacheOnSessionDelete } from '../confirmation/cacheMaintenanceHooks'
import { clearSessionToolResources } from '../toolChatLoop'
import { createSession, deleteSession, deleteSessionUsage, getConfigValue, getSession, getSessionUsage, setSessionUsage, updateSession } from '../database'
import { deleteSessionChatAttachmentsWithRetry } from '../chatAttachmentManager'
import { isRemoteAgentRunning } from '../remote/remoteAgentRegistry'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { normalizeSessionSkillsState } from '../../src/shared/domainTypes'
import { queryUsageDaily, queryUsageDimensions, queryUsageSummary } from '../usageStats/usageStatsQueries'

export function registerSessionIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
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
        throw new Error(`无效的 Thinking 强度档位:${String(payload.thinkingEffort)}(允许 off / low / medium / high)`)
      }
      const s = createSession(ctx.db, {
        ...payload,
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
        throw new Error(`无效的 Thinking 强度档位:${String(payload.thinkingEffort)}(允许 off / low / medium / high 或 null 清除覆盖)`)
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
        Object.assign(mergedMetadata, payload.metadata)
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
    deleteSession(ctx.db, sessionId, { flush: false })
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

  ipcMain.handle('usage-stats:dimensions', (): UsageDimensions => queryUsageDimensions(ctx.db))
}
