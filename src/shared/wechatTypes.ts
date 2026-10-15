import type { RemoteProgressConfig } from './remoteProgressTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from './remoteProgressTypes'
import {
  mergeRemoteImCommonConfig,
  type RemoteImCommonConfig
} from './imTypes'

export type WeChatPollState = 'stopped' | 'connecting' | 'polling' | 'logged_out' | 'error'

export type WeChatLoginProgress =
  | 'waiting'
  | 'scanned'
  | 'confirmed'
  /** Intermediate: QR expired and SDK is refreshing — keep showing current QR until next onQrUrl. */
  | 'refreshing'
  /** Final: QR flow aborted after max refreshes — user must retry. */
  | 'expired'
  /** Session credentials expired while polling — need rebind. */
  | 'session_expired'
  | 'verify_code'

export interface WeChatConfig extends RemoteImCommonConfig {
  enabled: boolean
  loggedIn: boolean
  botIdSuffix?: string
  displayName?: string
  remoteAckOnReceive: boolean
}

export const DEFAULT_WECHAT_CONFIG: WeChatConfig = {
  enabled: false,
  loggedIn: false,
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteSessionIdleMinutes: 10,
  remoteRateLimitPerMinute: 60,
  remoteTypingEnabled: true,
  remoteProgressHeartbeatSec: 60,
  remoteProgressMode: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
  remoteProgressMinIntervalSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
  remoteProgressMaxChars: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
  remoteProgressFallbackText: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText,
  remoteAckOnReceive: true,
}

export function mergeWeChatConfig(
  partial?: Partial<WeChatConfig> | null
): WeChatConfig {
  if (!partial || typeof partial !== 'object') {
    return { ...DEFAULT_WECHAT_CONFIG }
  }

  const common = mergeRemoteImCommonConfig(partial, DEFAULT_WECHAT_CONFIG)

  return {
    ...DEFAULT_WECHAT_CONFIG,
    ...channelFieldsWithoutLegacySecurity(partial, LEGACY_WECHAT_SECURITY_KEYS),
    ...common,
    remoteSenderAllowlist: common.remoteSenderAllowlist,
  }
}

const LEGACY_WECHAT_SECURITY_KEYS = [
  'remoteConfirmPolicy', 'remoteWechatConfirm', 'remoteAllowLocalWrite', 'remoteDenyOutbound',
  'remoteBrowserRequiresConfirm', 'remoteBrowserNavigateRequiresConfirm',
  'remoteBrowserActRequiresConfirm', 'remoteScriptRequiresConfirm',
  'remoteSecurityConfigVersion', 'remoteSecurityPresetSource', 'wechatSendRequiresConfirm', 'larkCliWriteRequiresConfirm'
] as const

function channelFieldsWithoutLegacySecurity<T extends object>(partial: T, keys: readonly string[]): T {
  const fields = { ...partial } as Record<string, unknown>
  for (const key of keys) delete fields[key]
  return fields as T
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
  quotedMessageId?: string
  /** Raw quoted message body from iLink ref_msg.message_item.text_item.text. */
  quotedMessageText?: string
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
  /** Bound peer / account userId used for remoteSenderAllowlist. */
  boundUserId?: string
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
  | { type: 'agent_start_rejected'; sessionId: string; messageId: string; reason: string; ts: number }
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

export type { RemoteProgressConfig, RemoteImCommonConfig }
