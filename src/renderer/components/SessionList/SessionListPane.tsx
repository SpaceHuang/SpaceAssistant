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

export function SessionListPane() {
  const { message } = AntdApp.useApp()
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const currentId = useTypedSelector((s) => s.chat.currentSessionId)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const [q, setQ] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)

  const query = q.trim()
  const filtered = sessions.filter((s) =>
    sessionDisplayName(s.name).toLowerCase().includes(query.toLowerCase())
  )
  const groups = groupSessionsByTime(filtered)

  const stopRun = (id: string) => {
    abortSessionRun(id)
    message.info('已中止该会话的执行')
  }

  const del = async (id: string): Promise<boolean> => {
    if (deletingId) return false
    setDeletingId(id)
    try {
      abortSessionRun(id)
      await window.api.sessionDelete(id)
      dispatch(removeSession(id))
      if (currentId === id) dispatch(setSession(null))
      message.success('已删除')
      return true
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除会话失败，请稍后重试')
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
        placeholder="搜索会话"
        aria-label="搜索会话"
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
                      <div key={item.id} role="listitem" className={rowClass}>
                        <button
                          type="button"
                          className="session-item-select"
                          aria-current={active ? 'true' : undefined}
                          disabled={deleting}
                          onClick={() => dispatch(setSession(item.id))}
                        >
                          <SessionListIcon loading={running} />
                          <span className="session-item-name" title={sessionDisplayName(item.name)}>
                            {sessionDisplayName(item.name)}
                          </span>
                        </button>
                        {running ? (
                          <button
                            type="button"
                            className="session-item-stop"
                            aria-label={`中止「${sessionDisplayName(item.name)}」的执行`}
                            onClick={() => stopRun(item.id)}
                          >
                            <Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="session-item-delete"
                          aria-label={`删除会话「${sessionDisplayName(item.name)}」`}
                          disabled={deleting}
                          aria-busy={deleting}
                          onClick={() => {
                            if (!deletingId) setDeleteTarget(item)
                          }}
                        >
                          <Trash2 size={12} strokeWidth={1.75} aria-hidden />
                        </button>
                      </div>
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
