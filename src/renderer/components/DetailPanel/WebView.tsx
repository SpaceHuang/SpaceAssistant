import { useEffect, useRef } from 'react'
import { Spin, Typography } from 'antd'
import type { WebViewController } from './DetailPanelContext'

type WebviewElement = HTMLElement & {
  src: string
  reload: () => void
  reloadIgnoringCache: () => void
  stop: () => void
  getURL: () => string
  loadURL: (url: string) => void
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
}

function safeGetURL(el: WebviewElement, fallback: string): string {
  try {
    return el.getURL() || fallback
  } catch {
    return fallback
  }
}

function safeRunWebviewAction(action: () => void): void {
  try {
    action()
  } catch {
    // webview APIs require dom-ready; ignore premature calls
  }
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
  const domReadyRef = useRef(false)
  const loadedUrlRef = useRef<string | null>(null)

  useEffect(() => {
    domReadyRef.current = false
    loadedUrlRef.current = null
  }, [url])

  useEffect(() => {
    const el = ref.current
    if (!el || !url) return

    const registerController = () => {
      onControllerRegister?.({
        reload: (ignoreCache = false) => {
          safeRunWebviewAction(() => {
            if (ignoreCache) el.reloadIgnoringCache()
            else el.reload()
          })
        },
        stop: () => {
          safeRunWebviewAction(() => el.stop())
        }
      })
    }

    const handleDomReady = () => {
      domReadyRef.current = true
      registerController()
      if (loadedUrlRef.current !== url) {
        loadedUrlRef.current = url
        safeRunWebviewAction(() => {
          if (typeof el.loadURL === 'function') el.loadURL(url)
          else el.src = url
        })
      }
    }

    const handleStart = () => onLoadStart?.()
    const handleFinish = () => {
      onLoadFinish?.(safeGetURL(el, url))
    }
    const handleFail = () => onLoadError?.('页面加载失败，请检查网络或 URL')
    const handleNewWindow = (event: Event) => {
      const detail = event as Event & { url?: string; disposition?: string }
      if (!detail.url) return
      onLinkClick?.(detail.url, detail.disposition ?? '_blank')
    }

    el.addEventListener('dom-ready', handleDomReady)
    el.addEventListener('did-start-loading', handleStart)
    el.addEventListener('did-finish-load', handleFinish)
    el.addEventListener('did-fail-load', handleFail)
    el.addEventListener('new-window', handleNewWindow)

    return () => {
      el.removeEventListener('dom-ready', handleDomReady)
      el.removeEventListener('did-start-loading', handleStart)
      el.removeEventListener('did-finish-load', handleFinish)
      el.removeEventListener('did-fail-load', handleFail)
      el.removeEventListener('new-window', handleNewWindow)
      onControllerRegister?.(null)
    }
  }, [url, onLoadStart, onLoadFinish, onLoadError, onLinkClick, onControllerRegister])

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
