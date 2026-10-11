import { describe, expect, it } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from './testHelpers'
import { appendRemoteTrackEvent, applyRemoteTrackLifecycleEvent, bindRemoteTrackToTurn, claimRemoteTrackWork, convergeRemoteTrackTerminal, createRemoteTrack, mapRemoteTrackMessage, readRemoteTrackSourceChildren, recordRemoteTrackChild, recordRemoteTrackConfirmationState, requestRemoteTrackTerminal, resolveRemoteTrackMessageReference, settleRemoteTrackWork, bindRemoteTrackWorkExecution, type RemoteTrackChildSourceReader } from './remoteTrackStore'
import { getDbConnection } from './sqliteStore'
import { openSqliteDatabase } from './sqliteStore'
import { openDatabase } from './index'
import { runInTransaction } from './transaction'
import { createClarification } from './clarificationStore'

const readProjectedChildrenForRepositoryTest: RemoteTrackChildSourceReader = (conn, trackId) =>
  conn.prepare('SELECT child_kind AS kind,child_id AS id,state FROM remote_track_children WHERE track_id=?').all(trackId) as Array<{
    kind: 'turn' | 'confirmation' | 'async-todo' | 'parked-input' | 'resume-work' | 'execution-work' | 'tool-dispatch'
    id: string
    state: string
  }>

describe('remote Track persistence', () => {
  it('moves an open Track to processing when its first turn is durably bound', async () => {
    const db = createMemoryAppDb()
    try {
      const { appendMessage, createPersistedTurn, createSession } = await import('./operations')
      const session = createSession(db, { name: 'track-lifecycle-execution' })
      appendMessage(db, { id: 'lifecycle-user', sessionId: session.id, role: 'user', content: 'start', timestamp: 1, status: 'sent' })
      appendMessage(db, { id: 'lifecycle-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
      createRemoteTrack(db, { trackId: 'lifecycle-track', eventId: 'lifecycle-root', idempotencyKey: 'lifecycle-inbound', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'lifecycle-user', originSessionId: session.id, occurredAt: 1 })
      createPersistedTurn(db, { turnId: 'lifecycle-turn', requestId: 'lifecycle-request', sessionId: session.id,
        assistantMessageId: 'lifecycle-assistant', userMessageId: 'lifecycle-user', state: 'prepared', startToken: 'lifecycle-token' })

      bindRemoteTrackToTurn(db, { trackId: 'lifecycle-track', turnId: 'lifecycle-turn', sessionId: session.id, channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, eventId: 'lifecycle-turn-bound', occurredAt: 3 })

      expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('lifecycle-track'))
        .toEqual({ state: 'processing' })
      expect(getDbConnection(db).prepare('SELECT event_kind,turn_id FROM remote_track_events WHERE idempotency_key=?').get('turn:lifecycle-turn:started'))
        .toEqual({ event_kind: 'track.turn.started', turn_id: 'lifecycle-turn' })
    } finally { db.close() }
  })

  it('treats router and Agent binding event IDs for the same persisted Turn as idempotent', async () => {
    const db = createMemoryAppDb()
    try {
      const { appendMessage, createPersistedTurn, createSession } = await import('./operations')
      const session = createSession(db, { name: 'duplicate-turn-bindings' })
      appendMessage(db, { id: 'duplicate-binding-user', sessionId: session.id, role: 'user', content: 'start', timestamp: 1, status: 'sent' })
      appendMessage(db, { id: 'duplicate-binding-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
      createRemoteTrack(db, { trackId: 'duplicate-binding-track', eventId: 'duplicate-binding-root', idempotencyKey: 'duplicate-binding-root-key',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'duplicate-binding-user',
        originSessionId: session.id, occurredAt: 1 })
      createPersistedTurn(db, { turnId: 'duplicate-binding-turn', requestId: 'duplicate-binding-request', sessionId: session.id,
        assistantMessageId: 'duplicate-binding-assistant', userMessageId: 'duplicate-binding-user', state: 'prepared', startToken: 'token' })
      const base = { trackId: 'duplicate-binding-track', turnId: 'duplicate-binding-turn', sessionId: session.id, channel: 'wechat' as const,
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, occurredAt: 3 }

      bindRemoteTrackToTurn(db, { ...base, eventId: 'track-turn:duplicate-binding-turn' })
      expect(() => bindRemoteTrackToTurn(db, { ...base, eventId: 'duplicate-binding-track:turn:duplicate-binding-turn' })).not.toThrow()

      expect(getDbConnection(db).prepare('SELECT track_id FROM turns WHERE turn_id=?').get('duplicate-binding-turn'))
        .toEqual({ track_id: 'duplicate-binding-track' })
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM remote_track_events WHERE idempotency_key='turn:duplicate-binding-turn'").get())
        .toEqual({ count: 1 })
    } finally { db.close() }
  })

  it('treats a missing authoritative assistant message as incomplete lifecycle evidence', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('./operations')
      const sessionId = createSession(db, { name: 'missing-track-assistant' }).id
      createRemoteTrack(db, { trackId: 'missing-assistant-track', eventId: 'missing-assistant-root', idempotencyKey: 'missing-assistant-inbound',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'platform-root', occurredAt: 1 })
      const conn = getDbConnection(db)
      conn.exec('PRAGMA foreign_keys=OFF')
      conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,track_id)
        VALUES('turn-missing-assistant','request','${sessionId}','not-a-message','executing',1,1,'missing-assistant-track')`).run()
      conn.exec('PRAGMA foreign_keys=ON')

      expect(readRemoteTrackSourceChildren(conn, 'missing-assistant-track', () => [])).toBeNull()
      expect(requestRemoteTrackTerminal(db, { trackId: 'missing-assistant-track', target: 'completed', eventId: 'missing-assistant-terminal',
        occurredAt: 2, readSourceChildren: (sourceConn, trackId) => readRemoteTrackSourceChildren(sourceConn, trackId, () => []) }))
        .toMatchObject({ state: 'reconciliation-blocked', rejected: 'child-source-snapshot-unavailable' })
    } finally { db.close() }
  })

  it('persists synchronous confirmation as a Track child and settles it without losing the event link', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: 'confirm-track', eventId: 'confirm-root', idempotencyKey: 'confirm-inbound', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-message', occurredAt: 1 })
      applyRemoteTrackLifecycleEvent(db, { trackId: 'confirm-track', eventId: 'confirm-start', idempotencyKey: 'confirm-start-key', occurredAt: 2, event: { type: 'execution-started' } })
      recordRemoteTrackConfirmationState(db, { trackId: 'confirm-track', confirmationId: 'confirm-1', attributionEventId: 'confirm-root', state: 'pending', occurredAt: 2,
        requestId: 'request-1', turnId: 'turn-1', toolUseId: 'tool-use-1', toolName: 'fetch' })
      expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('confirm-track')).toEqual({ state: 'waiting-user' })
      expect(getDbConnection(db).prepare("SELECT request_id,turn_id,tool_use_id,confirmation_id FROM remote_track_events WHERE event_kind='track.confirmation.created'").get())
        .toEqual({ request_id: 'request-1', turn_id: 'turn-1', tool_use_id: 'tool-use-1', confirmation_id: 'confirm-1' })
      expect(getDbConnection(db).prepare("SELECT state FROM remote_track_children WHERE track_id=? AND child_kind='confirmation' AND child_id=?").get('confirm-track', 'confirm-1'))
        .toEqual({ state: 'pending' })
      recordRemoteTrackConfirmationState(db, { trackId: 'confirm-track', confirmationId: 'confirm-1', attributionEventId: 'confirm-root', state: 'settled', occurredAt: 3,
        requestId: 'request-1', turnId: 'turn-1', toolUseId: 'tool-use-1', toolName: 'fetch' })
      expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('confirm-track')).toEqual({ state: 'processing' })
      expect(getDbConnection(db).prepare("SELECT state FROM remote_track_children WHERE track_id=? AND child_kind='confirmation' AND child_id=?").get('confirm-track', 'confirm-1'))
        .toEqual({ state: 'settled' })
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM remote_track_events WHERE track_id=? AND event_kind IN ('track.confirmation.created','track.confirmation.settled')").get('confirm-track'))
        .toEqual({ count: 2 })
    } finally {
      db.close()
    }
  })

  it('claims queued work with a fenced lease and rejects a late prior worker', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, {
        trackId: 'work-track', eventId: 'work-root', idempotencyKey: 'work-inbound', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'work-message', occurredAt: 1
      })
      const conn = getDbConnection(db)
      conn.prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,created_at,updated_at)
        VALUES('work-1','source-1','work-track','work-message','queued',1,1)`).run()
      conn.prepare("UPDATE remote_track_work_queue SET session_id='session' WHERE work_id='work-1'").run()
      recordRemoteTrackChild(db, { trackId: 'work-track', kind: 'execution-work', childId: 'work-1', state: 'queued', updatedAt: 1 })
      const first = claimRemoteTrackWork(db, { workerId: 'worker-old', now: 10, leaseMs: 5, workId: 'work-1' })!
      expect(first).toMatchObject({ workId: 'work-1', workerId: 'worker-old', attempt: 1 })
      const second = claimRemoteTrackWork(db, { workerId: 'worker-new', now: 16, leaseMs: 10, workId: 'work-1' })!
      expect(second.attempt).toBe(2)
      expect(() => bindRemoteTrackWorkExecution(db, {
        workId: 'work-1', workerId: 'worker-old', attempt: first.attempt, sessionId: 'session', requestId: 'request',
        turnId: 'turn', userMessageId: 'user-message', modelViewVersion: 'view-v1', now: 17
      })).toThrow('remote Track work lease lost')
      expect(bindRemoteTrackWorkExecution(db, {
        workId: 'work-1', workerId: 'worker-new', attempt: second.attempt, sessionId: 'session', requestId: 'request',
        turnId: 'turn', userMessageId: 'user-message', modelViewVersion: 'view-v1', now: 17
      })).toBe(true)
      expect(() => bindRemoteTrackWorkExecution(db, {
        workId: 'work-1', workerId: 'worker-new', attempt: second.attempt, sessionId: 'session', requestId: 'request-2',
        turnId: 'turn-2', userMessageId: 'user-message-2', modelViewVersion: 'view-v2', now: 18
      })).toThrow('remote Track work execution mapping is immutable')
      expect(settleRemoteTrackWork(db, { workId: 'work-1', workerId: 'worker-old', attempt: first.attempt, state: 'completed', now: 19 })).toBe(false)
      expect(settleRemoteTrackWork(db, { workId: 'work-1', workerId: 'worker-new', attempt: second.attempt, state: 'completed', now: 20 })).toBe(true)
      expect(conn.prepare('SELECT state,session_id,request_id,turn_id,user_message_id,model_view_version FROM remote_track_work_queue WHERE work_id=?').get('work-1'))
        .toEqual({ state: 'completed', session_id: 'session', request_id: 'request', turn_id: 'turn', user_message_id: 'user-message', model_view_version: 'view-v1' })
    } finally {
      db.close()
    }
  })

  it('settles uncertain work and atomically queues a user-visible reconciliation notice', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('./operations')
      const sessionId = createSession(db, { name: 'work-reconciliation' }).id
      createRemoteTrack(db, { trackId: 'reconcile-track', eventId: 'reconcile-root', idempotencyKey: 'reconcile-inbound',
        channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        rootMessageId: 'reconcile-message', occurredAt: 1 })
      const { createClarification } = await import('./clarificationStore')
      createClarification(db, { clarificationId: 'reconcile-clarification', channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a',
        authorizationEpoch: 1, sourceMessageId: 'source-message', parkedInputRef: 'parked-message', createdAt: 1, expiresAt: 1000,
        version: 1, handle: 'ABCDEFGHJK345', candidates: [{ trackId: 'reconcile-track', option: 1, label: '任务', stateAtIssue: 'open' }] })
      const conn = getDbConnection(db)
      conn.prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,clarification_id,state,created_at,updated_at)
        VALUES('reconcile-work','clarification:reconcile-clarification','reconcile-track','source-message','reconcile-clarification','queued',1,1)`).run()
      conn.prepare("UPDATE remote_track_work_queue SET session_id=?,state='queued' WHERE work_id='reconcile-work'").run(sessionId)
      recordRemoteTrackChild(db, { trackId: 'reconcile-track', kind: 'execution-work', childId: 'reconcile-work', state: 'queued', updatedAt: 1 })
      const claim = claimRemoteTrackWork(db, { workerId: 'recovery-worker', now: 10, leaseMs: 100, workId: 'reconcile-work' })!
      expect(settleRemoteTrackWork(db, { workId: claim.workId, workerId: claim.workerId, attempt: claim.attempt,
        state: 'needs-reconciliation', now: 20, noticeText: '原消息未重新执行，请检查桌面会话。' })).toBe(true)
      expect(conn.prepare('SELECT state FROM remote_track_work_queue WHERE work_id=?').get('reconcile-work')).toEqual({ state: 'needs-reconciliation' })
      expect(conn.prepare('SELECT state FROM remote_track_children WHERE track_id=? AND child_id=?').get('reconcile-track', 'reconcile-work'))
        .toEqual({ state: 'needs-reconciliation' })
      expect(conn.prepare("SELECT event_id,session_id,stage,text,state FROM im_lifecycle_outbox WHERE event_id=?")
        .get('track-work-terminal:reconcile-work:needs-reconciliation')).toEqual({
          event_id: 'track-work-terminal:reconcile-work:needs-reconciliation', session_id: sessionId,
          stage: 'failed', text: '原消息未重新执行，请检查桌面会话。', state: 'pending'
        })
    } finally { db.close() }
  })

  it('creates a root event once for a repeated inbound idempotency key', () => {
    const db = createMemoryAppDb()
    try {
      const input = {
        trackId: 'track-1', eventId: 'event-1', idempotencyKey: 'wechat:user:message-1',
        channel: 'wechat' as const, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 4,
        rootMessageId: 'message-1', occurredAt: 100
      }
      expect(createRemoteTrack(db, input)).toEqual({ trackId: 'track-1', created: true })
      expect(createRemoteTrack(db, { ...input, trackId: 'track-2', eventId: 'event-2' })).toEqual({ trackId: 'track-1', created: false })
      const conn = getDbConnection(db)
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 1 })
      expect(conn.prepare('SELECT COUNT(*) AS count FROM remote_track_events').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  it('does not reveal or reuse an inbound receipt from another identity or channel', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, {
        trackId: 'track-1', eventId: 'event-1', idempotencyKey: 'colliding-key', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1, rootMessageId: 'wx-message', occurredAt: 1
      })
      expect(() => createRemoteTrack(db, {
        trackId: 'track-2', eventId: 'event-2', idempotencyKey: 'colliding-key', channel: 'feishu',
        identityKey: 'bob', ownerId: 'owner-b', authorizationEpoch: 1, rootMessageId: 'fs-message', occurredAt: 2
      })).toThrow('remote Track inbound idempotency key collision')
    } finally {
      db.close()
    }
  })

  it('does not complete while a durable child work item is pending, then completes after settlement', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, {
        trackId: 'track-1', eventId: 'event-1', idempotencyKey: 'inbound-1', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'message-1', occurredAt: 1
      })
      recordRemoteTrackChild(db, { trackId: 'track-1', kind: 'async-todo', childId: 'todo-1', state: 'pending', updatedAt: 2 })
      expect(requestRemoteTrackTerminal(db, { trackId: 'track-1', target: 'completed', eventId: 'terminal-1', occurredAt: 3, readSourceChildren: readProjectedChildrenForRepositoryTest }))
        .toMatchObject({ state: 'waiting-async-approval', rejected: 'unfinished-child-work' })
      recordRemoteTrackChild(db, { trackId: 'track-1', kind: 'async-todo', childId: 'todo-1', state: 'completed', updatedAt: 4 })
      expect(requestRemoteTrackTerminal(db, { trackId: 'track-1', target: 'completed', eventId: 'terminal-2', occurredAt: 5, readSourceChildren: readProjectedChildrenForRepositoryTest }))
        .toEqual({ state: 'completed' })
      expect(() => recordRemoteTrackChild(db, { trackId: 'track-1', kind: 'turn', childId: 'late-turn', state: 'executing', updatedAt: 6 }))
        .toThrow('cannot attach unfinished child work to terminal Track')
    } finally {
      db.close()
    }
  })

  it('retries Track terminal aggregation with a new event after claimed execution work settles', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: 'settle-converge-track', eventId: 'settle-converge-root', idempotencyKey: 'settle-converge-inbound',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'settle-converge-message', occurredAt: 1 })
      getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,created_at,updated_at)
        VALUES('settle-converge-work','settle-converge-source','settle-converge-track','settle-converge-message','queued',1,1)`).run()
      recordRemoteTrackChild(db, { trackId: 'settle-converge-track', kind: 'execution-work', childId: 'settle-converge-work', state: 'queued', updatedAt: 1 })
      const claim = claimRemoteTrackWork(db, { workerId: 'clarification-worker', now: 2, leaseMs: 100, workId: 'settle-converge-work' })!
      const readSourceChildren = (conn: ReturnType<typeof getDbConnection>, trackId: string) => readRemoteTrackSourceChildren(conn, trackId, () => [])

      expect(requestRemoteTrackTerminal(db, { trackId: 'settle-converge-track', target: 'completed', eventId: 'before-settle',
        occurredAt: 3, readSourceChildren })).toMatchObject({ state: 'processing', rejected: 'unfinished-child-work' })
      expect(settleRemoteTrackWork(db, { workId: claim.workId, workerId: claim.workerId, attempt: claim.attempt, state: 'completed', now: 4 })).toBe(true)

      expect(convergeRemoteTrackTerminal(db, { trackId: 'settle-converge-track', target: 'completed', occurredAt: 5,
        readActiveConfirmations: () => [] })).toEqual({ state: 'completed' })
      expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('settle-converge-track'))
        .toEqual({ state: 'completed' })
    } finally { db.close() }
  })

  it('does not let another Track’s pending clarification block this Track terminal aggregation', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'event-a', idempotencyKey: 'inbound-a', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'message-a', occurredAt: 1 })
      createRemoteTrack(db, { trackId: 'track-b', eventId: 'event-b', idempotencyKey: 'inbound-b', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'message-b', occurredAt: 1 })
      const conn = getDbConnection(db)
      createClarification(db, { clarificationId: 'clarification-b', channel: 'wechat', identityKey: 'alice', ownerId: 'owner',
        authorizationEpoch: 1, sourceMessageId: 'source-b', parkedInputRef: 'inbox-b', createdAt: 1, expiresAt: 1000,
        version: 1, handle: 'ABCDEFGHJK345', candidates: [{ trackId: 'track-b', option: 1, label: 'Track B', stateAtIssue: 'open' }] })

      expect(readRemoteTrackSourceChildren(conn, 'track-a', () => [])).toEqual([])
      expect(requestRemoteTrackTerminal(db, { trackId: 'track-a', target: 'completed', eventId: 'terminal-a', occurredAt: 2,
        readSourceChildren: (sourceConn, trackId) => readRemoteTrackSourceChildren(sourceConn, trackId, () => []) })).toEqual({ state: 'completed' })
    } finally { db.close() }
  })

  it('is idempotent for events and rejects a parent event from another Track', () => {
    const db = createMemoryAppDb()
    try {
      for (const [trackId, eventId] of [['track-1', 'event-1'], ['track-2', 'event-2']]) {
        createRemoteTrack(db, {
          trackId, eventId, idempotencyKey: `inbound-${trackId}`, channel: 'wechat', identityKey: 'user',
          ownerId: 'owner', authorizationEpoch: 1, rootMessageId: `message-${trackId}`, occurredAt: 1
        })
      }
      const event = { eventId: 'child-event', trackId: 'track-1', eventKind: 'track.turn.started', idempotencyKey: 'turn-start-1', parentEventId: 'event-1', occurredAt: 2 }
      expect(appendRemoteTrackEvent(db, event)).toEqual({ created: true })
      expect(appendRemoteTrackEvent(db, { ...event, eventId: 'duplicate-event' })).toEqual({ created: false })
      expect(() => appendRemoteTrackEvent(db, { ...event, eventId: 'cross-track-event', idempotencyKey: 'cross-track', trackId: 'track-2' }))
        .toThrow('remote Track parent event must belong to the same Track')
    } finally {
      db.close()
    }
  })

  it('keeps the inbound receipt and Track across a SQLite close/reopen', () => {
    const temp = createTempDatabase('remote-track-recovery-')
    try {
      const input = {
        trackId: 'durable-track', eventId: 'durable-event', idempotencyKey: 'durable-inbound', channel: 'feishu' as const,
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 9, rootMessageId: 'platform-message', occurredAt: 100
      }
      createRemoteTrack(temp.db, input)
      temp.db.close()
      const reopened = openDatabase(temp.dbPath)
      try {
        expect(createRemoteTrack(reopened, { ...input, trackId: 'duplicate-track', eventId: 'duplicate-event' }))
          .toEqual({ trackId: 'durable-track', created: false })
        const conn = getDbConnection(reopened)
        expect(conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('durable-track')).toEqual({ state: 'open' })
      } finally {
        reopened.close()
      }
    } finally {
      temp.cleanup()
    }
  })

  it('resolves explicit message references only within exact channel, identity, owner, and epoch', async () => {
    const db = createMemoryAppDb()
    try {
      const { createSession } = await import('./operations')
      const sessionId = createSession(db, { name: 'reference-origin' }).id
      createRemoteTrack(db, {
        trackId: 'track-1', eventId: 'event-1', idempotencyKey: 'inbound-1', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 4, rootMessageId: 'root-1', originSessionId: sessionId, occurredAt: 1
      })
      appendRemoteTrackEvent(db, {
        eventId: 'outbound-1', trackId: 'track-1', eventKind: 'track.outbound.message', idempotencyKey: 'outbound-key-1',
        messageId: 'platform-outbound-1', occurredAt: 2
      })
      mapRemoteTrackMessage(db, { channel: 'wechat', platformMessageId: 'platform-outbound-1', trackId: 'track-1', eventId: 'outbound-1', direction: 'outbound' })
      expect(resolveRemoteTrackMessageReference(db, {
        channel: 'wechat', platformMessageId: 'platform-outbound-1', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 4
      })).toMatchObject({ trackId: 'track-1', eventId: 'outbound-1', state: 'open' })
      expect(resolveRemoteTrackMessageReference(db, {
        channel: 'wechat', platformMessageId: 'platform-outbound-1', identityKey: 'bob', ownerId: 'owner-a', authorizationEpoch: 4
      })).toBeNull()
      expect(resolveRemoteTrackMessageReference(db, {
        channel: 'wechat', platformMessageId: 'platform-outbound-1', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 5
      })).toBeNull()
      expect(resolveRemoteTrackMessageReference(db, {
        channel: 'feishu', platformMessageId: 'platform-outbound-1', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 4
      })).toBeNull()
    } finally {
      db.close()
    }
  })

  it('enforces the ten active Track per identity limit without evicting existing work', () => {
    const db = createMemoryAppDb()
    try {
      for (let index = 0; index < 10; index += 1) {
        createRemoteTrack(db, {
          trackId: `track-${index}`, eventId: `event-${index}`, idempotencyKey: `inbound-${index}`, channel: 'wechat',
          identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: `message-${index}`, occurredAt: index
        })
      }
      expect(() => createRemoteTrack(db, {
        trackId: 'track-over-limit', eventId: 'event-over-limit', idempotencyKey: 'inbound-over-limit', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'message-over-limit', occurredAt: 11
      })).toThrow('remote Track active limit reached')
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 10 })
    } finally {
      db.close()
    }
  })

  it('serializes child insertion against terminal settlement across two SQLite connections', () => {
    const temp = createTempDatabase('remote-track-race-')
    const secondDb = openSqliteDatabase(temp.dbPath, { busyTimeoutMs: 0 })
    try {
      createRemoteTrack(temp.db, {
        trackId: 'race-track', eventId: 'race-root', idempotencyKey: 'race-inbound', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'race-message', occurredAt: 1
      })
      const firstConn = getDbConnection(temp.db)
      expect(() => runInTransaction(firstConn, () => {
        recordRemoteTrackChild(temp.db, { trackId: 'race-track', kind: 'execution-work', childId: 'work-1', state: 'queued', updatedAt: 2 })
        expect(() => requestRemoteTrackTerminal(secondDb, {
          trackId: 'race-track', target: 'completed', eventId: 'race-terminal-first', occurredAt: 3, readSourceChildren: readProjectedChildrenForRepositoryTest
        })).toThrow()
      })).not.toThrow()
      expect(requestRemoteTrackTerminal(secondDb, {
        trackId: 'race-track', target: 'completed', eventId: 'race-terminal-retry', occurredAt: 4, readSourceChildren: readProjectedChildrenForRepositoryTest
      })).toMatchObject({ state: 'processing', rejected: 'unfinished-child-work' })
    } finally {
      secondDb.close()
      temp.cleanup()
    }
  })

  it('allows a successor only from a completed Track in the same identity and authorization scope', () => {
    const db = createMemoryAppDb()
    try {
      const parent = {
        trackId: 'parent', eventId: 'parent-root', idempotencyKey: 'parent-inbound', channel: 'wechat' as const,
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 2, rootMessageId: 'parent-message', occurredAt: 1
      }
      createRemoteTrack(db, parent)
      expect(requestRemoteTrackTerminal(db, { trackId: 'parent', target: 'completed', eventId: 'parent-complete', occurredAt: 2, readSourceChildren: readProjectedChildrenForRepositoryTest }))
        .toEqual({ state: 'completed' })
      expect(createRemoteTrack(db, {
        ...parent, trackId: 'successor', eventId: 'successor-root', idempotencyKey: 'successor-inbound',
        rootMessageId: 'successor-message', parentTrackId: 'parent', occurredAt: 3
      })).toEqual({ trackId: 'successor', created: true })
      expect(() => createRemoteTrack(db, {
        ...parent, trackId: 'wrong-epoch', eventId: 'wrong-epoch-event', idempotencyKey: 'wrong-epoch-key',
        rootMessageId: 'wrong-epoch-message', parentTrackId: 'parent', authorizationEpoch: 3, occurredAt: 4
      })).toThrow('remote Track parent is outside the current identity scope')
    } finally {
      db.close()
    }
  })

  it('fails closed when terminal aggregation cannot read authoritative child sources', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, {
        trackId: 'unverified-track', eventId: 'unverified-root', idempotencyKey: 'unverified-inbound', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'message', occurredAt: 1
      })
      expect(requestRemoteTrackTerminal(db, {
        trackId: 'unverified-track', target: 'completed', eventId: 'unverified-terminal', occurredAt: 2
      })).toEqual({ state: 'reconciliation-blocked', rejected: 'child-source-snapshot-unavailable' })
    } finally {
      db.close()
    }
  })
})
