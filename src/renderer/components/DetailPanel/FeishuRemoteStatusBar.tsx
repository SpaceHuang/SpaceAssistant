import { useState, type KeyboardEvent } from 'react'
import { Badge, Button, Tooltip } from 'antd'
import { useAppDispatch } from '../../hooks'
import { openSettings } from '../../store/configSlice'
import { FeishuAuditDrawer } from '../Config/FeishuAuditDrawer'
import { useFeishuRemoteDisplayStatus } from './useFeishuRemoteDisplayStatus'
import type { FeishuRemoteDisplayState } from './feishuRemoteDisplayStatus'

function dotClass(displayState: FeishuRemoteDisplayState, connecting: boolean): string {
  if (displayState === 'listening' && connecting) return 'feishu-remote-status-dot feishu-remote-status-dot--connecting'
  if (displayState === 'listening') return 'feishu-remote-status-dot feishu-remote-status-dot--listening'
  if (displayState === 'error') return 'feishu-remote-status-dot feishu-remote-status-dot--error'
  return 'feishu-remote-status-dot feishu-remote-status-dot--idle'
}

export function FeishuRemoteStatusBar() {
  const dispatch = useAppDispatch()
  const { status, actionLoading, start, stop } = useFeishuRemoteDisplayStatus()
  const [auditOpen, setAuditOpen] = useState(false)

  const connecting = status.eventStatus.state === 'connecting'
  const mainTooltip =
    status.displayState === 'error'
      ? status.tooltip
      : status.displayState === 'listening' && status.subtext
        ? `监听中 · ${status.subtext}`
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
              <span className="feishu-remote-status-label-desc">飞书连接</span>
              <span className="feishu-remote-status-label-value">{status.label}</span>
            </span>
            {status.subtext ? <span className="feishu-remote-status-sub">{status.subtext}</span> : null}
          </div>
        </Tooltip>
        <div className="feishu-remote-status-actions">
          <Button
            size="small"
            type="text"
            aria-label="打开飞书操作记录"
            onClick={(e) => {
              e.stopPropagation()
              setAuditOpen(true)
            }}
          >
            操作记录
          </Button>
          {status.stopEnabled ? (
            <Button
              size="small"
              aria-label="停止飞书远程指令监听"
              disabled={actionLoading != null}
              loading={actionLoading === 'stop'}
              onClick={(e) => {
                e.stopPropagation()
                void stop()
              }}
            >
              停止
            </Button>
          ) : (
            <Tooltip title={!status.startEnabled ? status.startDisabledReason : undefined}>
              <Button
                size="small"
                aria-label="启动飞书远程指令监听"
                disabled={!status.startEnabled || actionLoading != null}
                loading={actionLoading === 'start'}
                onClick={(e) => {
                  e.stopPropagation()
                  void start()
                }}
              >
                启动
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <FeishuAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}
