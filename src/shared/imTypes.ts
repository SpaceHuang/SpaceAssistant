import type { RemoteProgressConfig } from './remoteProgressTypes'
import {
  DEFAULT_REMOTE_PROGRESS_CONFIG,
  mergeRemoteProgressConfig
} from './remoteProgressTypes'

export type ImChannel = 'feishu' | 'wechat'

/**
 * @deprecated Behavior is no longer consumed at runtime. Prefer remoteAllowLocalWrite /
 * remoteDenyOutbound and per-tool confirm switches. Field retained for stored-config compat.
 */
export type ImConfirmPolicy = 'inherit' | 'always' | 'remote_read_only' | 'im_confirm'

/** @deprecated Prefer ImConfirmPolicy; retained for compatibility with old stored values. */
export type LegacyImConfirmPolicy =
  | ImConfirmPolicy
  | 'feishu_confirm'
  | 'wechat_confirm'

export interface RemoteImCommonConfig extends RemoteProgressConfig {
  remoteEnabled: boolean
  remoteNotifyOnReceive: boolean
  /**
   * @deprecated Runtime no longer consumes this for confirm/deny decisions.
   * Old `remote_read_only` values migrate to remoteAllowLocalWrite=false + remoteDenyOutbound=true.
   */
  remoteConfirmPolicy: ImConfirmPolicy
  remoteAllowLocalWrite: boolean
  /** When true, hard-deny wechat_reply/send and Feishu lark write ops. */
  remoteDenyOutbound: boolean
  /**
   * When false and remoteContext present, browser navigate/act skip confirm.
   * Does not change desktop DEFAULT_BROWSER_CONFIG defaults.
   */
  remoteBrowserRequiresConfirm: boolean
  remoteSessionIdleMinutes: number
  remoteSessionMergeMinutes?: number
  remoteRateLimitPerMinute: number
  remoteDefaultModelId?: string
  /** Bound owner id(s); when remote is enabled, empty list rejects inbound. */
  remoteSenderAllowlist?: string[]
  /**
   * @deprecated Group chats are always rejected; field ignored when present.
   */
  remoteCommandPrefix?: string
  /** Owner bind window length in minutes (Feishu). Default 5. */
  remoteOwnerBindWindowMinutes?: number
}

export const DEFAULT_REMOTE_IM_COMMON_CONFIG: RemoteImCommonConfig = {
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'always',
  remoteAllowLocalWrite: true,
  remoteDenyOutbound: false,
  remoteBrowserRequiresConfirm: false,
  remoteSessionIdleMinutes: 10,
  remoteRateLimitPerMinute: 60,
  remoteOwnerBindWindowMinutes: 5,
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

/**
 * Apply legacy remote_read_only → explicit access-control switches.
 * While policy remains `remote_read_only`, force deny-write + deny-outbound even if
 * stored configs still carry historical defaults (`allowLocalWrite: true`).
 */
export function migrateRemoteReadOnlyPolicy(args: {
  policy: ImConfirmPolicy
  remoteAllowLocalWrite?: boolean
  remoteDenyOutbound?: boolean
  defaults: Pick<RemoteImCommonConfig, 'remoteAllowLocalWrite' | 'remoteDenyOutbound'>
}): { remoteAllowLocalWrite: boolean; remoteDenyOutbound: boolean } {
  if (args.policy === 'remote_read_only') {
    return { remoteAllowLocalWrite: false, remoteDenyOutbound: true }
  }
  return {
    remoteAllowLocalWrite: args.remoteAllowLocalWrite ?? args.defaults.remoteAllowLocalWrite,
    remoteDenyOutbound: args.remoteDenyOutbound ?? args.defaults.remoteDenyOutbound
  }
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

  const access = migrateRemoteReadOnlyPolicy({
    policy,
    remoteAllowLocalWrite: partial.remoteAllowLocalWrite,
    remoteDenyOutbound: partial.remoteDenyOutbound,
    defaults: {
      remoteAllowLocalWrite: defaults.remoteAllowLocalWrite,
      remoteDenyOutbound: defaults.remoteDenyOutbound
    }
  })

  return {
    remoteEnabled: partial.remoteEnabled ?? defaults.remoteEnabled,
    remoteNotifyOnReceive: partial.remoteNotifyOnReceive ?? defaults.remoteNotifyOnReceive,
    remoteConfirmPolicy: policy,
    remoteAllowLocalWrite: access.remoteAllowLocalWrite,
    remoteDenyOutbound: access.remoteDenyOutbound,
    remoteBrowserRequiresConfirm:
      partial.remoteBrowserRequiresConfirm ?? defaults.remoteBrowserRequiresConfirm,
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
    remoteOwnerBindWindowMinutes:
      partial.remoteOwnerBindWindowMinutes ?? defaults.remoteOwnerBindWindowMinutes,
    ...progress
  }
}

/** Convenience: one-click “restrict remote writes & outbound”. */
export function applyRemoteRestrictWritesAndOutbound(
  enabled: boolean
): Pick<RemoteImCommonConfig, 'remoteAllowLocalWrite' | 'remoteDenyOutbound'> {
  if (enabled) {
    return { remoteAllowLocalWrite: false, remoteDenyOutbound: true }
  }
  return { remoteAllowLocalWrite: true, remoteDenyOutbound: false }
}

export function isRemoteRestrictWritesAndOutbound(config: RemoteImCommonConfig): boolean {
  return config.remoteAllowLocalWrite === false && config.remoteDenyOutbound === true
}
