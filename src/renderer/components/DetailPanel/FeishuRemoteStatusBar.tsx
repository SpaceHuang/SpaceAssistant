import { useMemo, useState, type KeyboardEvent } from 'react'
import { Badge, Button, Tooltip } from 'antd'
import { useAppDispatch } from '../../hooks'
import { openSettings } from '../../store/configSlice'
import { FeishuAuditDrawer } from '../Config/FeishuAuditDrawer'
import { useFeishuRemoteDisplayStatus } from './useFeishuRemoteDisplayStatus'
import type { FeishuRemoteDisplayState } from './feishuRemoteDisplayStatus'
import { resolveFeishuDisplayText } from './feishuDisplayText'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

function dotClass(displayState: FeishuRemoteDisplayState, connecting: boolean): string {
  if (displayState === 'listening' && connecting) return 'feishu-remote-status-dot feishu-remote-status-dot--connecting'
  if (displayState === 'listening') return 'feishu-remote-status-dot feishu-remote-status-dot--listening'
  if (displayState === 'error') return 'feishu-remote-status-dot feishu-remote-status-dot--error'
  return 'feishu-remote-status-dot feishu-remote-status-dot--idle'
}

export function FeishuRemoteStatusBar() {
  const dispatch = useAppDispatch()
  const { t } = useTypedTranslation('feishu')
  const { status, actionLoading, start, stop } = useFeishuRemoteDisplayStatus()
  const [auditOpen, setAuditOpen] = useState(false)

  const display = useMemo(() => resolveFeishuDisplayText(status), [status])

  const connecting = status.eventStatus.state === 'connecting'
  const mainTooltip =
    status.displayState === 'error'
      ? display.tooltip
      : status.displayState === 'listening' && display.subtext
        ? t('remote.mainTooltipListening', { subtext: display.subtext })
        : undefined

  const openFeishuSettings = () => {
    dispatch(openSettings({ tab: 'feishu' }))
  }

  const handleMainKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openFeishuSettings()
    }
  }

  return (
    <>
      <div className="feishu-remote-status-bar">
        <Tooltip title={mainTooltip} styles={{ root: { maxWidth: 400 } }}>
          <div
            className="feishu-remote-status-main"
            role="button"
            tabIndex={0}
            onClick={openFeishuSettings}
            onKeyDown={handleMainKeyDown}
          >
            {connecting ? (
              <Badge status="processing" className="feishu-remote-status-badge" />
            ) : (
              <span className={dotClass(status.displayState, connecting)} aria-hidden />
            )}
            <span className="feishu-remote-status-label">
              <span className="feishu-remote-status-label-desc">{t('remote.connectionDesc')}</span>
              <span className="feishu-remote-status-label-value">{display.label}</span>
            </span>
            {display.subtext ? <span className="feishu-remote-status-sub">{display.subtext}</span> : null}
          </div>
        </Tooltip>
        <div className="feishu-remote-status-actions">
          <Button
            size="small"
            type="text"
            aria-label={t('remote.auditAria')}
            onClick={(e) => {
              e.stopPropagation()
              setAuditOpen(true)
            }}
          >
            {t('remote.auditLog')}
          </Button>
          {status.stopEnabled ? (
            <Button
              size="small"
              aria-label={t('remote.stopAria')}
              disabled={actionLoading != null}
              loading={actionLoading === 'stop'}
              onClick={(e) => {
                e.stopPropagation()
                void stop()
              }}
            >
              {t('remote.stop')}
            </Button>
          ) : (
            <Tooltip title={!status.startEnabled ? display.startDisabledReason : undefined}>
              <Button
                size="small"
                aria-label={t('remote.startAria')}
                disabled={!status.startEnabled || actionLoading != null}
                loading={actionLoading === 'start'}
                onClick={(e) => {
                  e.stopPropagation()
                  void start()
                }}
              >
                {t('remote.start')}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <FeishuAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}
