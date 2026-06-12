import { useEffect, useState, useCallback } from 'react'
import type { FloatingNotificationData, FloatingNotificationWindowApi } from '../../../shared/api'
import './floatingNotification.css'

type FloatingApi = FloatingNotificationWindowApi

declare global {
  interface Window {
    api: FloatingApi
  }
}

export function FloatingNotificationApp() {
  const [data, setData] = useState<FloatingNotificationData>({
    totalSessions: 0,
    totalItems: 0,
    latestItem: null
  })

  useEffect(() => {
    // 初始化：获取当前数据
    window.api.notificationGetData().then(setData).catch(() => undefined)

    // 订阅更新
    const unsubUpdate = window.api.notificationOnUpdate((newData) => {
      setData(newData)
    })

    // 订阅关闭
    const unsubClose = window.api.notificationOnClose(() => {
      window.close()
    })

    // 通知主进程就绪
    window.api.notificationReady().catch(() => undefined)

    return () => {
      unsubUpdate()
      unsubClose()
    }
  }, [])

  const handleItemClick = useCallback(() => {
    if (data.latestItem) {
      window.api.notificationFocusSession({
        sessionId: data.latestItem.sessionId,
        toolUseId: data.latestItem.toolUseId
      }).catch(() => undefined)
    }
  }, [data.latestItem])

  const handleShowMain = useCallback(() => {
    window.api.notificationShowMain().catch(() => undefined)
  }, [])

  const handleDismiss = useCallback(() => {
    window.api.notificationDismiss().catch(() => undefined)
  }, [])

  const hasItems = data.totalItems > 0 && data.latestItem

  return (
    <div className="floating-notification" role="alert" aria-label="待确认操作浮动通知">
      {/* 标题栏 */}
      <div className="floating-notification-header">
        <div className="floating-notification-header-left">
          <span className="floating-notification-warn-icon" aria-hidden>⚠</span>
          <span>待确认操作</span>
        </div>
        <button
          className="floating-notification-close"
          onClick={handleDismiss}
          aria-label="关闭通知"
        >
          ✕
        </button>
      </div>

      {/* 中间内容区 */}
      {hasItems && (
        <div
          className="floating-notification-body"
          onClick={handleItemClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleItemClick() }}
          aria-label="回到主界面确认待确认操作"
        >
          <span className="floating-notification-body-icon" aria-hidden>💻</span>
          <div className="floating-notification-body-content">
            <div className="floating-notification-body-session">
              {data.latestItem!.sessionName}
            </div>
            <div className="floating-notification-body-tool">
              {data.latestItem!.toolLabel}
            </div>
          </div>
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="floating-notification-footer">
        <span className="floating-notification-summary">
          共 {data.totalSessions} 个会话 · {data.totalItems} 项待确认
        </span>
        <button
          className="floating-notification-action"
          onClick={handleShowMain}
          aria-label="回到主界面"
        >
          回到主界面
        </button>
      </div>
    </div>
  )
}
