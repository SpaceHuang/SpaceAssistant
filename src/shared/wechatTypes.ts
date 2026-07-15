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
  /**
   * @deprecated 出站确认已移除；读取时忽略，视为 false。
   * 旧配置存在不引发异常。见 wechat-remote-outbound-confirm-removal-requirement。
   */
  wechatSendRequiresConfirm: boolean
  /** @deprecated 兼容旧配置；true 时等效 im_confirm（写工具确认语义，不再管控出站） */
  remoteWechatConfirm?: boolean
}

export const DEFAULT_WECHAT_CONFIG: WeChatConfig = {
  enabled: false,
  loggedIn: false,
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  /**
   * @deprecated Runtime no longer consumes this for confirm/deny.
   * Legacy remote_read_only migrates to remoteAllowLocalWrite=false + remoteDenyOutbound=true.
   */
  remoteConfirmPolicy: 'always',
  remoteAllowLocalWrite: true,
  remoteDenyOutbound: false,
  remoteBrowserRequiresConfirm: false,
  remoteSessionIdleMinutes: 10,
  remoteRateLimitPerMinute: 60,
  remoteTypingEnabled: true,
  remoteProgressHeartbeatSec: 60,
  remoteProgressMode: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
  remoteProgressMinIntervalSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
  remoteProgressMaxChars: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
  remoteProgressFallbackText: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText,
  remoteAckOnReceive: true,
  wechatSendRequiresConfirm: false,
  remoteWechatConfirm: false
}

/**
 * Resolve stored confirm policy for persistence compat.
 * Legacy `remote_read_only` is retained on the field (behavior migrates via access switches).
 * Legacy `remoteWechatConfirm` maps to im_confirm when not read-only.
 */
export function resolveWeChatRemoteConfirmPolicy(
  partial: Pick<Partial<WeChatConfig>, 'remoteConfirmPolicy' | 'remoteWechatConfirm'> & {
    remoteConfirmPolicy?: LegacyImConfirmPolicy
  }
): ImConfirmPolicy {
  const stored = partial.remoteConfirmPolicy

  if (stored === 'remote_read_only') {
    return 'remote_read_only'
  }

  if (partial.remoteWechatConfirm) {
    return 'im_confirm'
  }

  return (
    normalizeImConfirmPolicy(stored) ??
    (DEFAULT_WECHAT_CONFIG.remoteConfirmPolicy as ImConfirmPolicy)
  )
}

/** True when legacy remote_read_only was present and access switches were derived. */
export function weChatConfigNeedsPolicyMigration(
  stored: Partial<WeChatConfig> & { remoteConfirmPolicy?: LegacyImConfirmPolicy },
  merged: WeChatConfig
): boolean {
  return (
    stored.remoteConfirmPolicy === 'remote_read_only' &&
    merged.remoteAllowLocalWrite === false &&
    merged.remoteDenyOutbound === true
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
    remoteAllowLocalWrite: common.remoteAllowLocalWrite,
    remoteDenyOutbound: common.remoteDenyOutbound,
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
