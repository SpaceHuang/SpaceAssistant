import type { RemoteProgressConfig } from './remoteProgressTypes'
import {
  DEFAULT_REMOTE_PROGRESS_CONFIG,
  mergeRemoteProgressConfig
} from './remoteProgressTypes'

export type ImChannel = 'feishu' | 'wechat'

/** Unified storage-layer confirm policy; legacy feishu_confirm/wechat_confirm map to im_confirm. */
export type ImConfirmPolicy = 'inherit' | 'always' | 'remote_read_only' | 'im_confirm'

/** @deprecated Prefer ImConfirmPolicy; retained for compatibility with old stored values. */
export type LegacyImConfirmPolicy =
  | ImConfirmPolicy
  | 'feishu_confirm'
  | 'wechat_confirm'

export interface RemoteImCommonConfig extends RemoteProgressConfig {
  remoteEnabled: boolean
  remoteNotifyOnReceive: boolean
  remoteConfirmPolicy: ImConfirmPolicy
  remoteAllowLocalWrite: boolean
  remoteSessionIdleMinutes: number
  remoteSessionMergeMinutes?: number
  remoteRateLimitPerMinute: number
  remoteDefaultModelId?: string
  remoteSenderAllowlist?: string[]
  remoteCommandPrefix?: string
}

export const DEFAULT_REMOTE_IM_COMMON_CONFIG: RemoteImCommonConfig = {
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'always',
  remoteAllowLocalWrite: true,
  remoteSessionIdleMinutes: 10,
  remoteRateLimitPerMinute: 10,
  remoteProgressMode: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
  remoteProgressHeartbeatSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressHeartbeatSec,
  remoteTypingEnabled: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteTypingEnabled,
  remoteProgressMinIntervalSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
  remoteProgressMaxChars: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
  remoteProgressFallbackText: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText
}

export function normalizeImConfirmPolicy(
  policy: LegacyImConfirmPolicy | string | undefined | null
): ImConfirmPolicy | undefined {
  if (policy == null) return undefined
  if (policy === 'feishu_confirm' || policy === 'wechat_confirm') return 'im_confirm'
  if (
    policy === 'inherit' ||
    policy === 'always' ||
    policy === 'remote_read_only' ||
    policy === 'im_confirm'
  ) {
    return policy
  }
  return undefined
}

export function mergeRemoteImCommonConfig(
  partial?: Partial<RemoteImCommonConfig & { remoteConfirmPolicy?: LegacyImConfirmPolicy }> | null,
  defaults: RemoteImCommonConfig = DEFAULT_REMOTE_IM_COMMON_CONFIG
): RemoteImCommonConfig {
  if (!partial || typeof partial !== 'object') {
    return { ...defaults }
  }

  const progress = mergeRemoteProgressConfig(partial, {
    remoteProgressMode: defaults.remoteProgressMode ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
    remoteProgressHeartbeatSec:
      defaults.remoteProgressHeartbeatSec ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressHeartbeatSec,
    remoteTypingEnabled:
      defaults.remoteTypingEnabled ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteTypingEnabled,
    remoteProgressMinIntervalSec:
      defaults.remoteProgressMinIntervalSec ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
    remoteProgressMaxChars:
      defaults.remoteProgressMaxChars ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
    remoteProgressFallbackText:
      defaults.remoteProgressFallbackText ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText
  })

  const policy =
    normalizeImConfirmPolicy(partial.remoteConfirmPolicy) ?? defaults.remoteConfirmPolicy

  return {
    remoteEnabled: partial.remoteEnabled ?? defaults.remoteEnabled,
    remoteNotifyOnReceive: partial.remoteNotifyOnReceive ?? defaults.remoteNotifyOnReceive,
    remoteConfirmPolicy: policy,
    remoteAllowLocalWrite: partial.remoteAllowLocalWrite ?? defaults.remoteAllowLocalWrite,
    remoteSessionIdleMinutes:
      partial.remoteSessionIdleMinutes ?? defaults.remoteSessionIdleMinutes,
    remoteSessionMergeMinutes:
      partial.remoteSessionMergeMinutes ?? defaults.remoteSessionMergeMinutes,
    remoteRateLimitPerMinute:
      partial.remoteRateLimitPerMinute ?? defaults.remoteRateLimitPerMinute,
    remoteDefaultModelId: partial.remoteDefaultModelId ?? defaults.remoteDefaultModelId,
    remoteSenderAllowlist: Array.isArray(partial.remoteSenderAllowlist)
      ? [...partial.remoteSenderAllowlist]
      : defaults.remoteSenderAllowlist
        ? [...defaults.remoteSenderAllowlist]
        : undefined,
    remoteCommandPrefix: partial.remoteCommandPrefix ?? defaults.remoteCommandPrefix,
    ...progress
  }
}
