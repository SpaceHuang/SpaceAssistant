import type { RemoteProgressConfig } from './remoteProgressTypes'
import { FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG } from './remoteProgressTypes'
import {
  mergeRemoteImCommonConfig,
  normalizeImConfirmPolicy,
  type ImConfirmPolicy,
  type LegacyImConfirmPolicy,
  type RemoteImCommonConfig
} from './imTypes'

export type FeishuEventConnectionState = 'stopped' | 'connecting' | 'connected' | 'error'

/** @deprecated Use ImConfirmPolicy; feishu_confirm migrates to im_confirm. */
export type FeishuRemoteConfirmPolicy = ImConfirmPolicy | 'feishu_confirm'

export type FeishuGroupTrigger = 'mention' | 'prefix' | 'both'

export type FeishuRegion = 'feishu' | 'lark'

export type FeishuIntegrationMode = 'cli' | 'mcp' | 'both'

export interface FeishuConfig extends RemoteImCommonConfig {
  enabled: boolean
  cliPath?: string
  useBundledCli?: boolean
  appConfigured: boolean
  appIdSuffix?: string
  userAuthorized: boolean
  userDisplay?: string
  remoteGroupTrigger: FeishuGroupTrigger
  region: FeishuRegion
  wakeWords?: string[]
  wakeWordAutoExecute: boolean
  integrationMode: FeishuIntegrationMode
  larkCliDefaultTimeoutSec: number
  larkCliWriteRequiresConfirm: boolean
}

export const DEFAULT_FEISHU_CONFIG: FeishuConfig = {
  enabled: false,
  appConfigured: false,
  userAuthorized: false,
  remoteEnabled: false,
  remoteGroupTrigger: 'mention',
  remoteCommandPrefix: '/sa ',
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'always',
  remoteAllowLocalWrite: true,
  remoteSessionIdleMinutes: 10,
  region: 'feishu',
  wakeWordAutoExecute: false,
  remoteRateLimitPerMinute: 10,
  integrationMode: 'cli',
  larkCliDefaultTimeoutSec: 120,
  larkCliWriteRequiresConfirm: true,
  remoteProgressMode: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
  remoteProgressHeartbeatSec: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressHeartbeatSec,
  remoteTypingEnabled: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG.remoteTypingEnabled,
  remoteProgressMinIntervalSec: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
  remoteProgressMaxChars: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
  remoteProgressFallbackText: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText
}

export function mergeFeishuConfig(
  partial?: (Partial<FeishuConfig> & { remoteConfirmPolicy?: LegacyImConfirmPolicy }) | null
): FeishuConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_FEISHU_CONFIG }

  const common = mergeRemoteImCommonConfig(partial, DEFAULT_FEISHU_CONFIG)
  const policy =
    normalizeImConfirmPolicy(partial.remoteConfirmPolicy) ?? DEFAULT_FEISHU_CONFIG.remoteConfirmPolicy

  return {
    ...DEFAULT_FEISHU_CONFIG,
    ...partial,
    ...common,
    remoteConfirmPolicy: policy,
    integrationMode: 'cli',
    remoteSenderAllowlist: common.remoteSenderAllowlist,
    wakeWords: Array.isArray(partial.wakeWords) ? [...partial.wakeWords] : DEFAULT_FEISHU_CONFIG.wakeWords
  }
}

export interface FeishuInboundMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group' | string
  senderOpenId: string
  senderName?: string
  content: string
  rawContent?: string
  createTime: string
  mentionsBot: boolean
  msgType?: 'text' | 'post' | 'image' | string
  attachments?: FeishuInboundAttachment[]
}

export interface FeishuInboundAttachment {
  kind: 'image' | 'file'
  localPath: string
  fileName?: string
  mimeType?: string
}

export interface FeishuCliDetectResult {
  installed: boolean
  version?: string
  path?: string
  nodeAvailable: boolean
  npmAvailable: boolean
  latestNpmVersion?: string
}

export interface FeishuEventStatus {
  state: FeishuEventConnectionState
  lastError?: string
  processedCount: number
  startedAt?: number
}

export interface WorkDirProfile {
  id: string
  name: string
  path: string
  /** 飞书远程指令匹配用短名，如 SA */
  aliases?: string[]
  isDefault?: boolean
  /** 敏感项目：禁止远程访问与切换 */
  sensitive?: boolean
}

export const DEFAULT_WORK_DIR_PROFILES: WorkDirProfile[] = []

export type FeishuAuditEvent =
  | { type: 'inbound'; messageId: string; chatId: string; senderOpenId: string; accepted: boolean; reason?: string; ts: number }
  | { type: 'agent_start'; sessionId: string; messageId: string; ts: number }
  | { type: 'agent_done'; sessionId: string; success: boolean; summaryLen: number; ts: number }
  | { type: 'lark_cli'; sessionId?: string; args: string[]; success: boolean; writeOp: boolean; ts: number }
  | { type: 'confirm_request'; confirmId: string; decision?: string; ts: number }
  | { type: 'reply'; messageId: string; len: number; ts: number }
  | { type: 'workdir_switch'; profileId: string; profileName: string; ts: number }
  | { type: 'rate_limit'; senderOpenId: string; ts: number }

export interface FeishuAuditQueryResult {
  entries: FeishuAuditEvent[]
  truncated: boolean
}

export interface FeishuPendingConfirmSummary {
  id: string
  kind: 'tool_write'
  sessionId: string
  toolName?: string
  messageId: string
  chatId: string
  createdAt: number
  expiresAt: number
}

export interface FeishuHealthCheck {
  cli: FeishuCliDetectResult
  event: FeishuEventStatus
  lastInboundAt?: number
  lastReplyAt?: number
  pendingConfirms: number
}

export type { RemoteProgressConfig, ImConfirmPolicy, RemoteImCommonConfig }
