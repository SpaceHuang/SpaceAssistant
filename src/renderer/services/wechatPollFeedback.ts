import type { MessageInstance } from 'antd/es/message/interface'
import type { NamespaceKeyMap } from '../i18n/types'
import type { WeChatConnectionStatus } from '../../shared/wechatTypes'

type ConfigT = (key: NamespaceKeyMap['config'], options?: Record<string, unknown>) => string

export function isWeChatPollStartFailed(status: WeChatConnectionStatus): boolean {
  if (status.pollState === 'polling' || status.pollState === 'connecting') return false
  if (status.pollState === 'error' || status.pollState === 'logged_out') return true
  return Boolean(status.lastError?.trim())
}

export function formatWeChatPollError(status: WeChatConnectionStatus, t: ConfigT): string {
  const detail = status.lastError?.trim()
  if (detail === 'session_expired' || detail?.includes('session_expired')) {
    return t('settings.wechat.sessionExpired')
  }
  if (detail) return t('settings.wechat.listenFailedDetail', { detail })
  return t('settings.wechat.listenFailed')
}

/** @returns true when listening started successfully */
export function notifyWeChatPollResult(
  status: WeChatConnectionStatus,
  message: MessageInstance,
  t: ConfigT
): boolean {
  if (!isWeChatPollStartFailed(status)) return true
  message.error(formatWeChatPollError(status, t))
  return false
}

export function resolveWeChatPollBadgeStatus(
  status: WeChatConnectionStatus | null | undefined
): 'success' | 'processing' | 'error' | 'default' {
  if (!status) return 'default'
  if (status.pollState === 'polling') return 'success'
  if (status.pollState === 'connecting') return 'processing'
  if (status.pollState === 'error') return 'error'
  return 'default'
}

export function resolveWeChatPollStatusText(
  status: WeChatConnectionStatus | null | undefined,
  t: ConfigT
): string {
  if (!status) return t('settings.wechat.statusStopped')
  if (status.pollState === 'polling' || status.pollState === 'connecting') {
    return t('settings.wechat.statusListening')
  }
  if (status.pollState === 'error' || status.lastError) {
    return t('settings.wechat.statusError')
  }
  return t('settings.wechat.statusStopped')
}
