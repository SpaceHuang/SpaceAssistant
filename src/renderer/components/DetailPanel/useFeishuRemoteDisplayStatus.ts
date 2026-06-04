import { useCallback, useEffect, useMemo, useState } from 'react'
import { App } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_FEISHU_CONFIG, mergeFeishuConfig, type FeishuEventStatus, type FeishuHealthCheck } from '../../../shared/feishuTypes'
import { resolveFeishuRemoteDisplayStatus, type FeishuRemoteDisplayStatus } from './feishuRemoteDisplayStatus'

export function useFeishuRemoteDisplayStatus() {
  const { message } = App.useApp()
  const feishuConfig = useTypedSelector((s) => s.config.config?.feishu)
  const config = useMemo(() => mergeFeishuConfig(feishuConfig ?? DEFAULT_FEISHU_CONFIG), [feishuConfig])

  const [health, setHealth] = useState<FeishuHealthCheck | null>(null)
  const [liveUserAuthorized, setLiveUserAuthorized] = useState<boolean | null>(null)
  const [eventOverride, setEventOverride] = useState<FeishuEventStatus | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | null>(null)

  const refreshHealth = useCallback(async () => {
    try {
      const [h, auth] = await Promise.all([window.api.feishuHealthCheck(), window.api.feishuAuthStatus()])
      setHealth(h)
      setLiveUserAuthorized(auth.authorized)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const refreshEvent = useCallback(async () => {
    try {
      const es = await window.api.feishuEventStatus()
      setEventOverride(es ?? null)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
  }, [config, refreshHealth])

  useEffect(() => {
    if (!config.remoteEnabled) {
      setEventOverride(null)
      return
    }
    void refreshEvent()
    const t = setInterval(() => {
      void refreshEvent()
    }, 5000)
    return () => clearInterval(t)
  }, [config.remoteEnabled, refreshEvent])

  const status: FeishuRemoteDisplayStatus = useMemo(() => {
    const base = resolveFeishuRemoteDisplayStatus(
      config,
      health,
      eventOverride,
      liveUserAuthorized ?? undefined
    )
    if (fetchError && base.displayState !== 'error') {
      return {
        ...base,
        subtextKey: 'fetchFailed',
        tooltipRaw: fetchError
      }
    }
    return base
  }, [config, health, eventOverride, liveUserAuthorized, fetchError])

  const start = useCallback(async () => {
    setActionLoading('start')
    try {
      const es = await window.api.feishuEventStart()
      setEventOverride(es)
      setFetchError(null)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoading(null)
    }
  }, [message])

  const stop = useCallback(async () => {
    setActionLoading('stop')
    try {
      const es = await window.api.feishuEventStop()
      setEventOverride(es)
      setFetchError(null)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoading(null)
    }
  }, [message])

  return {
    status,
    actionLoading,
    refresh: refreshHealth,
    start,
    stop
  }
}
