import { logAgentEvent } from '../agentLogger/agentLogger'
import { logFeishuCliEvent } from '../feishu/feishuCliLogger'
import { logWeChatCliEvent } from '../wechat/weChatCliLogger'
import type { SwitchBlocker } from './remoteSessionSwitchState'
import type { SwitchSessionGuardResult } from './remoteSessionSwitchGuard'
import type { RemoteContext } from '../tools/types'

export type SessionSwitchDenyReason = 'identity' | 'guard' | 'no_window' | 'ipc'

export type SessionSwitchAuditSuccess = {
  kind: 'success'
  channel: 'feishu' | 'wechat'
  callerSessionId: string
  targetSessionId: string
  requestId: string
  desktopSwitched: boolean
  viewChanged: boolean
  workDirProfileId?: string
}

export type SessionSwitchAuditDenied = {
  kind: 'denied'
  channel: 'feishu' | 'wechat'
  callerSessionId: string
  targetSessionId: string
  requestId: string
  reason: SessionSwitchDenyReason
  error: string
  code?: string
  blockers?: SwitchBlocker[]
}

export type SessionSwitchAuditEntry = SessionSwitchAuditSuccess | SessionSwitchAuditDenied

function channelOf(ctx: RemoteContext): 'feishu' | 'wechat' {
  return ctx.source
}

function logCli(entry: SessionSwitchAuditEntry): void {
  const payload = {
    callerSessionId: entry.callerSessionId,
    targetSessionId: entry.targetSessionId,
    requestId: entry.requestId,
    ...(entry.kind === 'success'
      ? {
          desktopSwitched: entry.desktopSwitched,
          viewChanged: entry.viewChanged,
          workDirProfileId: entry.workDirProfileId
        }
      : {
          reason: entry.reason,
          code: entry.code,
          blockers: entry.blockers,
          error: entry.error
        })
  }
  if (entry.channel === 'feishu') {
    logFeishuCliEvent(
      entry.kind === 'success' ? 'info' : 'warn',
      entry.kind === 'success' ? 'feishu.session.switch' : 'feishu.session.switch_denied',
      payload
    )
  } else {
    logWeChatCliEvent(
      entry.kind === 'success' ? 'info' : 'warn',
      entry.kind === 'success' ? 'wechat.session.switch' : 'wechat.session.switch_denied',
      payload
    )
  }
}

function appendAudit(remoteContext: RemoteContext, entry: SessionSwitchAuditEntry): void {
  void remoteContext.appendSessionSwitchAudit?.(entry)
}

export function recordSessionSwitchSuccess(
  remoteContext: RemoteContext,
  data: Omit<SessionSwitchAuditSuccess, 'kind' | 'channel'>
): void {
  const entry: SessionSwitchAuditSuccess = {
    kind: 'success',
    channel: channelOf(remoteContext),
    ...data
  }
  appendAudit(remoteContext, entry)
  logCli(entry)
  logAgentEvent('info', 'session_switch', {
    requestId: data.requestId,
    callerSessionId: data.callerSessionId,
    targetSessionId: data.targetSessionId,
    desktopSwitched: data.desktopSwitched,
    viewChanged: data.viewChanged
  })
}

export function recordSessionSwitchDenied(
  remoteContext: RemoteContext,
  data: Omit<SessionSwitchAuditDenied, 'kind' | 'channel'>
): void {
  const entry: SessionSwitchAuditDenied = {
    kind: 'denied',
    channel: channelOf(remoteContext),
    ...data
  }
  appendAudit(remoteContext, entry)
  logCli(entry)
  logAgentEvent('warn', 'session_switch.denied', {
    requestId: data.requestId,
    callerSessionId: data.callerSessionId,
    targetSessionId: data.targetSessionId,
    reason: data.reason,
    code: data.code,
    blockers: data.blockers,
    error: data.error
  })
}

export type SessionSwitchAuditLoggerPayload = {
  type: 'session_switch' | 'session_switch_denied'
  channel: 'feishu' | 'wechat'
  callerSessionId: string
  targetSessionId: string
  requestId: string
  desktopSwitched?: boolean
  viewChanged?: boolean
  workDirProfileId?: string
  reason?: SessionSwitchDenyReason
  code?: string
  blockers?: SwitchBlocker[]
  error?: string
}

export function auditEntryToLoggerPayload(entry: SessionSwitchAuditEntry): SessionSwitchAuditLoggerPayload {
  if (entry.kind === 'success') {
    return {
      type: 'session_switch',
      channel: entry.channel,
      callerSessionId: entry.callerSessionId,
      targetSessionId: entry.targetSessionId,
      requestId: entry.requestId,
      desktopSwitched: entry.desktopSwitched,
      viewChanged: entry.viewChanged,
      workDirProfileId: entry.workDirProfileId
    }
  }
  return {
    type: 'session_switch_denied',
    channel: entry.channel,
    callerSessionId: entry.callerSessionId,
    targetSessionId: entry.targetSessionId,
    requestId: entry.requestId,
    reason: entry.reason,
    code: entry.code,
    blockers: entry.blockers,
    error: entry.error
  }
}

export function guardToDeniedAudit(
  guard: Extract<SwitchSessionGuardResult, { allowed: false }>
): Pick<SessionSwitchAuditDenied, 'reason' | 'code' | 'blockers' | 'error'> {
  return {
    reason: 'guard',
    code: guard.code,
    blockers: guard.blockers,
    error: guard.error
  }
}
