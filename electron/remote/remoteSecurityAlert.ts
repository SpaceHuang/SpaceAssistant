/**
 * Desktop alert cadence for remote security events (WP8).
 * Bind changes / trust adds always alert; security rejects burst at 3 within 5 minutes.
 */
import {
  noteSecurityReject,
  type RemoteSecurityAlertKind,
  type SecurityRejectAlertState
} from '../../src/shared/remoteSecurityAudit'

export type RemoteSecurityAlertPayload = {
  kind: RemoteSecurityAlertKind
  title: string
  body: string
  channel?: 'feishu' | 'wechat'
  sessionId?: string
}

export type RemoteSecurityAlertSink = (payload: RemoteSecurityAlertPayload) => void

let rejectState: SecurityRejectAlertState = { timestamps: [] }
let sink: RemoteSecurityAlertSink | null = null

export function setRemoteSecurityAlertSink(next: RemoteSecurityAlertSink | null): void {
  sink = next
}

export function resetRemoteSecurityAlertStateForTests(): void {
  rejectState = { timestamps: [] }
}

export function notifyRemoteSecurityAlert(payload: RemoteSecurityAlertPayload): void {
  sink?.(payload)
}

export function onRemoteBindChange(args: {
  channel: 'feishu' | 'wechat'
  title: string
  body: string
}): void {
  notifyRemoteSecurityAlert({ kind: 'bind_change', ...args })
}

export function onRemoteTrustAdd(args: {
  channel?: 'feishu' | 'wechat'
  title: string
  body: string
}): void {
  notifyRemoteSecurityAlert({ kind: 'trust_add', ...args })
}

/** Record a security reject; returns whether a burst alert should be shown. */
export function onRemoteSecurityReject(
  now = Date.now(),
  args?: { channel?: 'feishu' | 'wechat'; title?: string; body?: string; sessionId?: string }
): boolean {
  const r = noteSecurityReject(rejectState, now)
  rejectState = r.state
  if (r.shouldAlert) {
    notifyRemoteSecurityAlert({
      kind: 'security_reject_burst',
      channel: args?.channel,
      sessionId: args?.sessionId,
      title: args?.title ?? '远程安全拒绝频繁',
      body: args?.body ?? '5 分钟内连续 3 次安全拒绝，请检查绑定与近期活动。'
    })
  }
  return r.shouldAlert
}
