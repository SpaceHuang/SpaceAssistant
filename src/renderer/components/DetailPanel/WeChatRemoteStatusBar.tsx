import { Badge, Tooltip } from 'antd'
import type { KeyboardEvent } from 'react'
import type { WeChatRemoteDisplayStatus, WeChatRemoteDisplayState } from './wechatRemoteDisplayStatus'
import { resolveWeChatDisplayText } from './wechatDisplayText'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

function dotClass(displayState: WeChatRemoteDisplayState, connecting: boolean): string {
  if (displayState === 'listening' && connecting) return 'remote-status-dot remote-status-dot--connecting'
  if (displayState === 'listening') return 'remote-status-dot remote-status-dot--listening'
  if (displayState === 'error') return 'remote-status-dot remote-status-dot--error'
  return 'remote-status-dot remote-status-dot--idle'
}

type Props = {
  status: WeChatRemoteDisplayStatus
  onOpenSettings: () => void
}

export function WeChatRemoteStatusBar({ status, onOpenSettings }: Props) {
  const { t } = useTypedTranslation('wechat')
  const display = resolveWeChatDisplayText(status)
  const connecting = status.connectionStatus.pollState === 'connecting'

  const mainTooltip =
    status.displayState === 'error'
      ? display.tooltip
      : status.displayState === 'listening' && display.subtext
        ? t('remote.mainTooltipListening', { subtext: display.subtext })
        : undefined

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpenSettings()
    }
  }

  return (
    <Tooltip title={mainTooltip} styles={{ root: { maxWidth: 400 } }}>
      <div
        className="remote-status-channel remote-status-channel--wechat"
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          onOpenSettings()
        }}
        onKeyDown={handleKeyDown}
      >
        {connecting ? (
          <Badge status="processing" className="remote-status-badge" />
        ) : (
          <span className={dotClass(status.displayState, connecting)} aria-hidden />
        )}
        <span className="remote-status-channel-label">{t('remote.channelName')}</span>
        <span className="remote-status-label-value">{display.label}</span>
        {display.subtext ? <span className="remote-status-sub">{display.subtext}</span> : null}
      </div>
    </Tooltip>
  )
}
