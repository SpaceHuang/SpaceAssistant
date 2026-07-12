import type { FeishuConfig, FeishuEventStatus, FeishuHealthCheck } from '../../../shared/feishuTypes'

export type FeishuRemoteDisplayState = 'unconfigured' | 'stopped' | 'listening' | 'error'

export type FeishuSubtextKey =
  | 'goToSettings'
  | 'connecting'
  | 'processedCount'
  | 'remoteOff'
  | 'serviceStopped'
  | 'fetchFailed'

export type FeishuStartDisabledKey = 'completeConfig' | 'enableRemote'

export interface FeishuErrorTooltipData {
  lastError?: string
  processedCount: number
  startedAt?: number
  lastInboundAt?: number
  lastReplyAt?: number
}

export interface FeishuRemoteDisplayStatus {
  displayState: FeishuRemoteDisplayState
  subtextKey?: FeishuSubtextKey
  subtextParams?: { count: number }
  tooltipData?: FeishuErrorTooltipData
  /** Raw tooltip when status fetch fails (not from event error). */
  tooltipRaw?: string
  startEnabled: boolean
  stopEnabled: boolean
  startDisabledKey?: FeishuStartDisabledKey
  eventStatus: FeishuEventStatus
  health: FeishuHealthCheck | null
}

const STOPPED_EVENT: FeishuEventStatus = { state: 'stopped', processedCount: 0 }

function isActiveRemoteEvent(event: FeishuEventStatus): boolean {
  return event.state === 'connecting' || event.state === 'connected' || event.state === 'error'
}

/** 与设置页一致：远程监听已开且服务在跑时，不因 health 未就绪误判为未配置 */
function prerequisitesMet(
  config: FeishuConfig,
  health: FeishuHealthCheck | null,
  event: FeishuEventStatus,
  liveUserAuthorized?: boolean
): boolean {
  if (!config.enabled && !config.remoteEnabled) return false
  if (config.remoteEnabled && isActiveRemoteEvent(event)) return true
  const userAuthorized = config.userAuthorized || liveUserAuthorized === true
  if (!config.appConfigured || !userAuthorized) return false
  const cliInstalled =
    health?.cli.installed === true || event.state === 'connecting' || event.state === 'connected'
  return cliInstalled
}

function resolveEvent(health: FeishuHealthCheck | null, eventOverride?: FeishuEventStatus | null): FeishuEventStatus {
  return eventOverride ?? health?.event ?? STOPPED_EVENT
}

function resolveSubtext(
  displayState: FeishuRemoteDisplayState,
  config: FeishuConfig,
  event: FeishuEventStatus
): { key?: FeishuSubtextKey; params?: { count: number } } {
  if (displayState === 'unconfigured') return { key: 'goToSettings' }
  if (displayState === 'error') return {}
  if (displayState === 'listening') {
    if (event.state === 'connecting') return { key: 'connecting' }
    if (event.state === 'connected') return { key: 'processedCount', params: { count: event.processedCount } }
    return {}
  }
  if (displayState === 'stopped') {
    if (!config.remoteEnabled) return { key: 'remoteOff' }
    return { key: 'serviceStopped' }
  }
  return {}
}

function resolveButtonState(
  displayState: FeishuRemoteDisplayState,
  config: FeishuConfig
): { startEnabled: boolean; stopEnabled: boolean; startDisabledKey?: FeishuStartDisabledKey } {
  if (displayState === 'unconfigured') {
    return { startEnabled: false, stopEnabled: false, startDisabledKey: 'completeConfig' }
  }
  if (!config.remoteEnabled) {
    return {
      startEnabled: false,
      stopEnabled: false,
      startDisabledKey: 'enableRemote'
    }
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

function buildErrorTooltipData(event: FeishuEventStatus, health: FeishuHealthCheck | null): FeishuErrorTooltipData {
  return {
    lastError: event.lastError?.trim() || undefined,
    processedCount: event.processedCount,
    startedAt: event.startedAt ?? undefined,
    lastInboundAt: health?.lastInboundAt ?? undefined,
    lastReplyAt: health?.lastReplyAt ?? undefined
  }
}

function applySubtext(
  base: FeishuRemoteDisplayStatus,
  displayState: FeishuRemoteDisplayState,
  config: FeishuConfig,
  event: FeishuEventStatus
): FeishuRemoteDisplayStatus {
  const sub = resolveSubtext(displayState, config, event)
  if (!sub.key) return base
  return {
    ...base,
    subtextKey: sub.key,
    subtextParams: sub.params
  }
}

export function resolveFeishuRemoteDisplayStatus(
  config: FeishuConfig,
  health: FeishuHealthCheck | null,
  eventOverride?: FeishuEventStatus | null,
  liveUserAuthorized?: boolean
): FeishuRemoteDisplayStatus {
  const event = resolveEvent(health, eventOverride)

  if (!prerequisitesMet(config, health, event, liveUserAuthorized)) {
    const buttons = resolveButtonState('unconfigured', config)
    return applySubtext(
      {
        displayState: 'unconfigured',
        ...buttons,
        eventStatus: event,
        health
      },
      'unconfigured',
      config,
      event
    )
  }

  if (config.remoteEnabled && event.state === 'error') {
    const buttons = resolveButtonState('error', config)
    return {
      displayState: 'error',
      tooltipData: buildErrorTooltipData(event, health),
      ...buttons,
      eventStatus: event,
      health
    }
  }

  if (!config.remoteEnabled || event.state === 'stopped') {
    const buttons = resolveButtonState('stopped', config)
    return applySubtext(
      {
        displayState: 'stopped',
        ...buttons,
        eventStatus: event,
        health
      },
      'stopped',
      config,
      event
    )
  }

  if (config.remoteEnabled && (event.state === 'connecting' || event.state === 'connected')) {
    const buttons = resolveButtonState('listening', config)
    return applySubtext(
      {
        displayState: 'listening',
        ...buttons,
        eventStatus: event,
        health
      },
      'listening',
      config,
      event
    )
  }

  const buttons = resolveButtonState('stopped', config)
  return applySubtext(
    {
      displayState: 'stopped',
      ...buttons,
      eventStatus: event,
      health
    },
    'stopped',
    config,
    event
  )
}

/** 双通道状态栏：监听中 / 连接中 / 出错时展示飞书通道 */
export function isFeishuChannelVisible(status: FeishuRemoteDisplayStatus): boolean {
  return status.displayState === 'listening' || status.displayState === 'error'
}
