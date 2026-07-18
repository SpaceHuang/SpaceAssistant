import { useCallback, useEffect, useState } from 'react'
import type { ArtifactApiItem } from '../../../shared/api'

export function useSessionArtifacts(sessionId: string | null): {
  artifacts: ArtifactApiItem[]
  loading: boolean
  refresh: () => Promise<void>
} {
  const [artifacts, setArtifacts] = useState<ArtifactApiItem[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setArtifacts([])
      return
    }
    setLoading(true)
    try {
      const items = await window.api.artifactList({ sessionId })
      setArtifacts(items.filter((item) => item.status === 'active'))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!sessionId) return
    return window.api.artifactOnChanged((event) => {
      if (event.sessionId === sessionId) void refresh()
    })
  }, [refresh, sessionId])

  return { artifacts, loading, refresh }
}
