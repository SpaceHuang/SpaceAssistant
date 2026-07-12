export type RemoteProgressMode = 'activity_snapshot' | 'legacy_heartbeat' | 'off'

export type RemoteProgressKind = 'tool' | 'confirm' | 'text' | 'idle'

export type RemoteProgressSnapshot = {
  kind: RemoteProgressKind
  label: string
  detail?: string
  publishable: boolean
}

export type RemoteProgressConfig = {
  remoteProgressMode?: RemoteProgressMode
  remoteProgressHeartbeatSec?: number
  remoteTypingEnabled?: boolean
  remoteProgressMinIntervalSec?: number
  remoteProgressMaxChars?: number
  remoteProgressFallbackText?: string
}

export const DEFAULT_REMOTE_PROGRESS_CONFIG: Required<RemoteProgressConfig> = {
  remoteProgressMode: 'activity_snapshot',
  remoteProgressHeartbeatSec: 60,
  remoteTypingEnabled: true,
  remoteProgressMinIntervalSec: 3,
  remoteProgressMaxChars: 400,
  remoteProgressFallbackText: '仍在处理…'
}

export const FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG: Required<RemoteProgressConfig> = {
  ...DEFAULT_REMOTE_PROGRESS_CONFIG,
  remoteTypingEnabled: false,
  remoteProgressMinIntervalSec: 5
}

export function mergeRemoteProgressConfig(
  partial?: RemoteProgressConfig | null,
  defaults: Required<RemoteProgressConfig> = DEFAULT_REMOTE_PROGRESS_CONFIG
): Required<RemoteProgressConfig> {
  if (!partial || typeof partial !== 'object') return { ...defaults }
  return {
    remoteProgressMode: partial.remoteProgressMode ?? defaults.remoteProgressMode,
    remoteProgressHeartbeatSec: partial.remoteProgressHeartbeatSec ?? defaults.remoteProgressHeartbeatSec,
    remoteTypingEnabled: partial.remoteTypingEnabled ?? defaults.remoteTypingEnabled,
    remoteProgressMinIntervalSec: partial.remoteProgressMinIntervalSec ?? defaults.remoteProgressMinIntervalSec,
    remoteProgressMaxChars: partial.remoteProgressMaxChars ?? defaults.remoteProgressMaxChars,
    remoteProgressFallbackText: partial.remoteProgressFallbackText ?? defaults.remoteProgressFallbackText
  }
}

export function truncateProgressText(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`
}

export function formatRemoteProgressMessage(snapshot: RemoteProgressSnapshot, maxChars = 400): string {
  const label = snapshot.label.trim()
  const detail = snapshot.detail?.trim()
  const body = detail ? `${label}\n${detail}` : label
  return truncateProgressText(`【进度】${body}`, maxChars)
}

export function resolveHeartbeatProgressText(args: {
  current?: RemoteProgressSnapshot
  lastPublishable?: RemoteProgressSnapshot
  fallback: string
  maxChars?: number
}): { text: string; publishableUsed?: RemoteProgressSnapshot } {
  const maxChars = args.maxChars ?? 400
  if (args.current?.publishable) {
    return {
      text: formatRemoteProgressMessage(args.current, maxChars),
      publishableUsed: args.current
    }
  }
  if (args.lastPublishable) {
    return {
      text: formatRemoteProgressMessage(args.lastPublishable, maxChars),
      publishableUsed: undefined
    }
  }
  return {
    text: truncateProgressText(args.fallback, maxChars),
    publishableUsed: undefined
  }
}

export function progressReplyDedupeKey(text: string): string {
  return text.trim()
}
