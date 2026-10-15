import type { RemoteProgressConfig } from './remoteProgressTypes'
import type { AgentReasoningEffort } from './agent/invocation'
import {
  DEFAULT_REMOTE_PROGRESS_CONFIG,
  mergeRemoteProgressConfig
} from './remoteProgressTypes'

export type ImChannel = 'feishu' | 'wechat'

/** Independent schema marker for the shared remote model/thinking migration. */
export const CURRENT_REMOTE_MODEL_CONFIG_VERSION = 1

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
  remoteSessionIdleMinutes: number
  remoteSessionMergeMinutes?: number
  remoteRateLimitPerMinute: number
  remoteDefaultModelId?: string
  /** Whether remote turns follow the global language default or use an explicit model. */
  remoteModelSelectionMode?: 'inherit' | 'explicit'
  /** Requested remote reasoning effort; defaults to low. */
  remoteThinkingEffort?: AgentReasoningEffort
  /** Bound owner id(s); when remote is enabled, empty list rejects inbound. */
  remoteSenderAllowlist?: string[]
  /**
   * @deprecated Group chats are always rejected; field ignored when present.
   */
  remoteCommandPrefix?: string
  /** Owner bind window length in minutes (Feishu). Default 5. */
  remoteOwnerBindWindowMinutes?: number
  /** Per-remote-task damage budget. */
  remoteTaskBudget?: RemoteTaskBudget
}

export const DEFAULT_REMOTE_IM_COMMON_CONFIG: RemoteImCommonConfig = {
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteSessionIdleMinutes: 10,
  remoteRateLimitPerMinute: 60,
  remoteModelSelectionMode: 'inherit',
  remoteThinkingEffort: 'low',
  remoteOwnerBindWindowMinutes: 5,
  remoteProgressMode: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode,
  remoteProgressHeartbeatSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressHeartbeatSec,
  remoteTypingEnabled: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteTypingEnabled,
  remoteProgressMinIntervalSec: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec,
  remoteProgressMaxChars: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMaxChars,
  remoteProgressFallbackText: DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressFallbackText
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
  partial?: Partial<RemoteImCommonConfig> | null,
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

  return {
    remoteEnabled: partial.remoteEnabled ?? defaults.remoteEnabled,
    remoteNotifyOnReceive: partial.remoteNotifyOnReceive ?? defaults.remoteNotifyOnReceive,
    remoteSessionIdleMinutes:
      partial.remoteSessionIdleMinutes ?? defaults.remoteSessionIdleMinutes,
    remoteSessionMergeMinutes:
      partial.remoteSessionMergeMinutes ?? defaults.remoteSessionMergeMinutes,
    remoteRateLimitPerMinute:
      partial.remoteRateLimitPerMinute ?? defaults.remoteRateLimitPerMinute,
    remoteDefaultModelId: partial.remoteDefaultModelId ?? defaults.remoteDefaultModelId,
    remoteModelSelectionMode: partial.remoteModelSelectionMode ?? defaults.remoteModelSelectionMode,
    remoteThinkingEffort: partial.remoteThinkingEffort ?? defaults.remoteThinkingEffort,
    remoteSenderAllowlist: Array.isArray(partial.remoteSenderAllowlist)
      ? [...partial.remoteSenderAllowlist]
      : defaults.remoteSenderAllowlist
        ? [...defaults.remoteSenderAllowlist]
        : undefined,
    remoteCommandPrefix: partial.remoteCommandPrefix ?? defaults.remoteCommandPrefix,
    remoteOwnerBindWindowMinutes:
      partial.remoteOwnerBindWindowMinutes ?? defaults.remoteOwnerBindWindowMinutes,
    remoteTaskBudget: partial.remoteTaskBudget
      ? resolveRemoteTaskBudget(partial.remoteTaskBudget)
      : defaults.remoteTaskBudget,
    ...progress
  }
}
