import { getSession } from '../database'
import { resolveWorkDirForSession } from '../workDirManager'
import { getMainWindow } from '../windowRef'
import { requestRendererSessionSwitch } from '../remote/requestRendererSessionSwitch'
import { canSwitchRemoteSession } from '../remote/remoteSessionSwitchGuard'
import { REMOTE_SESSION_SWITCH_DENIED_MESSAGE } from '../remote/remoteSessionGuardMessages'
import {
  guardToDeniedAudit,
  recordSessionSwitchDenied,
  recordSessionSwitchSuccess
} from '../remote/remoteSessionSwitchAudit'
import { beginTool, endTool } from '../remote/remoteSessionSwitchState'
import { adoptRemoteSessionAfterSwitch } from '../remote/remoteSessionSwitchFollow'
import { remoteWriteGrantRegistry } from '../remote/remoteWriteGrantRegistry'
import type { RemoteContext } from './types'
import type { ToolExecutionContext, ToolExecutor } from './types'

const REMOTE_ONLY_ERROR = '该工具仅在远程会话中可用'
const MISSING_CONTEXT_ERROR = '缺少必要的上下文信息'

export interface SwitchSessionResult {
  sessionId: string
  sessionName: string
  workDirProfileId?: string
  workDirName?: string
  workDirPath?: string
  desktopSwitched: boolean
  viewChanged: boolean
}

function sessionIdentityMatches(target: ReturnType<typeof getSession>, remoteContext: RemoteContext): boolean {
  if (!target) return false
  const meta = target.metadata as Record<string, unknown>
  if (meta?.source !== remoteContext.source) return false

  if (remoteContext.source === 'feishu') {
    const chatId = remoteContext.chatId
    if (!chatId) return false
    return (meta.feishuChatId as string | undefined) === chatId
  }

  const userId = remoteContext.userId
  const wechatMeta = meta.wechatMeta as { userId?: string } | undefined
  return wechatMeta?.userId === userId
}

function hasPendingConfirm(remoteContext: RemoteContext, sessionId: string): boolean {
  return remoteContext.confirmManager?.hasPendingForSession(sessionId) ?? false
}

export const switchSessionExecutor: ToolExecutor = {
  name: 'switch_session',
  async execute(input, ctx) {
    if (!ctx.remoteContext) {
      return { success: false, error: REMOTE_ONLY_ERROR }
    }

    const { appDatabase, workDirManager, sessionId, remoteContext, requestId } = ctx
    if (!appDatabase || !workDirManager) {
      return { success: false, error: MISSING_CONTEXT_ERROR }
    }

    const targetSessionId = typeof input.session_id === 'string' ? input.session_id.trim() : ''
    if (!targetSessionId) {
      return { success: false, error: '缺少 session_id' }
    }

    const target = getSession(appDatabase, targetSessionId)
    if (!sessionIdentityMatches(target, remoteContext)) {
      recordSessionSwitchDenied(remoteContext, {
        callerSessionId: sessionId,
        targetSessionId,
        requestId,
        reason: 'identity',
        error: REMOTE_SESSION_SWITCH_DENIED_MESSAGE
      })
      return { success: false, error: REMOTE_SESSION_SWITCH_DENIED_MESSAGE }
    }

    const guard = canSwitchRemoteSession(sessionId, targetSessionId, {
      callerRequestId: requestId,
      hasPendingConfirm: (sid) => hasPendingConfirm(remoteContext, sid)
    })
    if (!guard.allowed) {
      recordSessionSwitchDenied(remoteContext, {
        callerSessionId: sessionId,
        targetSessionId,
        requestId,
        ...guardToDeniedAudit(guard)
      })
      return { success: false, error: guard.error }
    }

    beginTool(sessionId, requestId, 'switch_session')
    try {
      const mainWindow = getMainWindow()
      const wc = mainWindow?.webContents
      if (!wc || wc.isDestroyed()) {
        const error = '桌面窗口不可用，无法切换会话'
        recordSessionSwitchDenied(remoteContext, {
          callerSessionId: sessionId,
          targetSessionId,
          requestId,
          reason: 'no_window',
          error
        })
        return { success: false, error }
      }

      let switchResult: { desktopSwitched: boolean; viewChanged: boolean }
      try {
        switchResult = await requestRendererSessionSwitch(wc, targetSessionId)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        recordSessionSwitchDenied(remoteContext, {
          callerSessionId: sessionId,
          targetSessionId,
          requestId,
          reason: 'ipc',
          error: err
        })
        return { success: false, error: err }
      }

      const resolved = resolveWorkDirForSession(
        appDatabase,
        targetSessionId,
        () => workDirManager.listProfiles(),
        () => workDirManager.getActiveProfileId(),
        () => workDirManager.getActiveWorkDir()
      )
      const profile = resolved
        ? workDirManager.listProfiles().find((p) => p.id === resolved.profileId)
        : undefined

      const data: SwitchSessionResult = {
        sessionId: targetSessionId,
        sessionName: target!.name,
        workDirProfileId: resolved?.profileId,
        workDirName: profile?.name,
        workDirPath: resolved?.workDir,
        desktopSwitched: switchResult.desktopSwitched,
        viewChanged: switchResult.viewChanged
      }

      if (!switchResult.desktopSwitched) {
        const error = '桌面会话切换未完成'
        recordSessionSwitchDenied(remoteContext, {
          callerSessionId: sessionId,
          targetSessionId,
          requestId,
          reason: 'ipc',
          error
        })
        return { success: false, error, data }
      }

      recordSessionSwitchSuccess(remoteContext, {
        callerSessionId: sessionId,
        targetSessionId,
        requestId,
        desktopSwitched: switchResult.desktopSwitched,
        viewChanged: switchResult.viewChanged,
        workDirProfileId: resolved?.profileId
      })

      adoptRemoteSessionAfterSwitch({
        remoteContext,
        appDatabase,
        targetSessionId
      })

      // switch_session never migrates the origin lease; it only redirects IM outbound. Any
      // write authorization scoped to the origin session must not survive the switch.
      const originSessionId = remoteContext.originSessionId ?? sessionId
      remoteWriteGrantRegistry.revokeByOriginSession(originSessionId, 'session_switch')

      return { success: true, data }
    } finally {
      endTool(sessionId, requestId, 'switch_session')
    }
  }
}
