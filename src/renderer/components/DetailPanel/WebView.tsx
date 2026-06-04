import { useEffect, useRef } from 'react'
import { Spin, Typography } from 'antd'
import type { WebViewController } from './DetailPanelContext'

type WebviewElement = HTMLElement & {
  src: string
  reload: () => void
  reloadIgnoringCache: () => void
  stop: () => void
  getURL: () => string
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
}

type Props = {
  url: string
  isLoading?: boolean
  error?: string | null
  onLoadStart?: () => void
  onLoadFinish?: (url: string) => void
  onLoadError?: (error: string) => void
  onLinkClick?: (url: string, target: string) => void
  onControllerRegister?: (controller: WebViewController | null) => void
}

export function WebView({
  url,
  isLoading = false,
  error = null,
  onLoadStart,
  onLoadFinish,
  onLoadError,
  onLinkClick,
  onControllerRegister
}: Props) {
  const ref = useRef<WebviewElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const controller: WebViewController = {
      reload: (ignoreCache = false) => {
        if (ignoreCache) el.reloadIgnoringCache()
        else el.reload()
      },
      stop: () => el.stop()
    }
    onControllerRegister?.(controller)
    return () => onControllerRegister?.(null)
  }, [onControllerRegister, url])

  useEffect(() => {
    const el = ref.current
    if (!el || !url) return

    const handleStart = () => onLoadStart?.()
    const handleFinish = () => {
      const currentUrl = typeof el.getURL === 'function' ? el.getURL() : url
      onLoadFinish?.(currentUrl || url)
    }
    const handleFail = () => onLoadError?.('页面加载失败，请检查网络或 URL')
    const handleNewWindow = (event: Event) => {
      const detail = event as Event & { url?: string; disposition?: string }
      if (!detail.url) return
      onLinkClick?.(detail.url, detail.disposition ?? '_blank')
    }

    el.addEventListener('did-start-loading', handleStart)
    el.addEventListener('did-finish-load', handleFinish)
    el.addEventListener('did-fail-load', handleFail)
    el.addEventListener('new-window', handleNewWindow)

    if (typeof el.getURL !== 'function' || el.getURL() !== url) {
      el.src = url
    }

    return () => {
      el.removeEventListener('did-start-loading', handleStart)
      el.removeEventListener('did-finish-load', handleFinish)
      el.removeEventListener('did-fail-load', handleFail)
      el.removeEventListener('new-window', handleNewWindow)
    }
  }, [url, onLoadStart, onLoadFinish, onLoadError, onLinkClick])

  return (
    <div className="detail-webview-wrap">
      {isLoading ? (
        <div className="detail-webview-loading">
          <Spin size="small" />
        </div>
      ) : null}
      {error ? (
        <div className="detail-webview-error">
          <Typography.Text type="danger">{error}</Typography.Text>
        </div>
      ) : null}
      {/* eslint-disable-next-line react/no-unknown-property */}
      <webview
        ref={(node) => {
          ref.current = node as WebviewElement | null
        }}
        className="detail-webview"
        src={url}
        allowpopups="false"
        webpreferences="contextIsolation=yes,javascript=yes"
      />
    </div>
  )
}
