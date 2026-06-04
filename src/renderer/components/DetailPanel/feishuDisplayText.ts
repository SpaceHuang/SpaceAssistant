import i18n from '../../i18n'
import type { NamespaceKeyMap } from '../../i18n/types'
import type {
  FeishuErrorTooltipData,
  FeishuRemoteDisplayState,
  FeishuRemoteDisplayStatus,
  FeishuStartDisabledKey,
  FeishuSubtextKey
} from './feishuRemoteDisplayStatus'

function feishuT(key: NamespaceKeyMap['feishu'], options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'feishu', ...options })
}

export function feishuRemoteLabel(displayState: FeishuRemoteDisplayState): string {
  return feishuT(`remote.label.${displayState}` as NamespaceKeyMap['feishu'])
}

export function feishuRemoteSubtext(key: FeishuSubtextKey, params?: { count: number }): string {
  if (key === 'processedCount' && params) {
    return feishuT('remote.subtext.processedCount', { count: params.count })
  }
  return feishuT(`remote.subtext.${key}` as NamespaceKeyMap['feishu'])
}

export function feishuStartDisabledReason(key: FeishuStartDisabledKey): string {
  return feishuT(`remote.startDisabled.${key}` as NamespaceKeyMap['feishu'])
}

export function formatFeishuErrorTooltip(data: FeishuErrorTooltipData): string {
  const locale = i18n.language
  const lines: string[] = [
    data.lastError
      ? feishuT('remote.tooltip.lastError', { message: data.lastError })
      : feishuT('remote.tooltip.unknownError')
  ]
  lines.push(feishuT('remote.tooltip.processed', { count: data.processedCount }))
  if (data.startedAt != null) {
    lines.push(
      feishuT('remote.tooltip.startedAt', {
        time: new Date(data.startedAt).toLocaleString(locale)
      })
    )
  }
  if (data.lastInboundAt != null) {
    lines.push(
      feishuT('remote.tooltip.lastInbound', {
        time: new Date(data.lastInboundAt).toLocaleString(locale)
      })
    )
  }
  if (data.lastReplyAt != null) {
    lines.push(
      feishuT('remote.tooltip.lastReply', {
        time: new Date(data.lastReplyAt).toLocaleString(locale)
      })
    )
  }
  return lines.join('\n')
}

export function resolveFeishuDisplayText(status: FeishuRemoteDisplayStatus): {
  label: string
  subtext?: string
  tooltip?: string
  startDisabledReason?: string
} {
  const label = feishuRemoteLabel(status.displayState)
  const subtext = status.subtextKey
    ? feishuRemoteSubtext(status.subtextKey, status.subtextParams)
    : undefined
  const tooltip = status.tooltipRaw
    ? status.tooltipRaw
    : status.tooltipData
      ? formatFeishuErrorTooltip(status.tooltipData)
      : undefined
  const startDisabledReason = status.startDisabledKey
    ? feishuStartDisabledReason(status.startDisabledKey)
    : undefined
  return { label, subtext, tooltip, startDisabledReason }
}
