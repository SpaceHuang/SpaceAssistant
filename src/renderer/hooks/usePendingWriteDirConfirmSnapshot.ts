import { useEffect, useState } from 'react'
import {
  pendingWriteDirConfirmStore,
  type PendingWriteDirConfirmItem
} from '../services/pendingWriteDirConfirmStore'

export function usePendingWriteDirConfirmSnapshot(sessionId: string | null): PendingWriteDirConfirmItem | undefined {
  const [item, setItem] = useState<PendingWriteDirConfirmItem | undefined>(() =>
    sessionId ? pendingWriteDirConfirmStore.findForSession(sessionId) : undefined
  )

  useEffect(() => {
    pendingWriteDirConfirmStore.init()
    return pendingWriteDirConfirmStore.subscribe(() => {
      setItem(sessionId ? pendingWriteDirConfirmStore.findForSession(sessionId) : undefined)
    })
  }, [sessionId])

  return item
}
