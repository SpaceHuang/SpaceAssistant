import { useEffect, useState } from 'react'
import { pendingConfirmStore, type PendingConfirmItem } from '../services/pendingConfirmStore'

/** 订阅 pendingConfirmStore，供聊天区在待确认态下刷新 toolsInteractive。 */
export function usePendingConfirmSnapshot(): PendingConfirmItem[] {
  const [items, setItems] = useState<PendingConfirmItem[]>(() => pendingConfirmStore.getItems())

  useEffect(() => {
    pendingConfirmStore.init()
    return pendingConfirmStore.subscribe(() => setItems(pendingConfirmStore.getItems()))
  }, [])

  return items
}
