import { describe, expect, it } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { appendMessage, createSession, getMessage } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { claimSessionExecution, commitSessionTranscript, markSessionExecutionStarted, markSessionExecutionUncertain, readSessionTranscript, reconcileUncertainSessionTranscript, recoverSessionExecutionForTarget } from '../database/sessionTranscript'
import { getPersistedTurn, listPersistedTurns } from '../database/operations'
import { openDatabase } from '../database'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { TurnRuntime } from '../turnRuntime'
import { hasUnfinishedStartupProjections, recoverTurnCoordinatorForStartup, restorePersistedTurnSnapshotsForStartup } from '../sessionStorage/recoveryHelpers'
import { reconcileStartupSessionTranscripts } from '../sessionStorage/recovery'
import { SqliteAgentHistory } from './sqliteAgentHistory'

function createUncertainCommittedSession() {
  const db = createMemoryAppDb()
  const owner = claimSessionExecution(db, { sessionId: 'startup-session', turnId: 'startup-turn', ownerId: 'startup-process' })
  if (!owner.acquired) throw new Error('test setup failed to claim session')
  commitSessionTranscript(db, { sessionId: 'startup-session', turnId: 'startup-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'accepted' }] })
  markSessionExecutionUncertain(db, { sessionId: 'startup-session', turnId: 'startup-turn', ownerId: 'startup-process', generation: owner.generation })
  return db
}

async function createUncertainProtocol2Session() {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: 'startup-protocol-2', model: 'test' })
  const turnId = 'startup-protocol-2-turn'
  const owner = claimSessionExecution(db, { sessionId: session.id, turnId, ownerId: 'startup-protocol-2-owner' })
  if (!owner.acquired) throw new Error('test setup failed to claim protocol 2 session')
  markSessionExecutionStarted(db, { sessionId: session.id, turnId, ownerId: 'startup-protocol-2-owner', generation: owner.generation })
  const userMessage = { role: 'user', id: 'startup-protocol-2-user', content: 'accepted' }
  const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
  await history.appendBatch([{
    invocationId: turnId, turnId, sequence: 1, schemaVersion: 1, eventId: 'startup-protocol-2-context',
    idempotencyKey: 'startup-protocol-2-context', kind: 'invocation-context-committed', payload: {
      contextProtocol: 2, baseVersion: 0, inputMessages: [userMessage], failureInputMessages: [userMessage],
      messages: [userMessage], scope: { kind: 'session', sessionId: session.id }, system: ''
    }
  }], 0)
  await history.appendBatch([{
    invocationId: turnId, turnId, sequence: 2, schemaVersion: 1, eventId: 'startup-protocol-2-terminal',
    idempotencyKey: 'startup-protocol-2-terminal', kind: 'invocation-completed',
    payload: { status: 'completed', contextSelection: { contextProtocol: 2, target: 'working' } }
  }], 1, { sessionId: session.id, baseVersion: 0, outcome: 'completed', protocol: 2,
    contextSelection: { contextProtocol: 2, target: 'working' },
    executionLease: { sessionId: session.id, turnId, ownerId: 'startup-protocol-2-owner', generation: owner.generation } })
  if (!markSessionExecutionUncertain(db, { sessionId: session.id, turnId, ownerId: 'startup-protocol-2-owner', generation: owner.generation })) {
    throw new Error('test setup failed to mark protocol 2 commit uncertain')
  }
  return { db, sessionId: session.id, turnId, userMessage }
}

describe('startup transcript reconciliation ordering', () => {
  it('allows the next turn after a process-restart terminal is recorded, preserving history as the transcript source', async () => {
    const temp = createTempDatabase('restart-resume-')
    const db = temp.db
    const session = createSession(db, { name: 'restart-resume', model: 'test' })
    const seedOwner = claimSessionExecution(db, { sessionId: session.id, turnId: 'seed-turn', ownerId: 'seed-owner' })
    if (!seedOwner.acquired) throw new Error('test setup failed to claim seed turn')
    commitSessionTranscript(db, { sessionId: session.id, turnId: 'seed-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', id: 'seed-user', content: 'seed' }] })
    markSessionExecutionStarted(db, { sessionId: session.id, turnId: 'seed-turn', ownerId: 'seed-owner', generation: seedOwner.generation })
    markSessionExecutionUncertain(db, { sessionId: session.id, turnId: 'seed-turn', ownerId: 'seed-owner', generation: seedOwner.generation })
    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_500)).toMatchObject({ reconciled: 1 })
    const owner = claimSessionExecution(db, { sessionId: session.id, turnId: 'restart-turn', ownerId: 'old-owner' })
    if (!owner.acquired) throw new Error('test setup failed to claim restart turn')
    markSessionExecutionStarted(db, { sessionId: session.id, turnId: 'restart-turn', ownerId: 'old-owner', generation: owner.generation })
    const restartProjection = createTurnCoordinatorStorage(db).prepareAtomic?.({
      user: { id: 'restart-user', sessionId: session.id, role: 'user', content: 'continue task', timestamp: 2, status: 'sent' },
      assistant: { id: 'restart-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 3, status: 'streaming' },
      turn: { turnId: 'restart-turn', requestId: 'restart-request', sessionId: session.id, userMessageId: 'restart-user', assistantMessageId: 'restart-assistant', state: 'executing' }
    })
    if (!restartProjection) throw new Error('test setup failed to create restart projection')
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    const userMessage = { role: 'user' as const, id: 'restart-user', content: 'continue task' }
    const toolCall = { id: 'restart-tool', name: 'write_file', input: { path: 'x' } }
    await history.appendBatch([
      { invocationId: 'restart-turn', turnId: 'restart-turn', sequence: 2, schemaVersion: 1, eventId: 'restart-context', idempotencyKey: 'restart-context', kind: 'invocation-context-committed', payload: {
        contextProtocol: 2, inputMode: 'delta', baseVersion: 1, inputMessages: [userMessage], failureInputMessages: [userMessage], messages: [userMessage],
        scope: { kind: 'session', sessionId: session.id }
      } },
      { invocationId: 'restart-turn', turnId: 'restart-turn', sequence: 3, schemaVersion: 1, eventId: 'restart-answer', idempotencyKey: 'restart-answer', kind: 'model-response-committed', payload: {
        message: { role: 'assistant', id: 'restart-assistant', content: '', toolCalls: [toolCall] }
      } },
      { invocationId: 'restart-turn', turnId: 'restart-turn', sequence: 4, schemaVersion: 1, eventId: 'restart-tool-start', idempotencyKey: 'restart-tool-start', kind: 'tool-call-started', payload: { toolCall } }
    ], 1)
    expect(recoverSessionExecutionForTarget(db, session.id, 3_000).status).toBe('ready')
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 2, status: 'ready', lastTurnId: 'restart-turn', messages: [
      { id: 'restart-user' }, { id: 'restart-assistant' },
      { role: 'tool', toolCallId: 'restart-tool', content: expect.stringContaining('may have started') }
    ] })
    expect(recoverSessionExecutionForTarget(db, session.id, 3_500).status).toBe('ready')
    expect(claimSessionExecution(db, { sessionId: session.id, turnId: 'next-turn', ownerId: 'new-owner' })).toMatchObject({ acquired: true })
    temp.cleanup()
  })

  it('keeps an uncertain claim when canonical History repair did not complete', () => {
    const db = createUncertainCommittedSession()

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: false, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toEqual({ reconciled: 0, skippedReason: 'history-recovery-incomplete' })
    expect(readSessionTranscript(db, 'startup-session').status).toBe('commit_uncertain')
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('startup-session')).toEqual({ status: 'commit_uncertain' })
    db.close()
  })

  it('keeps an uncertain claim when TurnCoordinator recovery throws even if no residue is visible', () => {
    const db = createUncertainCommittedSession()
    const coordinatorRecovery = recoverTurnCoordinatorForStartup(db, () => { throw new Error('injected restore failure') })
    expect(coordinatorRecovery.succeeded).toBe(false)

    expect(reconcileStartupSessionTranscripts(db, {
      historyRecoverySucceeded: true,
      turnCoordinatorRecoverySucceeded: coordinatorRecovery.succeeded
    }, 2_000)).toEqual({ reconciled: 0, skippedReason: 'turn-projection-recovery-incomplete' })
    expect(readSessionTranscript(db, 'startup-session').status).toBe('commit_uncertain')
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('startup-session'))
      .toEqual({ status: 'commit_uncertain' })
    db.close()
  })

  it('keeps an uncertain claim until TurnCoordinator projection recovery completes', () => {
    const db = createUncertainCommittedSession()

    const session = createSession(db, { name: 'unfinished-projection' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'unfinished-user', sessionId: session.id, role: 'user', content: 'pending', timestamp: 1, status: 'sent' },
      assistant: { id: 'unfinished-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'unfinished-turn', requestId: 'unfinished-request', sessionId: session.id, userMessageId: 'unfinished-user', assistantMessageId: 'unfinished-assistant', state: 'executing' }
    })
    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toEqual({ reconciled: 0, skippedReason: 'turn-projection-recovery-incomplete' })
    expect(readSessionTranscript(db, 'startup-session').status).toBe('commit_uncertain')
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('startup-session')).toEqual({ status: 'commit_uncertain' })
    db.close()
  })

  it('releases a claim after both recovery phases complete', () => {
    const db = createUncertainCommittedSession()

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toEqual({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 1 })
    expect(readSessionTranscript(db, 'startup-session').status).toBe('ready')
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('startup-session')).toEqual({ status: 'queued' })
    db.close()
  })

  it('releases an uncertain protocol 2 commit from its receipt and terminal when the auxiliary entry is absent', async () => {
    const { db, sessionId, turnId, userMessage } = await createUncertainProtocol2Session()
    getDbConnection(db).prepare('DELETE FROM session_transcript_entries WHERE session_id=? AND version=1').run(sessionId)

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ reconciled: 1 })
    expect(readSessionTranscript(db, sessionId, { version: 1 })).toMatchObject({
      version: 1, lastTurnId: turnId, status: 'ready', messages: [userMessage]
    })
    expect(getDbConnection(db).prepare('SELECT turn_id,status FROM session_execution_claims WHERE session_id=?').get(sessionId))
      .toEqual({ turn_id: '', status: 'queued' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM session_execution_queue WHERE session_id=? AND turn_id=?').get(sessionId, turnId))
      .toEqual({ count: 0 })
    db.close()
  })

  it('keeps a protocol 2 commit uncertain when its receipt has been lost', async () => {
    const { db, sessionId, turnId } = await createUncertainProtocol2Session()
    getDbConnection(db).prepare('DELETE FROM session_turn_commit_receipts WHERE session_id=? AND next_version=1').run(sessionId)

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ reconciled: 0 })
    expect(() => readSessionTranscript(db, sessionId)).toThrow('SESSION_TRANSCRIPT_VERSION_NOT_FOUND')
    expect(getDbConnection(db).prepare('SELECT turn_id,status FROM session_execution_claims WHERE session_id=?').get(sessionId))
      .toMatchObject({ turn_id: turnId, status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get(sessionId, turnId))
      .toEqual({ status: 'commit_uncertain' })
    db.close()
  })

  it('keeps a protocol 2 commit blocked when its receipt terminal payload is corrupt', async () => {
    const { db, sessionId, turnId } = await createUncertainProtocol2Session()
    getDbConnection(db).prepare(`UPDATE agent_history_events SET payload_json='{' WHERE session_id=? AND event_id='startup-protocol-2-terminal'`).run(sessionId)

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ reconciled: 0 })
    expect(getDbConnection(db).prepare('SELECT status FROM session_transcript_checkpoints WHERE session_id=?').get(sessionId))
      .toEqual({ status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT turn_id,status FROM session_execution_claims WHERE session_id=?').get(sessionId))
      .toEqual({ turn_id: turnId, status: 'commit_uncertain' })
    db.close()
  })

  it('reconciles an uncertain review replacement by its receipt while its auxiliary entry is absent', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'startup-review-protocol-2', model: 'test' })
    const owner = claimSessionExecution(db, { sessionId: session.id, turnId: 'review-source', ownerId: 'review-owner' })
    if (!owner.acquired) throw new Error('test setup failed to claim review source')
    expect(markSessionExecutionUncertain(db, { sessionId: session.id, turnId: 'review-source', ownerId: 'review-owner', generation: owner.generation })).toBe(true)
    expect(reconcileUncertainSessionTranscript(db, {
      sessionId: session.id, turnId: 'review-source', expectedVersion: 0, sessionGeneration: session.generation,
      outcome: 'interrupted', messages: [{ role: 'user', id: 'review-user', content: 'reviewed' }],
      operatorId: 'operator', rationale: 'startup recovery evidence', now: 10
    })).toEqual({ reconciled: true, version: 1 })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_transcript_checkpoints SET status='commit_uncertain',last_turn_id='review-source' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE session_execution_claims SET turn_id='review-source',owner_id='review-owner',status='commit_uncertain' WHERE session_id=?").run(session.id)
    conn.prepare('DELETE FROM session_transcript_entries WHERE session_id=? AND version=1').run(session.id)

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ reconciled: 1 })
    expect(readSessionTranscript(db, session.id, { version: 1 })).toMatchObject({
      version: 1, lastTurnId: 'review-source', status: 'ready', messages: [{ role: 'user', id: 'review-user', content: 'reviewed' }]
    })
    expect(conn.prepare('SELECT turn_id,status FROM session_execution_claims WHERE session_id=?').get(session.id))
      .toEqual({ turn_id: '', status: 'queued' })
    db.close()
  })

  it('turns an executing claim left by process exit into uncertain and keeps it blocked without a matching entry', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'crashed-session', turnId: 'crashed-turn', ownerId: 'old-process' })
    if (!owner.acquired) throw new Error('test setup failed to claim session')
    const ownership = { sessionId: 'crashed-session', turnId: 'crashed-turn', ownerId: 'old-process', generation: owner.generation }
    expect(markSessionExecutionStarted(db, ownership)).toBe(true)

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ markedUncertain: 1, reconciled: 0 })
    expect(readSessionTranscript(db, 'crashed-session')).toMatchObject({ version: 0, status: 'commit_uncertain', lastTurnId: 'crashed-turn' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('crashed-session')).toEqual({ status: 'commit_uncertain' })
    expect(claimSessionExecution(db, { sessionId: 'crashed-session', turnId: 'next-turn', ownerId: 'new-process' })).toMatchObject({ acquired: false, reason: 'blocked' })
    db.close()
  })

  it('releases an executing claim on startup when its committed transcript entry already matches', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'committed-before-exit', turnId: 'committed-turn', ownerId: 'old-process' })
    if (!owner.acquired) throw new Error('test setup failed to claim session')
    const ownership = { sessionId: 'committed-before-exit', turnId: 'committed-turn', ownerId: 'old-process', generation: owner.generation }
    expect(markSessionExecutionStarted(db, ownership)).toBe(true)
    commitSessionTranscript(db, { sessionId: 'committed-before-exit', turnId: 'committed-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'accepted' }] })

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ markedUncertain: 1, reconciled: 1 })
    expect(readSessionTranscript(db, 'committed-before-exit')).toMatchObject({ version: 1, status: 'ready', lastTurnId: 'committed-turn' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('committed-before-exit')).toEqual({ status: 'queued' })
    db.close()
  })

  it('在真实 SQLite 重启后对账匹配的已提交 checkpoint，并允许下一 turn 取得 claim', () => {
    const temp = createTempDatabase('startup-matching-checkpoint-restart-')
    const firstDb = temp.db
    const sessionId = createSession(firstDb, { name: 'matching-checkpoint-restart' }).id
    const firstOwner = claimSessionExecution(firstDb, {
      sessionId, turnId: 'committed-before-crash', ownerId: 'old-process'
    })
    if (!firstOwner.acquired) throw new Error('test setup failed to claim session')
    const ownership = { sessionId, turnId: 'committed-before-crash', ownerId: 'old-process', generation: firstOwner.generation }
    expect(markSessionExecutionStarted(firstDb, ownership)).toBe(true)
    expect(commitSessionTranscript(firstDb, {
      sessionId, turnId: ownership.turnId, baseVersion: 0, outcome: 'completed',
      messages: [{ role: 'user', content: 'accepted before crash' }]
    })).toMatchObject({ committed: true, version: 1 })
    // 模拟 checkpoint 已提交、后续确认失败，进程因此留下 uncertain fence。
    expect(markSessionExecutionUncertain(firstDb, ownership)).toBe(true)
    firstDb.close()

    const restartedDb = openDatabase(temp.dbPath)
    try {
      expect(readSessionTranscript(restartedDb, sessionId)).toMatchObject({
        version: 1, lastTurnId: ownership.turnId, status: 'commit_uncertain'
      })
      expect(reconcileStartupSessionTranscripts(restartedDb, {
        historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true
      }, 2_000)).toMatchObject({ reconciled: 1 })
      expect(readSessionTranscript(restartedDb, sessionId)).toMatchObject({
        version: 1, lastTurnId: ownership.turnId, status: 'ready'
      })
      expect(claimSessionExecution(restartedDb, {
        sessionId, turnId: 'next-turn', ownerId: 'new-process'
      })).toMatchObject({ acquired: true })
    } finally {
      restartedDb.close()
      temp.cleanup()
    }
  })

  it('releases a claim that crashed before execution started after recovery completes', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'unstarted-session', turnId: 'unstarted-turn', ownerId: 'old-process' })
    if (!owner.acquired) throw new Error('test setup failed to claim session')

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ releasedUnstarted: 1, markedUncertain: 0, reconciled: 0 })
    expect(readSessionTranscript(db, 'unstarted-session')).toMatchObject({ version: 0, status: 'ready' })
    expect(getDbConnection(db).prepare('SELECT status, turn_id FROM session_execution_claims WHERE session_id=?').get('unstarted-session'))
      .toEqual({ status: 'queued', turn_id: '' })
    db.close()
  })

  it('在真实 SQLite 进程重启后只释放未执行 claim，executing claim 保持 uncertain fence', () => {
    const temp = createTempDatabase('startup-claims-restart-')
    const firstDb = temp.db
    try {
      const sessionId = createSession(firstDb, { name: 'executing-claim-restart' }).id
      const unstarted = claimSessionExecution(firstDb, {
        sessionId: 'unstarted-restart-session', turnId: 'unstarted-restart-turn', ownerId: 'old-process'
      })
      const executing = claimSessionExecution(firstDb, {
        sessionId, turnId: 'executing-restart-turn', ownerId: 'old-process'
      })
      if (!unstarted.acquired || !executing.acquired) throw new Error('test setup failed to claim sessions')
      const ownership = { sessionId, turnId: 'executing-restart-turn', ownerId: 'old-process', generation: executing.generation }
      expect(markSessionExecutionStarted(firstDb, ownership)).toBe(true)
      const firstStorage = createTurnCoordinatorStorage(firstDb)
      firstStorage.prepareAtomic?.({
        user: { id: 'restart-user', sessionId, role: 'user', content: 'accepted', timestamp: 1, status: 'sent' },
        assistant: { id: 'restart-assistant', sessionId, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming' },
        turn: {
          turnId: 'executing-restart-turn', requestId: 'executing-restart-request', sessionId,
          userMessageId: 'restart-user', assistantMessageId: 'restart-assistant', state: 'executing'
        }
      })
      firstDb.close()

      const restartedDb = openDatabase(temp.dbPath)
      try {
        const storage = createTurnCoordinatorStorage(restartedDb)
        const runtime = new TurnRuntime({ storage, deps: { now: () => 10, id: () => 'restart-recovery-id' } })
        const coordinatorRecovery = recoverTurnCoordinatorForStartup(restartedDb, () => {
          for (const turn of listPersistedTurns(restartedDb)) {
            if (turn.state !== 'executing') continue
            const assistant = storage.getMessage(turn.assistantMessageId)
            if (assistant) runtime.coordinator.restoreTurn(turn, assistant)
          }
          expect(runtime.recover()).toBe(1)
        })
        expect(coordinatorRecovery.succeeded).toBe(true)
        expect(reconcileStartupSessionTranscripts(restartedDb, {
          historyRecoverySucceeded: true,
          turnCoordinatorRecoverySucceeded: coordinatorRecovery.succeeded
        }, 2_000)).toMatchObject({ releasedUnstarted: 1, markedUncertain: 1, reconciled: 0 })
        expect(getPersistedTurn(restartedDb, 'executing-restart-turn')).toMatchObject({ state: 'terminal', outcome: 'recovered' })
        expect(getDbConnection(restartedDb).prepare('SELECT status,turn_id FROM session_execution_claims WHERE session_id=?')
          .get('unstarted-restart-session')).toEqual({ status: 'queued', turn_id: '' })
        expect(getDbConnection(restartedDb).prepare('SELECT status,turn_id FROM session_execution_claims WHERE session_id=?')
          .get(sessionId)).toEqual({ status: 'commit_uncertain', turn_id: 'executing-restart-turn' })
        expect(readSessionTranscript(restartedDb, sessionId).status).toBe('commit_uncertain')
        expect(claimSessionExecution(restartedDb, {
          sessionId: 'unstarted-restart-session', turnId: 'next-unstarted-turn', ownerId: 'new-process'
        })).toMatchObject({ acquired: true })
        expect(claimSessionExecution(restartedDb, {
          sessionId, turnId: 'next-executing-turn', ownerId: 'new-process'
        })).toMatchObject({ acquired: false, reason: 'blocked' })
      } finally {
        restartedDb.close()
      }

      const verifyDb = openDatabase(temp.dbPath)
      try {
        expect(getDbConnection(verifyDb).prepare('SELECT status,turn_id FROM session_execution_claims WHERE session_id=?')
          .get(sessionId)).toEqual({ status: 'commit_uncertain', turn_id: 'executing-restart-turn' })
        expect(readSessionTranscript(verifyDb, sessionId).status).toBe('commit_uncertain')
      } finally {
        verifyDb.close()
      }
    } finally {
      temp.cleanup()
    }
  })

  it('recreates a missing uncertain checkpoint from the durable execution fence on startup', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'missing-checkpoint', turnId: 'fenced-turn', ownerId: 'old-process' })
    if (!owner.acquired) throw new Error('test setup failed to claim session')
    const ownership = { sessionId: 'missing-checkpoint', turnId: 'fenced-turn', ownerId: 'old-process', generation: owner.generation }
    expect(markSessionExecutionStarted(db, ownership)).toBe(true)
    getDbConnection(db).prepare(`UPDATE session_execution_claims SET status='commit_uncertain' WHERE session_id=?`).run('missing-checkpoint')
    getDbConnection(db).prepare(`UPDATE session_execution_queue SET status='commit_uncertain' WHERE session_id=?`).run('missing-checkpoint')

    expect(reconcileStartupSessionTranscripts(db, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 2_000))
      .toMatchObject({ markedUncertain: 0, repairedCheckpoints: 1, reconciled: 0 })
    expect(readSessionTranscript(db, 'missing-checkpoint')).toMatchObject({ version: 0, status: 'commit_uncertain', lastTurnId: 'fenced-turn' })
    expect(claimSessionExecution(db, { sessionId: 'missing-checkpoint', turnId: 'next-turn', ownerId: 'new-process' }))
      .toMatchObject({ acquired: false, reason: 'blocked' })
    db.close()
  })

  it('does not release an uncertain session when TurnCoordinator recovery silently leaves a turn unfinished', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'stuck-projection' }).id
    const storage = createTurnCoordinatorStorage(db)
    const owner = claimSessionExecution(db, { sessionId, turnId: 'stuck-turn', ownerId: 'old-process' })
    if (!owner.acquired) throw new Error('test setup failed to claim session')
    const ownership = { sessionId, turnId: 'stuck-turn', ownerId: 'old-process', generation: owner.generation }
    expect(markSessionExecutionStarted(db, ownership)).toBe(true)
    commitSessionTranscript(db, { sessionId, turnId: 'stuck-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'accepted' }] })
    expect(markSessionExecutionUncertain(db, ownership)).toBe(true)
    storage.prepareAtomic?.({
      user: { id: 'stuck-user', sessionId, role: 'user', content: 'accepted', timestamp: 1, status: 'sent' },
      assistant: { id: 'stuck-assistant', sessionId, role: 'assistant', content: 'already projected', timestamp: 2, status: 'completed' },
      turn: { turnId: 'stuck-turn', requestId: 'stuck-request', sessionId, userMessageId: 'stuck-user', assistantMessageId: 'stuck-assistant', state: 'executing' }
    })
    const persisted = listPersistedTurns(db, 'executing')[0]!
    const runtime = new TurnRuntime({ storage, deps: { now: () => 3, id: () => 'recovery-id' } })
    runtime.coordinator.restoreTurn(persisted, storage.getMessage(persisted.assistantMessageId)!)

    const coordinatorRecovery = recoverTurnCoordinatorForStartup(db, () => { expect(runtime.recover()).toBe(0) })
    expect(coordinatorRecovery.succeeded).toBe(false)
    expect(hasUnfinishedStartupProjections(db)).toBe(true)
    expect(reconcileStartupSessionTranscripts(db, {
      historyRecoverySucceeded: true,
      turnCoordinatorRecoverySucceeded: coordinatorRecovery.succeeded
    }, 4_000))
      .toEqual({ reconciled: 0, skippedReason: 'turn-projection-recovery-incomplete' })
    expect(readSessionTranscript(db, sessionId).status).toBe('commit_uncertain')
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(sessionId))
      .toEqual({ status: 'commit_uncertain' })
    db.close()
  })

  it('continues coordinator recovery when canonical-only turn projection cannot be restored in memory', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'startup canonical projection corruption' })
    const storage = createTurnCoordinatorStorage(db)
    storage.prepareAtomic?.({
      user: { id: 'startup-corrupt-user', sessionId: session.id, role: 'user', content: 'accepted', timestamp: 1, status: 'sent' },
      assistant: { id: 'startup-corrupt-assistant', sessionId: session.id, role: 'assistant', content: 'partial answer', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'startup-corrupt-turn', requestId: 'startup-corrupt-request', sessionId: session.id,
        userMessageId: 'startup-corrupt-user', assistantMessageId: 'startup-corrupt-assistant', state: 'executing' }
    })
    await new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id).appendBatch([{
      invocationId: 'startup-corrupt-turn', turnId: 'startup-corrupt-turn', sequence: 2, schemaVersion: 1,
      eventId: 'startup-corrupt-context', idempotencyKey: 'startup-corrupt-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'startup-corrupt-user', role: 'user', content: 'accepted', timestamp: 1 },
        { id: 'startup-corrupt-assistant', role: 'assistant', content: 'partial answer', timestamp: 2 }
      ] }
    }], 1)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare('UPDATE agent_history_events SET session_id=? WHERE event_id=?').run('foreign-session', 'startup-corrupt-context')

    const healthySession = createSession(db, { name: 'startup healthy projection after corruption' })
    storage.prepareAtomic?.({
      user: { id: 'startup-healthy-user', sessionId: healthySession.id, role: 'user', content: 'healthy input', timestamp: 1, status: 'sent' },
      assistant: { id: 'startup-healthy-assistant', sessionId: healthySession.id, role: 'assistant', content: 'healthy partial', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'startup-healthy-turn', requestId: 'startup-healthy-request', sessionId: healthySession.id,
        userMessageId: 'startup-healthy-user', assistantMessageId: 'startup-healthy-assistant', state: 'executing' }
    })
    conn.prepare('UPDATE turns SET created_at=1 WHERE turn_id=?').run('startup-corrupt-turn')
    conn.prepare('UPDATE turns SET created_at=2 WHERE turn_id=?').run('startup-healthy-turn')
    const runtime = new TurnRuntime({ storage, deps: { now: () => 4, id: () => 'startup-recovery-id' } })
    const restoredAssistantIds: string[] = []

    const result = recoverTurnCoordinatorForStartup(db, () => {
      expect(restorePersistedTurnSnapshotsForStartup(db, (turn, assistant) => {
        restoredAssistantIds.push(assistant.id)
        runtime.coordinator.restoreTurn(turn, assistant)
      })).toBe(1)
      runtime.recover()
    })

    expect(result.succeeded).toBe(true)
    expect(restoredAssistantIds).toEqual(['startup-healthy-assistant'])
    expect(getPersistedTurn(db, 'startup-corrupt-turn')).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    expect(getPersistedTurn(db, 'startup-healthy-turn')).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    expect(getMessage(db, 'startup-corrupt-assistant')).toMatchObject({ content: '', status: 'failed' })
    db.close()
  })

  it('propagates turn snapshot restoration failures instead of treating them as projection failures', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'startup restore callback failure' })
    createTurnCoordinatorStorage(db).prepareAtomic?.({
      user: { id: 'callback-failure-user', sessionId: session.id, role: 'user', content: 'accepted', timestamp: 1, status: 'sent' },
      assistant: { id: 'callback-failure-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'callback-failure-turn', requestId: 'callback-failure-request', sessionId: session.id,
        userMessageId: 'callback-failure-user', assistantMessageId: 'callback-failure-assistant', state: 'executing' }
    })

    expect(() => restorePersistedTurnSnapshotsForStartup(db, () => {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    })).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    db.close()
  })

  it('keeps recovery incomplete while a streaming assistant residue remains', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'streaming-residue' }).id
    appendMessage(db, { id: 'streaming-residue-assistant', sessionId, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' })

    expect(hasUnfinishedStartupProjections(db)).toBe(true)
    db.close()
  })
})
