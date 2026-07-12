import { useCallback, useEffect, useMemo, useState } from 'react'
import { App } from 'antd'
import { useTypedSelector } from '../../hooks'
import {
  DEFAULT_WECHAT_CONFIG,
  mergeWeChatConfig,
  type WeChatConnectionStatus
} from '../../../shared/wechatTypes'
import { resolveWeChatRemoteDisplayStatus, type WeChatRemoteDisplayStatus } from './wechatRemoteDisplayStatus'
import { notifyWeChatPollResult } from '../../services/wechatPollFeedback'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export function useWeChatRemoteDisplayStatus() {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const wechatConfig = useTypedSelector((s) => s.config.config?.wechat)
  const config = useMemo(() => mergeWeChatConfig(wechatConfig ?? DEFAULT_WECHAT_CONFIG), [wechatConfig])

  const [liveConnection, setLiveConnection] = useState<WeChatConnectionStatus | null>(null)
  const [connectionOverride, setConnectionOverride] = useState<WeChatConnectionStatus | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | null>(null)

  const refreshConnection = useCallback(async () => {
    try {
      const status = await window.api.wechatConnectionStatus()
      setLiveConnection(status)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refreshConnection()
  }, [config, refreshConnection])

  useEffect(() => {
    if (!config.remoteEnabled) {
      setConnectionOverride(null)
      return
    }
    void refreshConnection()
    const timer = setInterval(() => {
      void refreshConnection()
    }, 5000)
    return () => clearInterval(timer)
  }, [config.remoteEnabled, refreshConnection])

  const status: WeChatRemoteDisplayStatus = useMemo(() => {
    const base = resolveWeChatRemoteDisplayStatus(
      config,
      connectionOverride,
      liveConnection,
      liveConnection?.loggedIn
    )
    if (fetchError && base.displayState !== 'error') {
      return {
        ...base,
        subtextKey: 'fetchFailed',
        tooltipRaw: fetchError
      }
    }
    return base
  }, [config, connectionOverride, liveConnection, fetchError])

  const start = useCallback(async () => {
    setActionLoading('start')
    try {
      const next = await window.api.wechatPollStart()
      setConnectionOverride(next)
      setLiveConnection(next)
      setFetchError(null)
      notifyWeChatPollResult(next, message, t)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setFetchError(detail)
      message.error(t('settings.wechat.listenFailedDetail', { detail }))
    } finally {
      setActionLoading(null)
    }
  }, [message, t])

  const stop = useCallback(async () => {
    setActionLoading('stop')
    try {
      const next = await window.api.wechatPollStop()
      setConnectionOverride(next)
      setLiveConnection(next)
      setFetchError(null)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setFetchError(detail)
      message.error(detail)
    } finally {
      setActionLoading(null)
    }
  }, [message])

  return {
    status,
    actionLoading,
    refresh: refreshConnection,
    start,
    stop
  }
}
