import { useEffect, useState } from 'react'
import type { ArtifactDecisionRequest } from '../../shared/artifactDecisionTypes'
import { pendingArtifactDecisionStore } from '../services/pendingArtifactDecisionStore'

export function usePendingArtifactDecisionSnapshot(sessionId: string | null): ArtifactDecisionRequest | undefined {
  const [item, setItem] = useState<ArtifactDecisionRequest | undefined>(() =>
    sessionId ? pendingArtifactDecisionStore.findForSession(sessionId) : undefined
  )

  useEffect(() => {
    pendingArtifactDecisionStore.init()
    return pendingArtifactDecisionStore.subscribe(() => {
      setItem(sessionId ? pendingArtifactDecisionStore.findForSession(sessionId) : undefined)
    })
  }, [sessionId])

  return item
}
