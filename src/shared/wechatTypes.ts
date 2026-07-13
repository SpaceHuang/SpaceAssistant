import type { RemoteProgressConfig } from './remoteProgressTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from './remoteProgressTypes'
import {
  mergeRemoteImCommonConfig,
  normalizeImConfirmPolicy,
  type ImConfirmPolicy,
  type LegacyImConfirmPolicy,
  type RemoteImCommonConfig
} from './imTypes'
import { normalizeWeChatConfirmPolicy } from './remoteConfirmPolicy'

export type WeChatPollState = 'stopped' | 'connecting' | 'polling' | 'logged_out' | 'error'

/** @deprecated Use ImConfirmPolicy; wechat_confirm migrates to im_confirm. */
export type WeChatRemoteConfirmPolicy = ImConfirmPolicy | 'wechat_confirm'

export type WeChatLoginProgress = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'verify_code'

export interface WeChatConfig extends RemoteImCommonConfig {
  enabled: boolean
  loggedIn: boolean
  botIdSuffix?: string
  displayName?: string
  remoteAckOnReceive: boolean
  wechatSendRequiresConfirm: boolean
  /** @deprecated 兼容旧配置；true 时等效 im_confirm */
  remoteWechatConfirm?: boolean
}

export const DEFAULT_WECHAT_CONFIG: WeChatConfig = {
  enabled: false,
  loggedIn: false,
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'always',
  remoteAllowLocalWrite: true,
  remoteSessionIdleMinutes: 10,
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

/** Phase-1 曾以 remote_read_only 为默认；现网须迁移到 im_confirm。 */
export function resolveWeChatRemoteConfirmPolicy(
  partial: Pick<Partial<WeChatConfig>, 'remoteConfirmPolicy' | 'remoteWechatConfirm'> & {
    remoteConfirmPolicy?: LegacyImConfirmPolicy
  }
): ImConfirmPolicy {
  const stored = partial.remoteConfirmPolicy

  if (partial.remoteWechatConfirm && stored !== 'remote_read_only') {
    return 'im_confirm'
  }

  if (stored === 'remote_read_only') {
    return 'im_confirm'
  }

  return (
    normalizeImConfirmPolicy(stored) ??
    (DEFAULT_WECHAT_CONFIG.remoteConfirmPolicy as ImConfirmPolicy)
  )
}

export function weChatConfigNeedsPolicyMigration(
  stored: Partial<WeChatConfig> & { remoteConfirmPolicy?: LegacyImConfirmPolicy },
  merged: WeChatConfig
): boolean {
  return (
    stored.remoteConfirmPolicy === 'remote_read_only' &&
    merged.remoteConfirmPolicy === 'im_confirm'
  )
}

export function mergeWeChatConfig(
  partial?: (Partial<WeChatConfig> & { remoteConfirmPolicy?: LegacyImConfirmPolicy }) | null
): WeChatConfig {
  if (!partial || typeof partial !== 'object') {
    return { ...DEFAULT_WECHAT_CONFIG }
  }

  const remoteConfirmPolicy = resolveWeChatRemoteConfirmPolicy(partial)
  const common = mergeRemoteImCommonConfig(
    { ...partial, remoteConfirmPolicy },
    DEFAULT_WECHAT_CONFIG
  )

  return {
    ...DEFAULT_WECHAT_CONFIG,
    ...partial,
    ...common,
    remoteConfirmPolicy,
    remoteSenderAllowlist: common.remoteSenderAllowlist,
    remoteWechatConfirm: undefined
  }
}

export function effectiveWeChatConfirmPolicy(config: WeChatConfig): ImConfirmPolicy {
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

export type { RemoteProgressConfig, ImConfirmPolicy, RemoteImCommonConfig }
