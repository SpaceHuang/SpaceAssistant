import type { RemoteProgressConfig } from './remoteProgressTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from './remoteProgressTypes'
import { normalizeWeChatConfirmPolicy } from './remoteConfirmPolicy'

export type WeChatPollState = 'stopped' | 'connecting' | 'polling' | 'logged_out' | 'error'

export type WeChatRemoteConfirmPolicy = 'inherit' | 'always' | 'remote_read_only' | 'wechat_confirm'

export type WeChatLoginProgress = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'verify_code'

export interface WeChatConfig {
  enabled: boolean
  loggedIn: boolean
  botIdSuffix?: string
  displayName?: string
  remoteEnabled: boolean
  remoteSenderAllowlist?: string[]
  remoteSessionMergeMinutes?: number
  remoteNotifyOnReceive: boolean
  remoteCommandPrefix?: string
  remoteRateLimitPerMinute: number
  remoteDefaultModelId?: string
  remoteConfirmPolicy: WeChatRemoteConfirmPolicy
  remoteAllowLocalWrite: boolean
  remoteTypingEnabled: boolean
  remoteProgressHeartbeatSec?: number
  remoteProgressMode?: RemoteProgressConfig['remoteProgressMode']
  remoteProgressMinIntervalSec?: number
  remoteProgressMaxChars?: number
  remoteProgressFallbackText?: string
  remoteAckOnReceive: boolean
  wechatSendRequiresConfirm: boolean
  /** @deprecated 兼容旧配置；true 时等效 wechat_confirm */
  remoteWechatConfirm?: boolean
}

export const DEFAULT_WECHAT_CONFIG: WeChatConfig = {
  enabled: false,
  loggedIn: false,
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'always',
  remoteAllowLocalWrite: true,
  remoteSessionMergeMinutes: 10,
  remoteRateLimitPerMinute: 10,
  remoteTypingEnabled: true,
  remoteProgressHeartbeatSec: 60,
  remoteProgressMode: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
  remoteProgressMinIntervalSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
  remoteProgressMaxChars: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
  remoteProgressFallbackText: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText,
  remoteAckOnReceive: true,
  wechatSendRequiresConfirm: true,
  remoteWechatConfirm: false
}

/** Phase-1 曾以 remote_read_only 为默认；现网须迁移到 wechat_confirm。 */
export function resolveWeChatRemoteConfirmPolicy(
  partial: Pick<Partial<WeChatConfig>, 'remoteConfirmPolicy' | 'remoteWechatConfirm'>
): WeChatRemoteConfirmPolicy {
  const stored = partial.remoteConfirmPolicy

  if (partial.remoteWechatConfirm && stored !== 'remote_read_only') {
    return 'wechat_confirm'
  }

  if (stored === 'remote_read_only') {
    return 'wechat_confirm'
  }

  return stored ?? DEFAULT_WECHAT_CONFIG.remoteConfirmPolicy
}

export function weChatConfigNeedsPolicyMigration(
  stored: Partial<WeChatConfig>,
  merged: WeChatConfig
): boolean {
  return (
    stored.remoteConfirmPolicy === 'remote_read_only' &&
    merged.remoteConfirmPolicy === 'wechat_confirm'
  )
}

export function mergeWeChatConfig(partial?: Partial<WeChatConfig> | null): WeChatConfig {
  if (!partial || typeof partial !== 'object') {
    return { ...DEFAULT_WECHAT_CONFIG }
  }

  const remoteConfirmPolicy = resolveWeChatRemoteConfirmPolicy(partial)

  return {
    ...DEFAULT_WECHAT_CONFIG,
    ...partial,
    remoteConfirmPolicy,
    remoteSenderAllowlist: Array.isArray(partial.remoteSenderAllowlist)
      ? [...partial.remoteSenderAllowlist]
      : DEFAULT_WECHAT_CONFIG.remoteSenderAllowlist,
    remoteWechatConfirm: undefined
  }
}

export function effectiveWeChatConfirmPolicy(config: WeChatConfig): WeChatRemoteConfirmPolicy {
  return normalizeWeChatConfirmPolicy(config.remoteConfirmPolicy, config.remoteWechatConfirm)
}

export interface WeChatMediaRef {
  localPath?: string
  fileName?: string
  mimeType?: string
}

export interface WeChatInboundMessage {
  messageId: string
  userId: string
  text: string
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  timestamp: string
  contextToken: string
  images?: WeChatMediaRef[]
  files?: WeChatMediaRef[]
  voices?: WeChatMediaRef[]
  videos?: WeChatMediaRef[]
  quotedMessage?: { text?: string }
}

export interface WeChatConnectionStatus {
  loggedIn: boolean
  botIdSuffix?: string
  displayName?: string
  pollState: WeChatPollState
  lastError?: string
  processedCount?: number
  startedAt?: number
}

export interface WeChatSdkDetectResult {
  available: boolean
  version?: string
  error?: string
}

export interface WeChatPollingStats {
  processedCount: number
  startedAt?: number
  lastInboundAt?: number
  averageLatencyMs?: number
}

export type WeChatAuditEvent =
  | { type: 'inbound'; messageId: string; chatId: string; senderId: string; accepted: boolean; reason?: string; ts: number }
  | { type: 'agent_start'; sessionId: string; messageId: string; ts: number }
  | { type: 'agent_done'; sessionId: string; success: boolean; summaryLen: number; ts: number }
  | { type: 'send'; sessionId?: string; targetId: string; len: number; success: boolean; ts: number }
  | { type: 'reply'; sessionId?: string; targetId: string; len: number; success: boolean; ts: number }
  | { type: 'confirm_request'; confirmId: string; decision?: string; ts: number }
  | { type: 'workdir_switch'; profileId: string; profileName: string; ts: number }
  | { type: 'rate_limit'; senderId: string; ts: number }
  | { type: 'login'; botIdSuffix?: string; ts: number }
  | { type: 'logout'; ts: number }
  | { type: 'session_expired'; ts: number }

export interface WeChatAuditQueryResult {
  events: WeChatAuditEvent[]
  total: number
}
