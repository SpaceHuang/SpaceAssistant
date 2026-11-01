import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createPersistedTurn, createSession, getSessionMessageRevisionSnapshot } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import * as transcriptProjection from './infrastructure/sqlite/sessionTranscriptProjection'
import { createSqliteSessionStorage } from './sqliteSessionStorage'
import { listSessions } from '../database/operations'
import { createStorageLifecycleControl } from './lifecycle'
import { createSessionTranscriptRecoveryAdapter } from './recoveryDatabaseAdapter'

describe('daily session action work boundaries', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined; vi.restoreAllMocks() })

  it('lists visible sessions from metadata without reading any message body or preparing unselected sessions', () => {
    db = createMemoryAppDb()
    const selected = createSession(db, { name: 'selected' })
    const unselected = createSession(db, { name: 'unselected' })
    appendMessage(db, { id: 'daily-unselected-body', sessionId: unselected.id, role: 'user', content: 'x'.repeat(128 * 1024), timestamp: 1, status: 'sent' })
    const storage = createSqliteSessionStorage(db)
    const bodyRead = vi.spyOn(transcriptProjection, 'getProjectedMessages').mockImplementation(() => {
      throw new Error('DAILY_LIST_MUST_NOT_READ_BODIES')
    })

    expect(storage.queries.listSessions({ view: 'user-visible' }).map(({ id }) => id)).toContain(selected.id)
    expect(storage.queries.listSessions({ view: 'user-visible' }).map(({ id }) => id)).toContain(unselected.id)
    expect(bodyRead).not.toHaveBeenCalled()
    expect(storage.availability.inspect(unselected.id).content.state).toBe('readable')
    expect(bodyRead).not.toHaveBeenCalled()
    expect(getSessionMessageRevisionSnapshot(db, unselected.id)).toMatchObject({ sessionId: unselected.id, messageRevision: 1 })
  })

  it('pushes visibility and profile filters into the list SQL without scanning non-target sessions', () => {
    db = createMemoryAppDb()
    const active = createSession(db, { name: 'active profile', workDirProfileId: 'profile-active', ownership: 'user', visibility: 'visible' })
    createSession(db, { name: 'other profile', workDirProfileId: 'profile-other', ownership: 'user', visibility: 'visible' })
    const prepare = vi.spyOn(getDbConnection(db), 'prepare')

    expect(listSessions(db, { view: 'user-visible', workDirProfileId: 'profile-active' }).map(({ id }) => id)).toEqual([active.id])

    const listSql = prepare.mock.calls.map(([sql]) => String(sql)).find((sql) =>
      sql.includes('FROM sessions') && sql.includes('work_dir_profile_id'))
    expect(listSql).toContain("ownership IS NOT NULL AND ownership != 'internal'")
    expect(listSql).toContain('work_dir_profile_id = ?')
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('work_dir_profile_id = ?'))
  })

  it('reads only the requested session page and leaves other session transcript recovery untouched', () => {
    db = createMemoryAppDb()
    const selected = createSession(db, { name: 'selected page' })
    const unselected = createSession(db, { name: 'unselected recovery' })
    appendMessage(db, { id: 'selected-page-message', sessionId: selected.id, role: 'user', content: 'selected body', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'unselected-recovery-message', sessionId: unselected.id, role: 'user', content: 'unselected body', timestamp: 2, status: 'sent' })
    const storage = createSqliteSessionStorage(db)
    const pageRead = vi.spyOn(transcriptProjection, 'getProjectedChatMessagePage')

    const page = storage.queries.readChatPage({ sessionId: selected.id, limit: 20 })

    expect(page.entries.map(({ message }) => message.id)).toEqual(['selected-page-message'])
    expect(pageRead).toHaveBeenCalledTimes(1)
    expect(pageRead).toHaveBeenCalledWith(db, selected.id, undefined, 20)
    expect(pageRead).not.toHaveBeenCalledWith(db, unselected.id, expect.anything(), expect.anything())
  })

  it('recovers only the selected target while an unrelated uncertain session stays untouched', () => {
    db = createMemoryAppDb()
    const selected = createSession(db, { name: 'selected recovery' })
    const other = createSession(db, { name: 'unselected uncertain' })
    const selectedUser = appendMessage(db, { id: 'daily-selected-user', sessionId: selected.id, role: 'user', content: 'selected', timestamp: 1, status: 'sent' })
    const selectedAssistant = appendMessage(db, { id: 'daily-selected-assistant', sessionId: selected.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'daily-selected-turn', requestId: 'daily-selected-request', sessionId: selected.id,
      assistantMessageId: selectedAssistant.message.id, userMessageId: selectedUser.message.id, state: 'prepared', startToken: 'daily-selected-token' })
    getDbConnection(db).prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES(?,?,?,1,'claimed',1,1)`).run(selected.id, 'daily-selected-turn', 'daily-selected-owner')
    const otherUser = appendMessage(db, { id: 'daily-other-user', sessionId: other.id, role: 'user', content: 'other', timestamp: 3, status: 'sent' })
    const otherAssistant = appendMessage(db, { id: 'daily-other-assistant', sessionId: other.id, role: 'assistant', content: '', timestamp: 4, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'daily-other-turn', requestId: 'daily-other-request', sessionId: other.id,
      assistantMessageId: otherAssistant.message.id, userMessageId: otherUser.message.id, state: 'prepared', startToken: 'daily-other-token' })

    expect(createSessionTranscriptRecoveryAdapter(db).recoverTarget(selected.id, 5)).toMatchObject({ status: 'ready' })

    expect(getDbConnection(db).prepare('SELECT state FROM turns WHERE turn_id=?').get('daily-selected-turn')).toEqual({ state: 'prepared' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(selected.id)).toMatchObject({ status: 'queued' })
    expect(getDbConnection(db).prepare('SELECT state FROM turns WHERE turn_id=?').get('daily-other-turn')).toEqual({ state: 'prepared' })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get('daily-other-assistant')).toEqual({ status: 'streaming' })
  })

  it('starts maintenance only from an explicit maintenance request, never from list or page reads', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'maintenance boundary' })
    const start = vi.fn(() => ({ stop: vi.fn(), quiesce: async () => undefined }))
    const lifecycle = createStorageLifecycleControl({ tasks: [{ taskId: 'test-maintenance', category: 'pending-reclamation', start }] })
    const storage = createSqliteSessionStorage(db)

    storage.queries.listSessions({ view: 'user-visible' })
    storage.queries.readChatPage({ sessionId: session.id, limit: 20 })
    expect(lifecycle.inspectMaintenance()).toEqual([{ taskId: 'test-maintenance', category: 'pending-reclamation', status: 'idle', scannedCount: 0, processedCount: 0 }])
    expect(start).not.toHaveBeenCalled()

    lifecycle.allowBackgroundWork()
    expect(lifecycle.requestMaintenance({ reason: 'scope-changed', category: 'pending-reclamation' })).toEqual({ status: 'coalesced' })
    expect(start).toHaveBeenCalledOnce()
  })
})
