import type { FeishuEventConnectionState, FeishuEventStatus } from '../../../shared/feishuTypes'
import type { NamespaceKeyMap } from '../../i18n/types'

type ConfigT = (key: NamespaceKeyMap['config'], options?: Record<string, unknown>) => string

const STATE_KEYS: Record<FeishuEventConnectionState, `feishu.eventStatus.state.${FeishuEventConnectionState}`> = {
  stopped: 'feishu.eventStatus.state.stopped',
  connecting: 'feishu.eventStatus.state.connecting',
  connected: 'feishu.eventStatus.state.connected',
  error: 'feishu.eventStatus.state.error'
}

export function formatFeishuSettingsEventStatus(status: FeishuEventStatus, t: ConfigT): string {
  const stateKey = STATE_KEYS[status.state] ?? 'feishu.eventStatus.state.unknown'
  const state = t(stateKey)
  const processed = t('feishu.eventStatus.processed', { count: status.processedCount })
  return t('feishu.eventStatus.badge', { state, processed })
}
