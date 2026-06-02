import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setConfirmFocusToolUseId, setSession } from '../../store/chatSlice'
import { pendingConfirmStore, type PendingConfirmItem } from '../../services/pendingConfirmStore'
import {
  labelForPendingConfirmItem,
  useActionablePendingConfirms
} from '../../hooks/useActionablePendingConfirms'
import { formatToolLabel } from '../Chat/toolCallDisplay'
import { sessionDisplayName } from '../../utils/sessionDisplay'

function labelForItem(item: PendingConfirmItem, sessionName: string): string {
  if (item.toolName === 'run_script' || item.toolName === 'run_lark_cli' || item.toolName === 'run_shell') {
    return labelForPendingConfirmItem(item, sessionName)
  }
  const tool = formatToolLabel(item.toolName, item.input as Record<string, unknown>)
  return `${sessionName} · ${tool}`
}

export function PendingConfirmBanner() {
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const [items, setItems] = useState<PendingConfirmItem[]>(() => pendingConfirmStore.getItems())

  useEffect(() => {
    pendingConfirmStore.init()
    return pendingConfirmStore.subscribe(() => setItems(pendingConfirmStore.getItems()))
  }, [])

  const actionable = useActionablePendingConfirms(items, sessions, runningSessions)

  if (actionable.length === 0) return null

  const sessionName = (id: string) => {
    const s = sessions.find((x) => x.id === id)
    return s ? sessionDisplayName(s.name) : '会话'
  }

  return (
    <div className="pending-confirm-banner" role="region" aria-label="待确认工具">
      <div className="pending-confirm-banner__title">
        <AlertTriangle size={14} strokeWidth={1.75} aria-hidden />
        <span>{actionable.length} 项待确认</span>
      </div>
      <div className="pending-confirm-banner__list">
        {actionable.map((item) => {
          const label = labelForItem(item, sessionName(item.sessionId))
          return (
            <button
              key={`${item.requestId}:${item.toolUseId}`}
              type="button"
              className="pending-confirm-banner__item"
              title={label}
              onClick={() => {
                dispatch(setSession(item.sessionId))
                dispatch(setConfirmFocusToolUseId(item.toolUseId))
              }}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
