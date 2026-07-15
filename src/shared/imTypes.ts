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

/** Provenance of the remote security preset the user last confirmed. */
export type RemoteSecurityPresetSource =
  | 'new-install'
  | 'upgrade-recommended'
  | 'upgrade-safer'
  | 'custom'

/** Per-remote-task damage budget (§2.5). Enforced before confirm/execution. */
export interface RemoteTaskBudget {
  maxToolCalls: number
  maxExecutionWallSec: number
  maxConcurrentExecutions: number
  maxConsecutiveOutboundWrites: number
}

export const DEFAULT_REMOTE_TASK_BUDGET: RemoteTaskBudget = {
  maxToolCalls: 50,
  maxExecutionWallSec: 900,
  maxConcurrentExecutions: 1,
  maxConsecutiveOutboundWrites: 10
}

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
   * @deprecated Combined browser confirm switch. Only used for conservative migration:
   * `true` maps both navigate/act to require-confirm; `false` must NOT silently make act
   * skip confirm for stock upgrades. Prefer remoteBrowserNavigate/ActRequiresConfirm.
   */
  remoteBrowserRequiresConfirm: boolean
  /**
   * Remote-only: controls whether browser `navigate` needs confirm. When missing (raw legacy),
   * treated as unmigrated — see remoteToolPolicy conservative overlay.
   */
  remoteBrowserNavigateRequiresConfirm?: boolean
  /**
   * Remote-only: controls whether browser `act` needs confirm. Default effective is `true`;
   * high-impact acts always ask regardless.
   */
  remoteBrowserActRequiresConfirm?: boolean
  /**
   * Remote-only: when analysis verdict is `allow`, whether the script still needs confirm.
   * Missing / true means confirm (conservative) until the security migration completes.
   */
  remoteScriptRequiresConfirm?: boolean
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
  /**
   * Persisted remote-security config schema version. Only advanced after the user
   * confirms the one-time security summary. Absent = raw legacy / unmigrated.
   */
  remoteSecurityConfigVersion?: number
  /** Where the last-confirmed security preset came from. */
  remoteSecurityPresetSource?: RemoteSecurityPresetSource
  /** Per-remote-task damage budget. */
  remoteTaskBudget?: RemoteTaskBudget
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

function numOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Fill a (possibly partial / missing) task budget with defaults for runtime use. */
export function resolveRemoteTaskBudget(
  budget?: Partial<RemoteTaskBudget> | null
): RemoteTaskBudget {
  if (!budget || typeof budget !== 'object') return { ...DEFAULT_REMOTE_TASK_BUDGET }
  return {
    maxToolCalls: numOrDefault(budget.maxToolCalls, DEFAULT_REMOTE_TASK_BUDGET.maxToolCalls),
    maxExecutionWallSec: numOrDefault(
      budget.maxExecutionWallSec,
      DEFAULT_REMOTE_TASK_BUDGET.maxExecutionWallSec
    ),
    maxConcurrentExecutions: numOrDefault(
      budget.maxConcurrentExecutions,
      DEFAULT_REMOTE_TASK_BUDGET.maxConcurrentExecutions
    ),
    maxConsecutiveOutboundWrites: numOrDefault(
      budget.maxConsecutiveOutboundWrites,
      DEFAULT_REMOTE_TASK_BUDGET.maxConsecutiveOutboundWrites
    )
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
    // Raw vs normalized: never fabricate a config version just because fields are missing.
    remoteSecurityConfigVersion:
      partial.remoteSecurityConfigVersion ?? defaults.remoteSecurityConfigVersion,
    remoteSecurityPresetSource:
      partial.remoteSecurityPresetSource ?? defaults.remoteSecurityPresetSource,
    remoteBrowserNavigateRequiresConfirm:
      partial.remoteBrowserNavigateRequiresConfirm ?? defaults.remoteBrowserNavigateRequiresConfirm,
    remoteBrowserActRequiresConfirm:
      partial.remoteBrowserActRequiresConfirm ?? defaults.remoteBrowserActRequiresConfirm,
    remoteScriptRequiresConfirm:
      partial.remoteScriptRequiresConfirm ?? defaults.remoteScriptRequiresConfirm,
    remoteTaskBudget: partial.remoteTaskBudget
      ? resolveRemoteTaskBudget(partial.remoteTaskBudget)
      : defaults.remoteTaskBudget,
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
