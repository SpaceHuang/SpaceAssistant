import { useMemo, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { openSettings } from '../../store/configSlice'
import { FeishuRemoteStatusBar } from './FeishuRemoteStatusBar'
import { WeChatRemoteStatusBar } from './WeChatRemoteStatusBar'
import { RemoteAuditDrawer, type RemoteAuditChannel } from './RemoteAuditDrawer'
import { useFeishuRemoteDisplayStatus } from './useFeishuRemoteDisplayStatus'
import { useWeChatRemoteDisplayStatus } from './useWeChatRemoteDisplayStatus'
import { isFeishuChannelVisible } from './feishuRemoteDisplayStatus'
import { isWeChatChannelVisible } from './wechatRemoteDisplayStatus'
import { resolveFeishuDisplayText } from './feishuDisplayText'
import { resolveWeChatDisplayText } from './wechatDisplayText'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export function RemoteStatusBar() {
  const dispatch = useAppDispatch()
  const appConfig = useTypedSelector((s) => s.config.config)
  const { t } = useTypedTranslation('detailPanel')
  const feishu = useFeishuRemoteDisplayStatus()
  const wechat = useWeChatRemoteDisplayStatus()
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditChannel, setAuditChannel] = useState<RemoteAuditChannel>('feishu')

  const showFeishu = isFeishuChannelVisible(feishu.status)
  const showWechat = isWeChatChannelVisible(wechat.status)
  const showIdle = !showFeishu && !showWechat

  const feishuDisplay = useMemo(() => resolveFeishuDisplayText(feishu.status), [feishu.status])
  const wechatDisplay = useMemo(() => resolveWeChatDisplayText(wechat.status), [wechat.status])

  const startEnabled = feishu.status.startEnabled || wechat.status.startEnabled
  const stopEnabled = feishu.status.stopEnabled || wechat.status.stopEnabled
  const actionLoading = feishu.actionLoading ?? wechat.actionLoading

  const startDisabledReason = useMemo(() => {
    if (feishu.status.startEnabled) return feishuDisplay.startDisabledReason
    if (wechat.status.startEnabled) return wechatDisplay.startDisabledReason
    return feishuDisplay.startDisabledReason ?? wechatDisplay.startDisabledReason
  }, [feishu.status.startEnabled, wechat.status.startEnabled, feishuDisplay, wechatDisplay])

  const openSettingsTab = (tab: 'feishu' | 'wechat') => {
    dispatch(openSettings({ tab }))
  }

  const openSettingsFromMain = () => {
    if (showFeishu && !showWechat) {
      openSettingsTab('feishu')
      return
    }
    if (showWechat && !showFeishu) {
      openSettingsTab('wechat')
      return
    }
    openSettingsTab('feishu')
  }

  const handleStart = () => {
    if (feishu.status.startEnabled && feishu.status.displayState !== 'listening') {
      void feishu.start()
      return
    }
    if (wechat.status.startEnabled && wechat.status.displayState !== 'listening') {
      void wechat.start()
    }
  }

  const handleStop = () => {
    if (feishu.status.stopEnabled && feishu.status.displayState === 'listening') {
      void feishu.stop()
    }
    if (wechat.status.stopEnabled && wechat.status.displayState === 'listening') {
      void wechat.stop()
    }
  }

  const openAudit = () => {
    if (showFeishu && !showWechat) setAuditChannel('feishu')
    else if (showWechat && !showFeishu) setAuditChannel('wechat')
    else setAuditChannel('feishu')
    setAuditOpen(true)
  }

  return (
    <>
      <div className="remote-status-bar">
        <div
          className="remote-status-main"
          role="button"
          tabIndex={0}
          onClick={openSettingsFromMain}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openSettingsFromMain()
            }
          }}
        >
          <div className="remote-status-channels">
            {showIdle ? (
              <span className="remote-status-idle">{t('remoteStatus.idleHint')}</span>
            ) : (
              <>
                {showFeishu ? (
                  <FeishuRemoteStatusBar
                    status={feishu.status}
                    onOpenSettings={() => openSettingsTab('feishu')}
                  />
                ) : null}
                {showWechat ? (
                  <WeChatRemoteStatusBar
                    status={wechat.status}
                    onOpenSettings={() => openSettingsTab('wechat')}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="remote-status-actions">
          <Button
            size="small"
            type="text"
            className="remote-status-action-audit"
            aria-label={t('remoteStatus.auditAria')}
            onClick={(e) => {
              e.stopPropagation()
              openAudit()
            }}
          >
            {t('remoteStatus.auditLog')}
          </Button>
          {stopEnabled ? (
            <Button
              size="small"
              className="remote-status-action-btn"
              aria-label={t('remoteStatus.stopAria')}
              disabled={actionLoading != null}
              loading={actionLoading === 'stop'}
              onClick={(e) => {
                e.stopPropagation()
                handleStop()
              }}
            >
              {t('remoteStatus.stop')}
            </Button>
          ) : (
            <Tooltip title={!startEnabled ? startDisabledReason : undefined}>
              <Button
                size="small"
                className="remote-status-action-btn"
                aria-label={t('remoteStatus.startAria')}
                disabled={!startEnabled || actionLoading != null}
                loading={actionLoading === 'start'}
                onClick={(e) => {
                  e.stopPropagation()
                  handleStart()
                }}
              >
                {t('remoteStatus.start')}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <RemoteAuditDrawer
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        initialChannel={auditChannel}
        showFeishu={Boolean(appConfig?.feishu?.enabled)}
        showWechat={Boolean(appConfig?.wechat?.enabled)}
      />
    </>
  )
}
