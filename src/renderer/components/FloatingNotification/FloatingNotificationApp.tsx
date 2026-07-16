import { useEffect, useState, useCallback } from 'react'
import { X } from 'lucide-react'
import type { FloatingNotificationData, FloatingNotificationWindowApi } from '../../../shared/api'
import { APP_PRODUCT_NAME } from '../../../shared/appMeta'
import appLogoUrl from '../../assets/sa-logo.png'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import {
  formatFloatingActionSummary,
  formatFloatingHoverTitle,
  formatFloatingMainLabel
} from './floatingNotificationDisplay'
import type { ToolCallDisplayT } from '../Chat/toolCallDisplay'
import { sessionDisplayName } from '../../utils/sessionDisplay'
import './floatingNotification.css'

type FloatingApi = FloatingNotificationWindowApi

export function FloatingNotificationApp() {
  const api = window.api as unknown as FloatingApi
  const { t } = useTypedTranslation('notification')
  const { t: tChatRaw } = useTypedTranslation('chat')
  const tChat = tChatRaw as ToolCallDisplayT
  const tNotification = t as (key: string, options?: Record<string, unknown>) => string
  const [data, setData] = useState<FloatingNotificationData>({
    totalSessions: 0,
    totalItems: 0,
    latestItem: null
  })

  useEffect(() => {
    api.notificationGetData().then(setData).catch(() => undefined)

    const unsubUpdate = api.notificationOnUpdate((newData) => {
      setData(newData)
    })

    const unsubClose = api.notificationOnClose(() => {
      unsubUpdate()
    })

    api.notificationReady().catch(() => undefined)

    return () => {
      unsubUpdate()
      unsubClose()
    }
  }, [])

  const handleItemClick = useCallback(() => {
    if (data.latestItem) {
      api.notificationFocusSession({
        sessionId: data.latestItem.sessionId,
        toolUseId: data.latestItem.toolUseId
      }).catch(() => undefined)
    }
  }, [data.latestItem])

  const handleShowMain = useCallback(() => {
    api.notificationShowMain().catch(() => undefined)
  }, [])

  const handleDismiss = useCallback(() => {
    api.notificationDismiss().catch(() => undefined)
  }, [])

  const hasItems = data.totalItems > 0 && data.latestItem
  const mainLabel = hasItems
    ? formatFloatingMainLabel(
        {
          toolName: data.latestItem!.toolName,
          input: data.latestItem!.input,
          totalItems: data.totalItems
        },
        tChat,
        tNotification
      )
    : ''
  const hoverTitle = hasItems
    ? formatFloatingHoverTitle(
        sessionDisplayName(data.latestItem!.sessionName, data.latestItem!.sessionId),
        data.latestItem!.toolName,
        data.latestItem!.input,
        data.totalItems,
        tChat,
        tNotification
      )
    : undefined

  return (
    <div
      className="floating-notification"
      role="alert"
      aria-label={t('aria.notification', { count: data.totalItems })}
    >
      <div className="floating-notification-top">
        <div className="floating-notification-top-start">
          <img
            src={appLogoUrl}
            alt=""
            className="floating-notification-mark"
            width={18}
            height={18}
            draggable={false}
          />
          <span className="floating-notification-brand">{APP_PRODUCT_NAME}</span>
        </div>
        <button
          type="button"
          className="floating-notification-close"
          onClick={handleDismiss}
          aria-label={t('aria.closeButton')}
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {hasItems && (
        <button
          type="button"
          className="floating-notification-main"
          onClick={handleItemClick}
          title={hoverTitle ?? mainLabel}
          aria-label={t('aria.itemClick')}
        >
          <span className="floating-notification-main-text">{mainLabel}</span>
        </button>
      )}

      <div className="floating-notification-bottom">
        <button
          type="button"
          className="floating-notification-action"
          onClick={handleShowMain}
          aria-label={t('aria.backToMainButton')}
        >
          {t('backToMain')}
        </button>
      </div>
    </div>
  )
}
