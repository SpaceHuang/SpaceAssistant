import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setConfirmFocusToolUseId, setSession } from '../../store/chatSlice'
import { pendingConfirmStore, type PendingConfirmItem } from '../../services/pendingConfirmStore'
import { formatToolLabel } from '../Chat/toolCallDisplay'

function labelForItem(item: PendingConfirmItem, sessionName: string): string {
  const tool = formatToolLabel(item.toolName, item.input as Record<string, unknown>)
  return `${sessionName} · ${tool}`
}

export function PendingConfirmBanner() {
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const [items, setItems] = useState<PendingConfirmItem[]>(() => pendingConfirmStore.getItems())

  useEffect(() => {
    pendingConfirmStore.init()
    return pendingConfirmStore.subscribe(() => setItems(pendingConfirmStore.getItems()))
  }, [])

  if (items.length === 0) return null

  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name ?? '会话'

  return (
    <div className="pending-confirm-banner" role="region" aria-label="待确认工具">
      <div className="pending-confirm-banner__title">
        <AlertTriangle size={14} strokeWidth={1.75} aria-hidden />
        <span>
          {items.length} 项待确认
        </span>
      </div>
      <div className="pending-confirm-banner__list">
        {items.map((item) => (
          <button
            key={`${item.requestId}:${item.toolUseId}`}
            type="button"
            className="pending-confirm-banner__item"
            onClick={() => {
              dispatch(setSession(item.sessionId))
              dispatch(setConfirmFocusToolUseId(item.toolUseId))
            }}
          >
            {labelForItem(item, sessionName(item.sessionId))}
          </button>
        ))}
      </div>
    </div>
  )
}
