export type WeChatPollState = 'stopped' | 'connecting' | 'polling' | 'logged_out' | 'error'

export type WeChatRemoteConfirmPolicy = 'inherit' | 'always' | 'remote_read_only'

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
  remoteAckOnReceive: boolean
  wechatSendRequiresConfirm: boolean
  /** Phase 2: 微信内 Y/N 确认写操作 */
  remoteWechatConfirm?: boolean
}

export const DEFAULT_WECHAT_CONFIG: WeChatConfig = {
  enabled: false,
  loggedIn: false,
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'remote_read_only',
  remoteAllowLocalWrite: false,
  remoteSessionMergeMinutes: 0,
  remoteRateLimitPerMinute: 10,
  remoteTypingEnabled: true,
  remoteProgressHeartbeatSec: 60,
  remoteAckOnReceive: true,
  wechatSendRequiresConfirm: true,
  remoteWechatConfirm: false
}

export function mergeWeChatConfig(partial?: Partial<WeChatConfig> | null): WeChatConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_WECHAT_CONFIG }
  return {
    ...DEFAULT_WECHAT_CONFIG,
    ...partial,
    remoteSenderAllowlist: Array.isArray(partial.remoteSenderAllowlist)
      ? [...partial.remoteSenderAllowlist]
      : DEFAULT_WECHAT_CONFIG.remoteSenderAllowlist
  }
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
  | { type: 'rate_limit'; senderId: string; ts: number }
  | { type: 'login'; botIdSuffix?: string; ts: number }
  | { type: 'logout'; ts: number }
  | { type: 'session_expired'; ts: number }

export interface WeChatAuditQueryResult {
  events: WeChatAuditEvent[]
  total: number
}
