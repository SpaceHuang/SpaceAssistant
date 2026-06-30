import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { App } from 'antd'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setConfirmFocusToolUseId, setSession } from '../../store/chatSlice'
import { pendingConfirmStore, type PendingConfirmItem } from '../../services/pendingConfirmStore'
import { ensureWorkDirForSession } from '../../services/workDirSessionSync'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import {
  labelForPendingConfirmItem,
  useActionablePendingConfirms
} from '../../hooks/useActionablePendingConfirms'
import { formatToolLabel } from '../Chat/toolCallDisplay'
import { sessionDisplayName } from '../../utils/sessionDisplay'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

function labelForItem(item: PendingConfirmItem, sessionName: string): string {
  if (item.toolName === 'run_script' || item.toolName === 'run_lark_cli' || item.toolName === 'run_shell') {
    return labelForPendingConfirmItem(item, sessionName)
  }
  const tool = formatToolLabel(item.toolName, item.input as Record<string, unknown>)
  return `${sessionName} · ${tool}`
}

export function PendingConfirmBanner() {
  const { t } = useTypedTranslation('common')
  const { message } = App.useApp()
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const config = useTypedSelector((s) => s.config.config)
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
    return s ? sessionDisplayName(s.name) : t('session.fallbackName')
  }

  return (
    <div className="pending-confirm-banner" role="region" aria-label={t('session.pendingConfirm.aria')}>
      <div className="pending-confirm-banner__title">
        <AlertTriangle size={14} strokeWidth={1.75} aria-hidden />
        <span>{t('session.pendingConfirm.count', { count: actionable.length })}</span>
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
                void (async () => {
                  const session =
                    sessions.find((s) => s.id === item.sessionId) ??
                    (await window.api.sessionGet(item.sessionId))
                  if (session && config) {
                    const sync = await ensureWorkDirForSession(session, config, dispatch)
                    if (!sync.ok) {
                      message.error(formatUserFacingError(sync.error))
                      return
                    }
                  }
                  dispatch(setSession(item.sessionId))
                  dispatch(setConfirmFocusToolUseId(item.toolUseId))
                })()
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
