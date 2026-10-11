import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { resolveClarificationSelection, startClarificationSendAttempt, createClarification, finishClarificationSendAttempt, listPendingClarificationNotices,
  hasPendingClarificationForScope } from './clarificationStore'
import { appendRemoteTrackEvent, createRemoteTrack, claimRemoteTrackWork, mapRemoteTrackMessage, recordRemoteTrackChild,
  resolveRemoteTrackMessageReference, settleRemoteTrackWork } from './remoteTrackStore'
import { getDbConnection } from './sqliteStore'
import { createSession } from './operations'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { appendImInboxMessageWithWakeEvent, parkImInboxMessageForClarification } from './imInbox'
import { listRemoteTrackAttributionCandidates } from '../remote/remoteTrackAttributionService'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { readDeferredCompletionWake } from '../remote/deferredCompletionWake'

function createCandidate(db: ReturnType<typeof createMemoryAppDb>, input: { id: string; state?: 'open' | 'completed'; epoch?: number } = { id: 'candidate-1' }) {
  const state = input.state ?? 'open'
  createRemoteTrack(db, {
    trackId: input.id, eventId: `${input.id}-root`, idempotencyKey: `${input.id}-inbound`, channel: 'wechat',
    identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: input.epoch ?? 1,
    rootMessageId: `${input.id}-message`, occurredAt: 1
  })
  if (state === 'completed') {
    const conn = getDbConnection(db)
    conn.prepare("UPDATE remote_tracks SET state='completed' WHERE track_id=?").run(input.id)
  }
}

function createPending(db: ReturnType<typeof createMemoryAppDb>, candidates = [{ trackId: 'candidate-1', option: 1, label: '继续知乎搜索', stateAtIssue: 'open' }]) {
  return createClarification(db, {
    clarificationId: 'clarification-1', channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
    sourceMessageId: 'source-message-1', parkedInputRef: 'inbox-message-1', createdAt: 100, expiresAt: 400,
    version: 1, handle: 'ABCDEFGHJK345', candidates
  })
}

function assignTrackOriginSession(db: ReturnType<typeof createMemoryAppDb>, trackId: string): string {
  const session = createSession(db, { name: `origin-${trackId}`, metadata: { source: 'wechat', wechatMeta: { userId: 'alice' } } })
  getDbConnection(db).prepare('UPDATE remote_tracks SET origin_session_id=? WHERE track_id=?').run(session.id, trackId)
  return session.id
}

describe('durable Track clarification protocol', () => {
  it('detects pending clarification only in the current identity, owner, epoch, and TTL scope', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db)
      createPending(db)
      expect(hasPendingClarificationForScope(db, { channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1, now: 150 })).toBe(true)
      expect(hasPendingClarificationForScope(db, { channel: 'wechat', identityKey: 'alice', ownerId: 'other-owner', authorizationEpoch: 1, now: 150 })).toBe(false)
      expect(hasPendingClarificationForScope(db, { channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1, now: 400 })).toBe(false)
      getDbConnection(db).prepare("UPDATE remote_authorization_epochs SET epoch=2 WHERE channel='wechat'").run()
      expect(hasPendingClarificationForScope(db, { channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1, now: 150 })).toBe(false)
    } finally { db.close() }
  })

  it('recovers pending work-terminal notices only for the active channel authorization epoch', () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'work-terminal-notice' }).id
      createCandidate(db)
      createPending(db)
      const conn = getDbConnection(db)
      conn.prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,clarification_id,state,created_at,updated_at)
        VALUES('work-notice','source','candidate-1','source-message-1','clarification-1','queued',1,1)`).run()
      conn.prepare("UPDATE remote_track_work_queue SET session_id=? WHERE work_id='work-notice'").run(sessionId)
      recordRemoteTrackChild(db, { trackId: 'candidate-1', kind: 'execution-work', childId: 'work-notice', state: 'queued', updatedAt: 1 })
      const claim = claimRemoteTrackWork(db, { workerId: 'worker', now: 10, leaseMs: 100, workId: 'work-notice' })!
      settleRemoteTrackWork(db, { workId: claim.workId, workerId: claim.workerId, attempt: claim.attempt, state: 'needs-reconciliation',
        now: 20, noticeText: '请检查桌面会话。' })

      expect(listPendingClarificationNotices(db, 'wechat')).toContainEqual({ clarificationId: 'clarification-1', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner-a', sessionId, eventId: 'track-work-terminal:work-notice:needs-reconciliation',
        stage: 'failed', text: '请检查桌面会话。' })
      conn.prepare("UPDATE remote_authorization_epochs SET epoch=2 WHERE channel='wechat'").run()
      expect(listPendingClarificationNotices(db, 'wechat')).toEqual([])
    } finally { db.close() }
  })

  it('does not resolve before an attempt starts, then atomically consumes input and enqueues one work item before send ack', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db, { id: 'candidate-1' })
      assignTrackOriginSession(db, 'candidate-1')
      const originSessionId = assignTrackOriginSession(db, 'candidate-1')
      createPending(db)
      const input = {
        handle: 'ABCDEFGHJK345', option: 1, channel: 'wechat' as const, identityKey: 'alice', ownerId: 'owner-a',
        authorizationEpoch: 1, replyMessageId: 'reply-1', trackEventId: 'consume-event-1', workId: 'work-1', now: 150
      }
      expect(resolveClarificationSelection(db, input)).toEqual({ kind: 'not-sent' })
      expect(getDbConnection(db).prepare("SELECT state FROM remote_clarifications WHERE clarification_id='clarification-1'").get()).toEqual({ state: 'pending' })
      startClarificationSendAttempt(db, { sendAttemptId: 'attempt-1', clarificationId: 'clarification-1', version: 1, startedAt: 120 })
      expect(resolveClarificationSelection(db, input)).toEqual({ kind: 'resolved', trackId: 'candidate-1', workId: 'work-1' })
      expect(resolveClarificationSelection(db, { ...input, replyMessageId: 'duplicate-reply', trackEventId: 'duplicate-event', workId: 'duplicate-work' }))
        .toEqual({ kind: 'already-resolved', trackId: 'candidate-1', workId: 'work-1' })
      const conn = getDbConnection(db)
      expect(conn.prepare("SELECT state,resolved_by_message_id,selected_track_id FROM remote_clarifications WHERE clarification_id='clarification-1'").get())
        .toEqual({ state: 'resolved', resolved_by_message_id: 'reply-1', selected_track_id: 'candidate-1' })
      expect(conn.prepare("SELECT COUNT(*) AS count FROM remote_track_work_queue WHERE source_key='clarification:clarification-1'").get()).toEqual({ count: 1 })
      expect(conn.prepare("SELECT session_id FROM remote_track_work_queue WHERE source_key='clarification:clarification-1'").get()).toEqual({ session_id: originSessionId })
      expect(conn.prepare("SELECT event_kind FROM remote_track_events WHERE event_id='consume-event-1'").get()).toEqual({ event_kind: 'track.inbound.consumed' })
    } finally {
      db.close()
    }
  })

  it('permits a valid handle reply after send rejected because the user reply proves prompt reachability', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db)
      assignTrackOriginSession(db, 'candidate-1')
      createPending(db)
      startClarificationSendAttempt(db, { sendAttemptId: 'attempt-1', clarificationId: 'clarification-1', version: 1, startedAt: 120 })
      finishClarificationSendAttempt(db, { sendAttemptId: 'attempt-1', state: 'send-rejected', finishedAt: 130 })
      expect(resolveClarificationSelection(db, {
        handle: 'ABCDEFGHJK345', option: 1, channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        replyMessageId: 'reply-1', trackEventId: 'consume-event-1', workId: 'work-1', now: 150
      })).toMatchObject({ kind: 'resolved', trackId: 'candidate-1' })
      expect(getDbConnection(db).prepare("SELECT state FROM remote_clarification_send_attempts WHERE send_attempt_id='attempt-1'").get())
        .toEqual({ state: 'send-rejected' })
    } finally {
      db.close()
    }
  })

  it('keeps send callbacks scoped to their attempt and makes old-version handles stale', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db)
      createCandidate(db, { id: 'candidate-2' })
      assignTrackOriginSession(db, 'candidate-1')
      assignTrackOriginSession(db, 'candidate-2')
      createPending(db, [
        { trackId: 'candidate-1', option: 1, label: '候选甲', stateAtIssue: 'open' },
        { trackId: 'candidate-2', option: 2, label: '候选乙', stateAtIssue: 'open' }
      ])
      startClarificationSendAttempt(db, { sendAttemptId: 'attempt-v1', clarificationId: 'clarification-1', version: 1, startedAt: 120 })
      const v2 = createClarification(db, {
        clarificationId: 'clarification-1', channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        sourceMessageId: 'source-message-1', parkedInputRef: 'inbox-message-1', createdAt: 100, expiresAt: 400,
        version: 2, handle: 'BCDEFGHJK3467', candidates: [{ trackId: 'candidate-2', option: 1, label: '候选乙', stateAtIssue: 'open' }]
      })
      expect(v2).toMatchObject({ version: 2, handle: 'BCDEFGHJK3467' })
      expect(resolveClarificationSelection(db, {
        handle: 'ABCDEFGHJK345', option: 1, channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        replyMessageId: 'late-reply', trackEventId: 'late-event', workId: 'late-work', now: 150
      })).toEqual({ kind: 'stale' })
      finishClarificationSendAttempt(db, { sendAttemptId: 'attempt-v1', state: 'send-fulfilled', finishedAt: 160, platformMessageId: 'old-prompt' })
      startClarificationSendAttempt(db, { sendAttemptId: 'attempt-v2', clarificationId: 'clarification-1', version: 2, startedAt: 170 })
      expect(resolveClarificationSelection(db, {
        handle: 'BCDEFGHJK3467', option: 1, channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        replyMessageId: 'current-reply', trackEventId: 'current-event', workId: 'current-work', now: 180
      })).toMatchObject({ kind: 'resolved', trackId: 'candidate-2' })
      expect(resolveClarificationSelection(db, {
        handle: 'ABCDEFGHJK345', option: 1, channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        replyMessageId: 'late-after-resolve', trackEventId: 'late-after-resolve-event', workId: 'late-after-resolve-work', now: 190
      })).toEqual({ kind: 'stale' })
      const conn = getDbConnection(db)
      expect(conn.prepare("SELECT state FROM remote_clarification_versions WHERE clarification_id='clarification-1' AND version=1").get()).toEqual({ state: 'superseded' })
      expect(conn.prepare("SELECT state,platform_message_id FROM remote_clarification_send_attempts WHERE send_attempt_id='attempt-v1'").get())
        .toEqual({ state: 'send-fulfilled', platform_message_id: 'old-prompt' })
      expect(conn.prepare("SELECT state,current_version FROM remote_clarifications WHERE clarification_id='clarification-1'").get())
        .toEqual({ state: 'resolved', current_version: 2 })
    } finally {
      db.close()
    }
  })

  it('reuses the current handle when a retry republishes the identical candidate snapshot', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db)
      const candidates = [{ trackId: 'candidate-1', option: 1, label: '继续知乎搜索', stateAtIssue: 'open' as const }]
      const first = createPending(db, candidates)
      const retry = createClarification(db, {
        clarificationId: 'clarification-1', channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        sourceMessageId: 'source-message-1', parkedInputRef: 'inbox-message-1', createdAt: 110, expiresAt: 400,
        version: 2, handle: 'BCDEFGHJK3467', candidates
      })
      expect(retry).toMatchObject({ version: first.version, handle: first.handle, created: false })
      expect(getDbConnection(db).prepare("SELECT current_version FROM remote_clarifications WHERE clarification_id='clarification-1'").get())
        .toEqual({ current_version: 1 })
    } finally {
      db.close()
    }
  })

  it('rejects owner or epoch mismatch and expires parked input without creating work', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db)
      const sessionId = createSession(db, { name: 'clarification-expiry' }).id
      parkImInboxMessageForClarification(db, {
        sessionId, channel: 'wechat', queueScope: buildImQueueScope('wechat', sessionId), channelMessageId: 'source-message-1',
        content: 'ambiguous original', clarificationId: 'clarification-1', identityKey: 'alice', ownerId: 'owner-a',
        authorizationEpoch: 1, handle: 'ABCDEFGHJK345',
        candidates: [{ trackId: 'candidate-1', option: 1, label: '继续知乎搜索', stateAtIssue: 'open' }],
        expiresAt: 400, now: 100
      })
      startClarificationSendAttempt(db, { sendAttemptId: 'attempt-1', clarificationId: 'clarification-1', version: 1, startedAt: 120 })
      const base = {
        handle: 'ABCDEFGHJK345', option: 1, channel: 'wechat' as const, identityKey: 'alice', ownerId: 'owner-a',
        authorizationEpoch: 1, replyMessageId: 'reply', trackEventId: 'event', workId: 'work', now: 150
      }
      expect(resolveClarificationSelection(db, { ...base, ownerId: 'owner-b' })).toEqual({ kind: 'unauthorized' })
      expect(resolveClarificationSelection(db, { ...base, authorizationEpoch: 2 })).toEqual({ kind: 'unauthorized' })
      expect(resolveClarificationSelection(db, { ...base, now: 400 })).toEqual({ kind: 'expired' })
      expect(getDbConnection(db).prepare("SELECT state FROM remote_clarifications WHERE clarification_id='clarification-1'").get()).toEqual({ state: 'expired' })
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_work_queue').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('creates a session-bound successor for a completed Track and preserves follow-up and async recovery', () => {
    const db = createMemoryAppDb()
    try {
      createCandidate(db, { id: 'completed-parent', state: 'completed' })
      const originSessionId = assignTrackOriginSession(db, 'completed-parent')
      createPending(db, [{ trackId: 'completed-parent', option: 1, label: '继续已完成任务', stateAtIssue: 'completed' }])
      startClarificationSendAttempt(db, { sendAttemptId: 'attempt-1', clarificationId: 'clarification-1', version: 1, startedAt: 120 })
      const result = resolveClarificationSelection(db, {
        handle: 'ABCDEFGHJK345', option: 1, channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        replyMessageId: 'reply-1', trackEventId: 'successor-event', workId: 'work-1', successorTrackId: 'successor-track', now: 150
      })
      expect(result).toEqual({ kind: 'resolved', trackId: 'successor-track', workId: 'work-1', parentTrackId: 'completed-parent' })
      expect(getDbConnection(db).prepare("SELECT state,parent_track_id,origin_session_id FROM remote_tracks WHERE track_id='successor-track'").get())
        .toEqual({ state: 'open', parent_track_id: 'completed-parent', origin_session_id: originSessionId })
      expect(listRemoteTrackAttributionCandidates(db, { channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1 }))
        .toContainEqual(expect.objectContaining({ trackId: 'successor-track' }))
      appendRemoteTrackEvent(db, { eventId: 'successor-outbound-event', trackId: 'successor-track', eventKind: 'track.outbound.message',
        idempotencyKey: 'successor-outbound', messageId: 'successor-platform-message', occurredAt: 151 })
      mapRemoteTrackMessage(db, { channel: 'wechat', platformMessageId: 'successor-platform-message', trackId: 'successor-track',
        eventId: 'successor-outbound-event', direction: 'outbound' })
      expect(resolveRemoteTrackMessageReference(db, { channel: 'wechat', platformMessageId: 'successor-platform-message',
        identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1 })).toMatchObject({ trackId: 'successor-track', direction: 'outbound' })
      const resumed = appendImInboxMessageWithWakeEvent(db, { sessionId: originSessionId, channel: 'wechat',
        queueScope: buildImQueueScope('wechat', originSessionId), channelMessageId: 'source-message-1', content: '恢复后的后续任务',
        trackId: 'successor-track', trackEventId: 'successor-event' })
      const todo = createDeferredTodoStore(db).create({ todoId: 'successor-deferred-todo', invocationId: 'successor-deferred-invocation',
        channel: 'wechat', identityKey: 'alice', ownerId: 'owner-a', authorizationEpoch: 1,
        rule: { ruleId: 'write', factsHash: 'b'.repeat(64) }, workflowId: 'workflow', taskId: 'task', stepId: 'publish',
        planRevision: 1, originSessionId, trackId: 'successor-track', createdAt: 160, expiresAt: 10_000 }).todo
      const results = createDeferredExecutionResultStore(db)
      results.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey: 'successor-dispatch', now: 161 })
      results.commitResult(todo.todoId, { kind: 'completed', outputRef: 'successor-result' }, 162)
      createDeferredEnvelopeStore(db).put({ invocationId: todo.invocationId, requestId: 'successor-request', turnId: 'successor-turn',
        toolCallId: 'successor-tool-call', toolName: 'write_file', canonicalArgs: {}, contentVersions: {}, now: 161,
        executionContext: { currentUserMessageId: resumed.messageId, messageId: 'source-message-1' } })
      expect(readDeferredCompletionWake(db, todo.todoId)?.trackContext).toMatchObject({ trackId: 'successor-track',
        originSessionId, attributionEventId: 'successor-event' })
      expect(getDbConnection(db).prepare("SELECT state FROM remote_tracks WHERE track_id='completed-parent'").get()).toEqual({ state: 'completed' })
    } finally {
      db.close()
    }
  })
})
