import i18n from '../../i18n'
import type { NamespaceKeyMap } from '../../i18n/types'
import type {
  WeChatErrorTooltipData,
  WeChatRemoteDisplayState,
  WeChatRemoteDisplayStatus,
  WeChatStartDisabledKey,
  WeChatSubtextKey
} from './wechatRemoteDisplayStatus'

function wechatT(key: NamespaceKeyMap['wechat'], options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'wechat', ...options })
}

export function wechatRemoteLabel(displayState: WeChatRemoteDisplayState): string {
  return wechatT(`remote.label.${displayState}` as NamespaceKeyMap['wechat'])
}

export function wechatRemoteSubtext(key: WeChatSubtextKey, params?: { count: number }): string {
  if (key === 'processedCount' && params) {
    return wechatT('remote.subtext.processedCount', { count: params.count })
  }
  return wechatT(`remote.subtext.${key}` as NamespaceKeyMap['wechat'])
}

export function wechatStartDisabledReason(key: WeChatStartDisabledKey): string {
  return wechatT(`remote.startDisabled.${key}` as NamespaceKeyMap['wechat'])
}

export function formatWeChatErrorTooltip(data: WeChatErrorTooltipData): string {
  const locale = i18n.language
  const lines: string[] = [
    data.lastError
      ? wechatT('remote.tooltip.lastError', { message: data.lastError })
      : wechatT('remote.tooltip.unknownError')
  ]
  lines.push(wechatT('remote.tooltip.processed', { count: data.processedCount }))
  if (data.startedAt != null) {
    lines.push(
      wechatT('remote.tooltip.startedAt', {
        time: new Date(data.startedAt).toLocaleString(locale)
      })
    )
  }
  return lines.join('\n')
}

export function resolveWeChatDisplayText(status: WeChatRemoteDisplayStatus): {
  label: string
  subtext?: string
  tooltip?: string
  startDisabledReason?: string
} {
  const label = wechatRemoteLabel(status.displayState)
  const subtext = status.subtextKey
    ? wechatRemoteSubtext(status.subtextKey, status.subtextParams)
    : undefined
  const tooltip = status.tooltipRaw
    ? status.tooltipRaw
    : status.tooltipData
      ? formatWeChatErrorTooltip(status.tooltipData)
      : undefined
  const startDisabledReason = status.startDisabledKey
    ? wechatStartDisabledReason(status.startDisabledKey)
    : undefined
  return { label, subtext, tooltip, startDisabledReason }
}
