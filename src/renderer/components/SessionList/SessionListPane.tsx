import { useState } from 'react'
import { App as AntdApp, Empty, Input } from 'antd'
import { Square, Trash2 } from 'lucide-react'
import type { Session } from '../../../shared/domainTypes'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { removeSession } from '../../store/sessionSlice'
import { setSession } from '../../store/chatSlice'
import { groupSessionsByTime } from '../../utils/groupSessions'
import { sessionDisplayName, sessionListEmptyDescription } from '../../utils/sessionDisplay'
import { abortSessionRun } from '../../services/chatRunnerService'
import { PendingConfirmBanner } from './PendingConfirmBanner'
import { SessionDeleteConfirmModal } from './SessionDeleteConfirmModal'
import { SessionListIcon } from './SessionListIcon'
import { SessionItemContextMenu } from './SessionItemContextMenu'
import { SessionTitleEditor } from './SessionTitleEditor'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { formatUserFacingError } from '../../utils/formatUserFacingError'

export function SessionListPane() {
  const { t } = useTypedTranslation('common')
  const { message } = AntdApp.useApp()
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const currentId = useTypedSelector((s) => s.chat.currentSessionId)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const [q, setQ] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)

  const query = q.trim()
  const filtered = sessions.filter((s) =>
    sessionDisplayName(s.name).toLowerCase().includes(query.toLowerCase())
  )
  const groups = groupSessionsByTime(filtered)

  const stopRun = (id: string) => {
    abortSessionRun(id)
    message.info(t('session.aborted'))
  }

  const del = async (id: string): Promise<boolean> => {
    if (deletingId) return false
    setDeletingId(id)
    try {
      abortSessionRun(id)
      await window.api.sessionDelete(id)
      dispatch(removeSession(id))
      if (currentId === id) dispatch(setSession(null))
      message.success(t('session.deleted'))
      return true
    } catch (e) {
      message.error(formatUserFacingError(e instanceof Error ? e.message : t('session.deleteFailed')))
      return false
    } finally {
      setDeletingId(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    const ok = await del(deleteTarget.id)
    if (ok) setDeleteTarget(null)
  }

  return (
    <div className="sider-pane">
      <Input
        allowClear
        placeholder={t('session.searchPlaceholder')}
        aria-label={t('session.searchAria')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="session-list-search"
      />
      <PendingConfirmBanner />
      <div className="session-list-scroll">
        {groups.length === 0 ? (
          <Empty
            className="session-list-empty"
            description={sessionListEmptyDescription(sessions.length, query.length > 0)}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          groups.map((group) => {
            const groupId = `session-group-${group.label}`
            return (
              <section key={group.label} className="session-group" aria-labelledby={groupId}>
                <div id={groupId} className="session-group-label">
                  {group.label}
                </div>
                <div role="list" aria-labelledby={groupId} className="session-group-list">
                  {group.sessions.map((item) => {
                    const active = item.id === currentId
                    const running = Boolean(runningSessions[item.id])
                    const deleting = deletingId === item.id
                    const rowClass = [
                      'session-item',
                      active && 'session-item--active',
                      running && 'session-item--running',
                      deleting && 'session-item--deleting'
                    ]
                      .filter(Boolean)
                      .join(' ')

                    return (
                      <SessionItemContextMenu
                        key={item.id}
                        onRename={() => setEditingSessionId(item.id)}
                      >
                        <div role="listitem" className={rowClass}>
                          <button
                            type="button"
                            className="session-item-select"
                            aria-current={active ? 'true' : undefined}
                            disabled={deleting}
                            onClick={() => {
                              if (editingSessionId === item.id) return
                              dispatch(setSession(item.id))
                            }}
                          >
                            <SessionListIcon loading={running} />
                            {editingSessionId === item.id ? (
                              <SessionTitleEditor
                                session={item}
                                onDone={() => setEditingSessionId(null)}
                              />
                            ) : (
                              <span
                                className="session-item-name"
                                title={sessionDisplayName(item.name)}
                                aria-label={t('session.rename.aria', {
                                  name: sessionDisplayName(item.name)
                                })}
                              >
                                {sessionDisplayName(item.name)}
                              </span>
                            )}
                          </button>
                          {running ? (
                            <button
                              type="button"
                              className="session-item-stop"
                              aria-label={t('session.stopAria', { name: sessionDisplayName(item.name) })}
                              onClick={() => stopRun(item.id)}
                            >
                              <Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="session-item-delete"
                            aria-label={t('session.deleteAria', { name: sessionDisplayName(item.name) })}
                            disabled={deleting}
                            aria-busy={deleting}
                            onClick={() => {
                              if (!deletingId) setDeleteTarget(item)
                            }}
                          >
                            <Trash2 size={12} strokeWidth={1.75} aria-hidden />
                          </button>
                        </div>
                      </SessionItemContextMenu>
                    )
                  })}
                </div>
              </section>
            )
          })
        )}
      </div>
      <SessionDeleteConfirmModal
        session={deleteTarget}
        running={deleteTarget ? Boolean(runningSessions[deleteTarget.id]) : false}
        confirmLoading={deleteTarget != null && deletingId === deleteTarget.id}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          if (!deletingId) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
