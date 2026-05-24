import { useEffect, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setSession } from '../../store/chatSlice'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { pendingPlanStore, type PendingPlanItem } from '../../services/pendingPlanStore'

export function PendingPlanBanner() {
  const dispatch = useAppDispatch()
  const { closeFile } = useDetailPanel()
  const sessions = useTypedSelector((s) => s.session.list)
  const [items, setItems] = useState<PendingPlanItem[]>(() => pendingPlanStore.getItems())

  useEffect(() => {
    pendingPlanStore.init()
    pendingPlanStore.refreshFromSessions(sessions)
    return pendingPlanStore.subscribe(() => setItems(pendingPlanStore.getItems()))
  }, [sessions])

  if (items.length === 0) return null

  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name ?? '会话'

  const navigate = (sessionId: string) => {
    dispatch(setSession(sessionId))
    closeFile()
    window.dispatchEvent(new CustomEvent('plan-focus'))
  }

  return (
    <div className="pending-confirm-banner pending-confirm-banner--plan" role="region" aria-label="计划待审批">
      <div className="pending-confirm-banner__title">
        <ClipboardList size={14} strokeWidth={1.75} aria-hidden />
        <span>
          {items.length === 1
            ? `1 个计划待审批`
            : `${items.length} 个计划待审批`}
        </span>
      </div>
      <div className="pending-confirm-banner__list">
        {items.map((item) => (
          <button
            key={item.sessionId}
            type="button"
            className="pending-confirm-banner__item"
            onClick={() => navigate(item.sessionId)}
          >
            {items.length === 1
              ? `1 个计划待审批 · ${sessionName(item.sessionId)} · ${item.title}`
              : `${sessionName(item.sessionId)} · ${item.title}`}
          </button>
        ))}
      </div>
    </div>
  )
}
