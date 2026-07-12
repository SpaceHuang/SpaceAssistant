import type { WeChatConfig, WeChatConnectionStatus } from '../../../shared/wechatTypes'

export type WeChatRemoteDisplayState = 'unconfigured' | 'stopped' | 'listening' | 'error'

export type WeChatSubtextKey =
  | 'goToSettings'
  | 'connecting'
  | 'processedCount'
  | 'remoteOff'
  | 'serviceStopped'
  | 'fetchFailed'

export type WeChatStartDisabledKey = 'completeConfig' | 'enableRemote' | 'loginRequired'

export interface WeChatErrorTooltipData {
  lastError?: string
  processedCount: number
  startedAt?: number
}

export interface WeChatRemoteDisplayStatus {
  displayState: WeChatRemoteDisplayState
  subtextKey?: WeChatSubtextKey
  subtextParams?: { count: number }
  tooltipData?: WeChatErrorTooltipData
  tooltipRaw?: string
  startEnabled: boolean
  stopEnabled: boolean
  startDisabledKey?: WeChatStartDisabledKey
  connectionStatus: WeChatConnectionStatus
}

const STOPPED_STATUS: WeChatConnectionStatus = { loggedIn: false, pollState: 'stopped' }

function isActivePoll(status: WeChatConnectionStatus): boolean {
  return status.pollState === 'connecting' || status.pollState === 'polling' || status.pollState === 'error'
}

function prerequisitesMet(
  config: WeChatConfig,
  connection: WeChatConnectionStatus,
  liveLoggedIn?: boolean
): boolean {
  if (!config.enabled && !config.remoteEnabled) return false
  if (config.remoteEnabled && isActivePoll(connection)) return true
  const loggedIn = config.loggedIn || liveLoggedIn === true || connection.loggedIn
  return config.enabled && loggedIn
}

function resolveConnection(
  connectionOverride?: WeChatConnectionStatus | null,
  liveConnection?: WeChatConnectionStatus | null
): WeChatConnectionStatus {
  return connectionOverride ?? liveConnection ?? STOPPED_STATUS
}

function resolveSubtext(
  displayState: WeChatRemoteDisplayState,
  config: WeChatConfig,
  connection: WeChatConnectionStatus
): { key?: WeChatSubtextKey; params?: { count: number } } {
  if (displayState === 'unconfigured') return { key: 'goToSettings' }
  if (displayState === 'error') return {}
  if (displayState === 'listening') {
    if (connection.pollState === 'connecting') return { key: 'connecting' }
    if (connection.pollState === 'polling') {
      return { key: 'processedCount', params: { count: connection.processedCount ?? 0 } }
    }
    return {}
  }
  if (displayState === 'stopped') {
    if (!config.remoteEnabled) return { key: 'remoteOff' }
    return { key: 'serviceStopped' }
  }
  return {}
}

function resolveButtonState(
  displayState: WeChatRemoteDisplayState,
  config: WeChatConfig,
  connection: WeChatConnectionStatus,
  liveLoggedIn?: boolean
): { startEnabled: boolean; stopEnabled: boolean; startDisabledKey?: WeChatStartDisabledKey } {
  const loggedIn = config.loggedIn || liveLoggedIn === true || connection.loggedIn

  if (displayState === 'unconfigured') {
    return { startEnabled: false, stopEnabled: false, startDisabledKey: 'completeConfig' }
  }
  if (!config.remoteEnabled) {
    return { startEnabled: false, stopEnabled: false, startDisabledKey: 'enableRemote' }
  }
  if (!loggedIn) {
    return { startEnabled: false, stopEnabled: false, startDisabledKey: 'loginRequired' }
  }
  if (displayState === 'stopped') {
    return { startEnabled: true, stopEnabled: false }
  }
  if (displayState === 'listening') {
    return { startEnabled: false, stopEnabled: true }
  }
  if (displayState === 'error') {
    return { startEnabled: true, stopEnabled: true }
  }
  return { startEnabled: false, stopEnabled: false }
}

function buildErrorTooltipData(connection: WeChatConnectionStatus): WeChatErrorTooltipData {
  return {
    lastError: connection.lastError?.trim() || undefined,
    processedCount: connection.processedCount ?? 0,
    startedAt: connection.startedAt
  }
}

function applySubtext(
  base: WeChatRemoteDisplayStatus,
  displayState: WeChatRemoteDisplayState,
  config: WeChatConfig,
  connection: WeChatConnectionStatus
): WeChatRemoteDisplayStatus {
  const sub = resolveSubtext(displayState, config, connection)
  if (!sub.key) return base
  return { ...base, subtextKey: sub.key, subtextParams: sub.params }
}

export function resolveWeChatRemoteDisplayStatus(
  config: WeChatConfig,
  connectionOverride?: WeChatConnectionStatus | null,
  liveConnection?: WeChatConnectionStatus | null,
  liveLoggedIn?: boolean
): WeChatRemoteDisplayStatus {
  const connection = resolveConnection(connectionOverride, liveConnection)

  if (!prerequisitesMet(config, connection, liveLoggedIn)) {
    const buttons = resolveButtonState('unconfigured', config, connection, liveLoggedIn)
    return applySubtext(
      {
        displayState: 'unconfigured',
        ...buttons,
        connectionStatus: connection
      },
      'unconfigured',
      config,
      connection
    )
  }

  if (config.remoteEnabled && connection.pollState === 'error') {
    const buttons = resolveButtonState('error', config, connection, liveLoggedIn)
    return {
      displayState: 'error',
      tooltipData: buildErrorTooltipData(connection),
      ...buttons,
      connectionStatus: connection
    }
  }

  if (!config.remoteEnabled || connection.pollState === 'stopped' || connection.pollState === 'logged_out') {
    const buttons = resolveButtonState('stopped', config, connection, liveLoggedIn)
    return applySubtext(
      {
        displayState: 'stopped',
        ...buttons,
        connectionStatus: connection
      },
      'stopped',
      config,
      connection
    )
  }

  if (config.remoteEnabled && (connection.pollState === 'connecting' || connection.pollState === 'polling')) {
    const buttons = resolveButtonState('listening', config, connection, liveLoggedIn)
    return applySubtext(
      {
        displayState: 'listening',
        ...buttons,
        connectionStatus: connection
      },
      'listening',
      config,
      connection
    )
  }

  const buttons = resolveButtonState('stopped', config, connection, liveLoggedIn)
  return applySubtext(
    {
      displayState: 'stopped',
      ...buttons,
      connectionStatus: connection
    },
    'stopped',
    config,
    connection
  )
}

/** 双通道状态栏：监听中 / 连接中 / 出错时展示微信通道 */
export function isWeChatChannelVisible(status: WeChatRemoteDisplayStatus): boolean {
  return status.displayState === 'listening' || status.displayState === 'error'
}
