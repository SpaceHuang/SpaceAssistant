import { useCallback, useEffect, useState } from 'react'
import type { PlanReadResult } from '../../../shared/api'
import { useAppDispatch } from '../../hooks'
import { upsertSession } from '../../store/sessionSlice'

export function usePlanPanelState(sessionId: string | null) {
  const dispatch = useAppDispatch()
  const [planData, setPlanData] = useState<PlanReadResult | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!sessionId) {
      setPlanData(null)
      return null
    }
    setLoading(true)
    try {
      const data = await window.api.planRead({ sessionId })
      setPlanData(data)
      const s = await window.api.sessionGet(sessionId)
      if (s) dispatch(upsertSession(s))
      return data
    } finally {
      setLoading(false)
    }
  }, [sessionId, dispatch])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!sessionId) return
    const unsubState = window.api.planOnStateChanged((d) => {
      if (d.sessionId === sessionId) void reload()
    })
    const unsubReady = window.api.planOnApprovalReady((d) => {
      if (d.sessionId !== sessionId) return
      setPlanData(d.planState)
      void window.api.sessionGet(sessionId).then((s) => {
        if (s) dispatch(upsertSession(s))
      })
    })
    return () => {
      unsubState()
      unsubReady()
    }
  }, [sessionId, dispatch, reload])

  return { planData, loading, reload }
}
