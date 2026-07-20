import { useEffect, useState } from 'react'
import {
  pendingArtifactDecisionStore,
  type PendingArtifactDecisionItem
} from '../services/pendingArtifactDecisionStore'

export function usePendingArtifactDecisionSnapshot(
  sessionId: string | null
): PendingArtifactDecisionItem | undefined {
  const [item, setItem] = useState<PendingArtifactDecisionItem | undefined>(() =>
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
