import type { FeishuConfig, FeishuEventStatus, FeishuHealthCheck } from '../../../shared/feishuTypes'

export type FeishuRemoteDisplayState = 'unconfigured' | 'stopped' | 'listening' | 'error'

export type FeishuRemoteDisplayLabel = '未配置' | '已停止' | '监听中' | '出错'

export interface FeishuRemoteDisplayStatus {
  displayState: FeishuRemoteDisplayState
  label: FeishuRemoteDisplayLabel
  subtext?: string
  startEnabled: boolean
  stopEnabled: boolean
  tooltip?: string
  startDisabledReason?: string
  eventStatus: FeishuEventStatus
  health: FeishuHealthCheck | null
}

const STOPPED_EVENT: FeishuEventStatus = { state: 'stopped', processedCount: 0 }

function isActiveRemoteEvent(event: FeishuEventStatus): boolean {
  return event.state === 'connecting' || event.state === 'connected' || event.state === 'error'
}

/** 与设置页一致：远程监听已开且服务在跑时，不因 health 未就绪误判为未配置 */
function prerequisitesMet(config: FeishuConfig, health: FeishuHealthCheck | null, event: FeishuEventStatus): boolean {
  if (!config.enabled && !config.remoteEnabled) return false
  if (config.remoteEnabled && isActiveRemoteEvent(event)) return true
  if (!config.appConfigured || !config.userAuthorized) return false
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
): string | undefined {
  if (displayState === 'unconfigured') return '前往设置完成配置'
  if (displayState === 'error') return undefined
  if (displayState === 'listening') {
    if (event.state === 'connecting') return '正在连接…'
    if (event.state === 'connected') return `已处理 ${event.processedCount}`
    return undefined
  }
  if (displayState === 'stopped') {
    if (!config.remoteEnabled) return '远程监听已关闭'
    return '服务已停止'
  }
  return undefined
}

function resolveButtonState(
  displayState: FeishuRemoteDisplayState,
  config: FeishuConfig
): { startEnabled: boolean; stopEnabled: boolean; startDisabledReason?: string } {
  if (displayState === 'unconfigured') {
    return { startEnabled: false, stopEnabled: false, startDisabledReason: '请先完成飞书配置' }
  }
  if (!config.remoteEnabled) {
    return {
      startEnabled: false,
      stopEnabled: false,
      startDisabledReason: '请先在设置中启用远程指令监听'
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

function buildErrorTooltip(event: FeishuEventStatus, health: FeishuHealthCheck | null): string {
  const lines: string[] = [event.lastError?.trim() || '未知错误']
  lines.push(`已处理：${event.processedCount}`)
  if (event.startedAt != null) {
    lines.push(`启动时间：${new Date(event.startedAt).toLocaleString('zh-CN')}`)
  }
  if (health?.lastInboundAt != null) {
    lines.push(`最近入站：${new Date(health.lastInboundAt).toLocaleString('zh-CN')}`)
  }
  if (health?.lastReplyAt != null) {
    lines.push(`最近回复：${new Date(health.lastReplyAt).toLocaleString('zh-CN')}`)
  }
  return lines.join('\n')
}

export function resolveFeishuRemoteDisplayStatus(
  config: FeishuConfig,
  health: FeishuHealthCheck | null,
  eventOverride?: FeishuEventStatus | null
): FeishuRemoteDisplayStatus {
  const event = resolveEvent(health, eventOverride)

  if (!prerequisitesMet(config, health, event)) {
    const buttons = resolveButtonState('unconfigured', config)
    return {
      displayState: 'unconfigured',
      label: '未配置',
      subtext: resolveSubtext('unconfigured', config, event),
      ...buttons,
      eventStatus: event,
      health
    }
  }

  if (config.remoteEnabled && event.state === 'error') {
    const buttons = resolveButtonState('error', config)
    return {
      displayState: 'error',
      label: '出错',
      subtext: resolveSubtext('error', config, event),
      tooltip: buildErrorTooltip(event, health),
      ...buttons,
      eventStatus: event,
      health
    }
  }

  if (!config.remoteEnabled || event.state === 'stopped') {
    const buttons = resolveButtonState('stopped', config)
    return {
      displayState: 'stopped',
      label: '已停止',
      subtext: resolveSubtext('stopped', config, event),
      ...buttons,
      eventStatus: event,
      health
    }
  }

  if (config.remoteEnabled && (event.state === 'connecting' || event.state === 'connected')) {
    const buttons = resolveButtonState('listening', config)
    return {
      displayState: 'listening',
      label: '监听中',
      subtext: resolveSubtext('listening', config, event),
      ...buttons,
      eventStatus: event,
      health
    }
  }

  const buttons = resolveButtonState('stopped', config)
  return {
    displayState: 'stopped',
    label: '已停止',
    subtext: resolveSubtext('stopped', config, event),
    ...buttons,
    eventStatus: event,
    health
  }
}
