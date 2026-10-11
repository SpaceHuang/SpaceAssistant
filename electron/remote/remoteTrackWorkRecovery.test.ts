import { describe, expect, it } from 'vitest'
import { canResumePreparedRemoteTurn, decideRemoteTrackWorkRecovery, inspectRemoteTrackWorkRecovery, isRemoteTrackWorkSettled, settleRemoteTrackWorkFromTurn, type RemoteTrackWorkRecoveryFacts } from './remoteTrackWorkRecovery'
import { createMemoryAppDb } from '../database/testHelpers'
import { appendRemoteTrackEvent, bindRemoteTrackToTurn, claimRemoteTrackWork, createRemoteTrack, recordRemoteTrackChild } from '../database/remoteTrackStore'
import { getDbConnection } from '../database/sqliteStore'
import { appendMessage, createPersistedTurn, createSession } from '../database/operations'
import { acceptTurnContext } from '../database/acceptedTurnStorage'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { createClarification } from '../database/clarificationStore'
import { recordTrackModelMessage, buildTrackModelInputViewRef } from './trackModelInputViewStore'

const base: RemoteTrackWorkRecoveryFacts = {
  workState: 'claimed', hasStableMapping: true, frozenConfigAvailable: true, modelInputViewAvailable: true,
  startupRecoveryTerminalized: false, turnState: 'prepared'
}

describe('remote Track work recovery decision', () => {
  it.each([
    ['completed', 'completed'], ['parked', 'completed'], ['failed', 'needs-reconciliation'],
    ['cancelled', 'needs-reconciliation'], ['interrupted', 'needs-reconciliation'], ['outcome-unknown', 'needs-reconciliation']
  ] as const)('settles terminal turn outcome %s through the shared recovery owner', (outcome, expectedState) => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: `settle-${outcome}`, eventId: `settle-root-${outcome}`, idempotencyKey: `settle-key-${outcome}`,
        channel: 'wechat', identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: `root-${outcome}`, occurredAt: 1 })
      getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,created_at,updated_at)
        VALUES(?,?,?,?,'queued',1,1)`).run(`work-${outcome}`, `source-${outcome}`, `settle-${outcome}`, `message-${outcome}`)
      recordRemoteTrackChild(db, { trackId: `settle-${outcome}`, kind: 'execution-work', childId: `work-${outcome}`, state: 'queued', updatedAt: 1 })
      const claim = claimRemoteTrackWork(db, { workerId: 'worker', now: 2, leaseMs: 100, workId: `work-${outcome}` })!

      expect(settleRemoteTrackWorkFromTurn(db, { claim, outcome, now: 3, noticeText: 'check result' })).toBe(true)
      expect(getDbConnection(db).prepare('SELECT state FROM remote_track_work_queue WHERE work_id=?').get(`work-${outcome}`))
        .toEqual({ state: expectedState })
    } finally { db.close() }
  })

  it('does not let a stale work lease settle a terminal turn', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: 'stale-settle-track', eventId: 'stale-settle-root', idempotencyKey: 'stale-settle-key',
        channel: 'wechat', identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'stale-settle-message', occurredAt: 1 })
      getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,created_at,updated_at)
        VALUES('stale-settle-work','stale-settle-source','stale-settle-track','stale-settle-message','queued',1,1)`).run()
      recordRemoteTrackChild(db, { trackId: 'stale-settle-track', kind: 'execution-work', childId: 'stale-settle-work', state: 'queued', updatedAt: 1 })
      const oldClaim = claimRemoteTrackWork(db, { workerId: 'old-worker', now: 2, leaseMs: 5, workId: 'stale-settle-work' })!
      const newClaim = claimRemoteTrackWork(db, { workerId: 'new-worker', now: 8, leaseMs: 100, workId: 'stale-settle-work' })!

      expect(settleRemoteTrackWorkFromTurn(db, { claim: oldClaim, outcome: 'completed', now: 9 })).toBe(false)
      expect(settleRemoteTrackWorkFromTurn(db, { claim: newClaim, outcome: 'completed', now: 9 })).toBe(true)
    } finally { db.close() }
  })

  it('loads a queued clarification work item from durable state and permits preparation only without a prior turn mapping', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: 'queued-track', eventId: 'queued-root', idempotencyKey: 'queued-inbound', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'queued-message', occurredAt: 1 })
      getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,clarification_id,source_message_id,state,created_at,updated_at)
        VALUES('queued-work','queued-work-source','queued-track',NULL,'queued-message','queued',1,1)`).run()

      expect(inspectRemoteTrackWorkRecovery(db, 'queued-work')).toEqual({
        workId: 'queued-work', decision: { kind: 'prepare-new-turn' }, facts: {
          workState: 'queued', hasStableMapping: false, frozenConfigAvailable: false, modelInputViewAvailable: false,
          startupRecoveryTerminalized: false, turnState: 'absent', hasRecoverableAsyncApproval: false, evidenceConsistent: true
        }
      })
      expect(inspectRemoteTrackWorkRecovery(db, 'missing-work')).toBeNull()
    } finally { db.close() }
  })

  it('reconciles instead of preparing a new turn when durable turn state is unknown', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'unknown-turn-state' })
      appendMessage(db, { id: 'unknown-turn-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
      createRemoteTrack(db, { trackId: 'unknown-state-track', eventId: 'unknown-state-root', idempotencyKey: 'unknown-state-inbound',
        channel: 'wechat', identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'unknown-state-message', occurredAt: 1 })
      createPersistedTurn(db, { turnId: 'unknown-state-turn', requestId: 'unknown-state-request', sessionId: session.id,
        assistantMessageId: 'unknown-turn-assistant', state: 'future-state' })
      getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,turn_id,created_at,updated_at)
        VALUES('unknown-state-work','unknown-state-source','unknown-state-track','unknown-state-message','queued','unknown-state-turn',1,1)`).run()

      expect(inspectRemoteTrackWorkRecovery(db, 'unknown-state-work')).toMatchObject({
        decision: { kind: 'reconcile' }, facts: { turnState: 'absent', evidenceConsistent: false }
      })
    } finally { db.close() }
  })

  it.each(['track.inbound.consumed', 'track.inbound.accepted'] as const)(
    'resumes prepared work when %s attribution and the reconstructed Track model view match the immutable mapping', (attributionKind) => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'prepared-work-recovery' })
      const userMessageId = 'accepted-user-message'
      const assistantMessageId = 'prepared-assistant-message'
      appendMessage(db, { id: userMessageId, sessionId: session.id, role: 'user', content: '继续任务', timestamp: 1, status: 'sent' })
      appendMessage(db, { id: assistantMessageId, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
      createRemoteTrack(db, { trackId: 'prepared-track', eventId: 'prepared-root', idempotencyKey: 'prepared-root-key', channel: 'wechat',
        identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'prepared-platform-root', originSessionId: session.id, occurredAt: 1 })
      createClarification(db, { clarificationId: 'prepared-clarification', channel: 'wechat', identityKey: 'alice', ownerId: 'owner',
        authorizationEpoch: 1, sourceMessageId: 'prepared-platform-source', parkedInputRef: 'parked-input-ref', createdAt: 1, expiresAt: 10_000,
        version: 1, handle: 'ABCDEFGHJK345', candidates: [{ trackId: 'prepared-track', option: 1, label: '任务', stateAtIssue: 'open' }] })
      appendRemoteTrackEvent(db, { eventId: 'prepared-consumed-event', trackId: 'prepared-track', eventKind: attributionKind,
        idempotencyKey: 'clarification:prepared-clarification', messageId: 'prepared-platform-source', occurredAt: 2 })

      const requestId = 'prepared-work-request'
      const turnId = 'prepared-work-turn'
      const config = { lane: 'wechat' as const, model: 'model-1', llmServiceId: 'service-1', thinkingEffort: 'low' as const }
      createPersistedTurn(db, { turnId, requestId, sessionId: session.id, userMessageId, assistantMessageId, state: 'prepared',
        startToken: 'prepared-work-start', executionConfig: config })
      bindRemoteTrackToTurn(db, { trackId: 'prepared-track', turnId, sessionId: session.id, channel: 'wechat', identityKey: 'alice',
        ownerId: 'owner', authorizationEpoch: 1, eventId: 'prepared-turn-bound', occurredAt: 3 })
      recordTrackModelMessage(db, { trackId: 'prepared-track', eventId: 'prepared-model-user', idempotencyKey: 'prepared-model-user-key',
        sessionId: session.id, messageId: userMessageId, invocationId: turnId, occurredAt: 4, parentEventId: 'prepared-consumed-event' })
      const view = buildTrackModelInputViewRef(db, { trackId: 'prepared-track', sessionId: session.id, acceptedUserMessageId: userMessageId,
        currentInvocationId: turnId, channel: 'wechat', identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1,
        rootMessageId: 'prepared-platform-root', attributionEventId: 'prepared-consumed-event' })
      acceptTurnContext(db, createAcceptedTurn({ turnId, requestId, sessionId: session.id, lane: 'wechat', startToken: 'prepared-work-start',
        currentUserMessageId: userMessageId, transcriptVersion: 0, config }))
      getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,clarification_id,source_message_id,state,
        session_id,request_id,turn_id,user_message_id,model_view_version,attempt_count,lease_owner,lease_expires_at,created_at,updated_at)
        VALUES('prepared-work','clarification:prepared-clarification','prepared-track','prepared-clarification','prepared-platform-source',
          'claimed',?,?,?, ?,?,1,'worker',1000,1,4)`).run(session.id, requestId, turnId, userMessageId, view.viewVersion)

      expect(inspectRemoteTrackWorkRecovery(db, 'prepared-work')?.decision).toEqual({ kind: 'resume-prepared-turn' })
      getDbConnection(db).prepare("UPDATE remote_track_work_queue SET model_view_version='view-tampered' WHERE work_id='prepared-work'").run()
      expect(inspectRemoteTrackWorkRecovery(db, 'prepared-work')).toMatchObject({
        decision: { kind: 'reconcile' }, facts: { hasStableMapping: true, frozenConfigAvailable: true, modelInputViewAvailable: false }
      })
    } finally { db.close() }
    })

  it('treats completed and reconciliation-required work as settled for inbox recovery', () => {
    expect(isRemoteTrackWorkSettled('completed')).toBe(true)
    expect(isRemoteTrackWorkSettled('needs-reconciliation')).toBe(true)
    expect(isRemoteTrackWorkSettled('queued')).toBe(false)
    expect(isRemoteTrackWorkSettled('claimed')).toBe(false)
    expect(isRemoteTrackWorkSettled(undefined)).toBe(false)
  })

  it.each(['pending', 'dispatching'] as const)(
    'delegates waiting-confirm recovery to the existing async approval flow when its todo is %s',
    (todoState) => {
      const db = createMemoryAppDb()
      try {
        const session = createSession(db, { name: `async-todo-${todoState}` })
        appendMessage(db, { id: `async-todo-assistant-${todoState}`, sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
        createRemoteTrack(db, { trackId: `async-track-${todoState}`, eventId: `async-root-${todoState}`, idempotencyKey: `async-root-key-${todoState}`,
          channel: 'wechat', identityKey: 'alice', ownerId: 'owner', authorizationEpoch: 1,
          rootMessageId: `async-message-${todoState}`, originSessionId: session.id, occurredAt: 1 })
        createPersistedTurn(db, { turnId: `async-turn-${todoState}`, requestId: `async-request-${todoState}`, sessionId: session.id,
          assistantMessageId: `async-todo-assistant-${todoState}`, state: 'waiting-confirm' })
        getDbConnection(db).prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,
          session_id,request_id,turn_id,user_message_id,model_view_version,attempt_count,lease_owner,lease_expires_at,created_at,updated_at)
          VALUES(?,?,?,?, 'claimed',?,?,?,?,?,1,'worker',1000,1,2)`)
          .run(`async-work-${todoState}`, `async-source-${todoState}`, `async-track-${todoState}`, `async-message-${todoState}`,
            session.id, `async-request-${todoState}`, `async-turn-${todoState}`, `async-user-${todoState}`, 'view-1')
        getDbConnection(db).prepare(`INSERT INTO deferred_todos(todo_id,invocation_id,channel,identity_key,owner_id,authorization_epoch,
          rule_id,facts_hash,workflow_id,task_id,step_id,plan_revision,origin_session_id,state,created_at,expires_at,updated_at,track_id)
          VALUES(?,?,'wechat','alice','owner',1,'rule','facts','workflow','task','step',1,?,?,1,10000,1,?)`)
          .run(`async-todo-${todoState}`, `async-invocation-${todoState}`, session.id, todoState, `async-track-${todoState}`)

        expect(inspectRemoteTrackWorkRecovery(db, `async-work-${todoState}`)?.decision).toEqual({ kind: 'delegate-async-recovery' })
      } finally { db.close() }
    }
  )

  it('只允许复用身份、配置和 Track 输入视图都固定的 prepared turn', () => {
    const accepted = { turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', currentUserMessageId: 'message-1',
      config: { lane: 'wechat', model: 'm1', llmServiceId: 'svc-1', thinkingEffort: 'low' } }
    const base = { turnState: 'prepared', turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', userMessageId: 'message-1',
      turnConfig: { ...accepted.config }, accepted }
    expect(canResumePreparedRemoteTurn(base)).toBe(true)
    expect(canResumePreparedRemoteTurn({ ...base, accepted: { ...accepted, currentUserMessageId: 'different-message' } })).toBe(false)
    expect(canResumePreparedRemoteTurn({ ...base, turnConfig: { ...accepted.config, model: 'm2' } })).toBe(false)
    expect(canResumePreparedRemoteTurn({ ...base, clarificationWorkMapping: { sessionId: 'session-1', requestId: 'request-1',
      turnId: 'turn-1', userMessageId: 'message-1', modelViewVersion: null } })).toBe(false)
  })

  it('resumes only the original prepared turn when frozen input and execution guards are intact', () => {
    expect(decideRemoteTrackWorkRecovery(base)).toEqual({ kind: 'resume-prepared-turn' })
  })

  it('does not reconfigure a configuring turn or resume a prepared turn without its frozen view', () => {
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'configuring' })).toEqual({ kind: 'fail-before-start' })
    expect(decideRemoteTrackWorkRecovery({ ...base, modelInputViewAvailable: false })).toEqual({ kind: 'reconcile' })
    expect(decideRemoteTrackWorkRecovery({ ...base, startupRecoveryTerminalized: true })).toEqual({ kind: 'reconcile' })
  })

  it('never replays an executing turn and reconciles based on canonical terminal evidence', () => {
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'executing', dispatchOutcome: 'unknown' }))
      .toEqual({ kind: 'terminalize-outcome-unknown' })
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'executing', canonicalTerminal: 'completed' }))
      .toEqual({ kind: 'ack-completed' })
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'executing', canonicalTerminal: 'parked' }))
      .toEqual({ kind: 'ack-parked' })
  })

  it('acks already terminal work without invoking the runtime', () => {
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'terminal', canonicalTerminal: 'completed' }))
      .toEqual({ kind: 'ack-completed' })
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'terminal', canonicalTerminal: 'parked' }))
      .toEqual({ kind: 'ack-parked' })
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'terminal', canonicalTerminal: 'failed' }))
      .toEqual({ kind: 'ack-failed' })
  })

  it('reconciles absent mappings and inconsistent terminal facts instead of retrying', () => {
    expect(decideRemoteTrackWorkRecovery({ ...base, hasStableMapping: false })).toEqual({ kind: 'reconcile' })
    expect(decideRemoteTrackWorkRecovery({ ...base, turnState: 'terminal' })).toEqual({ kind: 'reconcile' })
    expect(decideRemoteTrackWorkRecovery({ ...base, workState: 'completed', turnState: 'prepared' })).toEqual({ kind: 'reconcile' })
  })
})
