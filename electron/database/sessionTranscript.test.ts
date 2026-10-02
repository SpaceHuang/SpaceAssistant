import { describe, expect, it } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { openDatabase } from './index'
import { commitSessionTranscript, claimSessionExecution, releaseSessionExecution, readSessionTranscript, markSessionExecutionStarted, markSessionExecutionUncertain, reconcileCommittedSessionTranscripts, reconcileUncertainSessionTranscript } from './sessionTranscript'

describe('session transcript checkpoint and execution claim', () => {
  it('commits by session/turn idempotently and rejects stale base versions', () => {
    const db = createMemoryAppDb()
    const first = commitSessionTranscript(db, { sessionId: 's', turnId: 't1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'a' }] })
    expect(first).toEqual({ committed: true, version: 1 })
    expect(commitSessionTranscript(db, { sessionId: 's', turnId: 't1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'a' }] })).toEqual(first)
    expect(commitSessionTranscript(db, { sessionId: 's', turnId: 't2', baseVersion: 0, outcome: 'completed', messages: [] })).toEqual({ committed: false, reason: 'version-conflict', version: 1 })
    expect(readSessionTranscript(db, 's')).toMatchObject({ version: 1, messages: [{ role: 'user', content: 'a' }] })
    db.close()
  })

  it('preserves same-turn snapshot idempotency across a database reopen', () => {
    const temp = createTempDatabase('transcript-idempotency-reopen-')
    const messages = [{ role: 'user' as const, content: 'accepted exactly once' }]
    const first = commitSessionTranscript(temp.db, {
      sessionId: 'reopen-session', turnId: 'reopen-turn', baseVersion: 0, outcome: 'completed', messages
    })
    const persistedJson = getDbConnection(temp.db).prepare('SELECT messages_json FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get('reopen-session', 'reopen-turn') as { messages_json: string }
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    expect(commitSessionTranscript(reopened, {
      sessionId: 'reopen-session', turnId: 'reopen-turn', baseVersion: 0, outcome: 'completed', messages
    })).toEqual(first)
    expect(getDbConnection(reopened).prepare('SELECT payload_sha256,next_version FROM session_turn_commit_receipts WHERE session_id=? AND turn_id=?').get('reopen-session', 'reopen-turn'))
      .toMatchObject({ next_version: 1, payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(commitSessionTranscript(reopened, {
      sessionId: 'reopen-session', turnId: 'reopen-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'changed after restart' }]
    })).toEqual({ committed: false, reason: 'idempotency-conflict', version: 1 })
    expect(getDbConnection(reopened).prepare('SELECT version, last_turn_id, status FROM session_transcript_checkpoints WHERE session_id=?').get('reopen-session'))
      .toEqual({ version: 1, last_turn_id: 'reopen-turn', status: 'ready' })
    expect(getDbConnection(reopened).prepare('SELECT messages_json FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get('reopen-session', 'reopen-turn'))
      .toEqual(persistedJson)

    reopened.close()
    temp.cleanup()
  })

  it('persists a compact commit receipt with the session CAS result', () => {
    const db = createMemoryAppDb()
    const messages = [{ role: 'user', content: 'receipt payload' }]
    getDbConnection(db).prepare(`INSERT INTO agent_history_events(
      invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id,commit_order,session_seq
    ) VALUES('receipt-invocation',1,'receipt-event','receipt-event','receipt-turn',1,'invocation-completed','{}',1,'receipt-session',9,7)`).run()
    expect(commitSessionTranscript(db, {
      sessionId: 'receipt-session', turnId: 'receipt-turn', baseVersion: 0, outcome: 'completed', messages
    })).toEqual({ committed: true, version: 1 })

    const receipt = getDbConnection(db).prepare(`SELECT base_version,next_version,outcome,event_start,event_end,payload_sha256
      FROM session_turn_commit_receipts WHERE session_id=? AND turn_id=?`).get('receipt-session', 'receipt-turn')
    expect(receipt).toMatchObject({ base_version: 0, next_version: 1, outcome: 'completed' })
    expect(receipt).toMatchObject({ event_start: 7, event_end: 7 })
    expect(receipt.payload_sha256).toMatch(/^[a-f0-9]{64}$/)
    db.close()
  })

  it('rolls back the transcript entry and checkpoint if receipt persistence fails', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_commit_receipt BEFORE INSERT ON session_turn_commit_receipts
      WHEN NEW.session_id='receipt-atomic' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`)
    expect(() => commitSessionTranscript(db, {
      sessionId: 'receipt-atomic', turnId: 'turn-1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'atomic' }]
    })).toThrow('injected receipt failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get('receipt-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_checkpoints WHERE session_id=?').get('receipt-atomic')).toEqual({ count: 0 })
    conn.exec('DROP TRIGGER fail_commit_receipt')
    expect(commitSessionTranscript(db, {
      sessionId: 'receipt-atomic', turnId: 'turn-1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'atomic' }]
    })).toEqual({ committed: true, version: 1 })
    db.close()
  })

  it('rolls back the entry and receipt if checkpoint persistence fails', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_transcript_checkpoint BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.session_id='checkpoint-atomic' BEGIN SELECT RAISE(ABORT, 'injected transcript checkpoint failure'); END`)
    expect(() => commitSessionTranscript(db, {
      sessionId: 'checkpoint-atomic', turnId: 'turn-1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'atomic' }]
    })).toThrow('injected transcript checkpoint failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get('checkpoint-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_turn_commit_receipts WHERE session_id=?').get('checkpoint-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_checkpoints WHERE session_id=?').get('checkpoint-atomic')).toEqual({ count: 0 })
    conn.exec('DROP TRIGGER fail_transcript_checkpoint')
    expect(commitSessionTranscript(db, {
      sessionId: 'checkpoint-atomic', turnId: 'turn-1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'atomic' }]
    })).toEqual({ committed: true, version: 1 })
    db.close()
  })

  it('uses the session checkpoint as the cross-turn CAS when distinct turns race on one base version', () => {
    const db = createMemoryAppDb()
    expect(commitSessionTranscript(db, {
      sessionId: 'cas-session', turnId: 'turn-a', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'a' }]
    })).toEqual({ committed: true, version: 1 })
    expect(commitSessionTranscript(db, {
      sessionId: 'cas-session', turnId: 'turn-b', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'b' }]
    })).toEqual({ committed: false, reason: 'version-conflict', version: 1 })
    expect(getDbConnection(db).prepare('SELECT turn_id FROM session_turn_commit_receipts WHERE session_id=?').all('cas-session'))
      .toEqual([{ turn_id: 'turn-a' }])
    expect(getDbConnection(db).prepare('SELECT version,status FROM session_transcript_checkpoints WHERE session_id=?').get('cas-session'))
      .toEqual({ version: 1, status: 'commit_uncertain' })
    db.close()
  })

  it('commits the transcript checkpoint and marks its claim and queue for projection recovery atomically', () => {
    const db = createMemoryAppDb()
    expect(claimSessionExecution(db, { sessionId: 'commit-owner', turnId: 'turn-1', ownerId: 'process-1' })).toMatchObject({ acquired: true })
    expect(markSessionExecutionStarted(db, { sessionId: 'commit-owner', turnId: 'turn-1', ownerId: 'process-1', generation: 1 })).toBe(true)
    expect(commitSessionTranscript(db, {
      sessionId: 'commit-owner', turnId: 'turn-1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'done' }]
    })).toEqual({ committed: true, version: 1 })

    const conn = getDbConnection(db)
    expect(conn.prepare('SELECT turn_id,owner_id,status,generation FROM session_execution_claims WHERE session_id=?').get('commit-owner'))
      .toEqual({ turn_id: 'turn-1', owner_id: 'process-1', status: 'transcript_committed', generation: 1 })
    expect(conn.prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get('commit-owner', 'turn-1'))
      .toEqual({ status: 'transcript_committed' })
    expect(claimSessionExecution(db, { sessionId: 'commit-owner', turnId: 'turn-2', ownerId: 'process-2' })).toMatchObject({ acquired: false, reason: 'owned' })
    expect(releaseSessionExecution(db, { sessionId: 'commit-owner', turnId: 'turn-1', ownerId: 'process-1', generation: 1 })).toBe(true)
    expect(claimSessionExecution(db, { sessionId: 'commit-owner', turnId: 'turn-2', ownerId: 'process-2' })).toMatchObject({ acquired: true, generation: 2 })
    db.close()
  })

  it('rolls back transcript, receipt, checkpoint and claim state if queue transition fails', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    expect(claimSessionExecution(db, { sessionId: 'commit-owner-atomic', turnId: 'turn-1', ownerId: 'process-1' })).toMatchObject({ acquired: true })
    expect(markSessionExecutionStarted(db, { sessionId: 'commit-owner-atomic', turnId: 'turn-1', ownerId: 'process-1', generation: 1 })).toBe(true)
    conn.exec(`CREATE TRIGGER fail_commit_queue_transition BEFORE UPDATE ON session_execution_queue
      WHEN OLD.session_id='commit-owner-atomic' AND NEW.status='transcript_committed' BEGIN SELECT RAISE(ABORT, 'injected queue transition failure'); END`)
    expect(() => commitSessionTranscript(db, {
      sessionId: 'commit-owner-atomic', turnId: 'turn-1', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'done' }]
    })).toThrow('injected queue transition failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get('commit-owner-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_turn_commit_receipts WHERE session_id=?').get('commit-owner-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_checkpoints WHERE session_id=?').get('commit-owner-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('commit-owner-atomic')).toEqual({ status: 'executing' })
    expect(conn.prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get('commit-owner-atomic', 'turn-1')).toEqual({ status: 'executing' })
    db.close()
  })

  it('allows only one cross-process session owner and fences stale releases', () => {
    const db = createMemoryAppDb()
    const first = claimSessionExecution(db, { sessionId: 's', turnId: 't1', ownerId: 'p1', now: 1 })
    const blocked = claimSessionExecution(db, { sessionId: 's', turnId: 't2', ownerId: 'p2', now: 2 })
    const later = claimSessionExecution(db, { sessionId: 's', turnId: 't3', ownerId: 'p3', now: 3 })
    expect(first).toMatchObject({ acquired: true, generation: 1 })
    expect(blocked).toMatchObject({ acquired: false, reason: 'owned' })
    expect(later).toMatchObject({ acquired: false, reason: 'owned' })
    expect(releaseSessionExecution(db, { sessionId: 's', turnId: 't1', ownerId: 'stale', generation: 1 })).toBe(false)
    expect(releaseSessionExecution(db, { sessionId: 's', turnId: 't1', ownerId: 'p1', generation: 1 })).toBe(true)
    expect(claimSessionExecution(db, { sessionId: 's', turnId: 't3', ownerId: 'p3', now: 4 })).toMatchObject({ acquired: false, reason: 'owned' })
    expect(claimSessionExecution(db, { sessionId: 's', turnId: 't2', ownerId: 'p2', now: 5 })).toMatchObject({ acquired: true, generation: 2 })
    db.close()
  })

  it('claim 写入在队列已更新后失败时整体回滚，允许同一 turn 重新获取', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_session_claim_insert BEFORE INSERT ON session_execution_claims
      WHEN NEW.session_id='claim-atomic' BEGIN SELECT RAISE(ABORT, 'injected session claim failure'); END`)

    expect(() => claimSessionExecution(db, { sessionId: 'claim-atomic', turnId: 'turn-1', ownerId: 'process-1' }))
      .toThrow('injected session claim failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_execution_queue WHERE session_id=?').get('claim-atomic'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=?').get('claim-atomic'))
      .toEqual({ count: 0 })

    conn.exec('DROP TRIGGER fail_session_claim_insert')
    expect(claimSessionExecution(db, { sessionId: 'claim-atomic', turnId: 'turn-1', ownerId: 'process-1' }))
      .toMatchObject({ acquired: true, generation: 1 })
    db.close()
  })

  it('checkpoint 写入故障时仍持久保留 uncertain 执行 fence', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'atomic-uncertain', turnId: 'turn-1', ownerId: 'process-1' })
    expect(owner).toMatchObject({ acquired: true })
    const ownership = { sessionId: 'atomic-uncertain', turnId: 'turn-1', ownerId: 'process-1', generation: owner.generation }
    expect(markSessionExecutionStarted(db, ownership)).toBe(true)
    getDbConnection(db).exec(`CREATE TRIGGER fail_uncertain_checkpoint BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.session_id = 'atomic-uncertain' BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`)

    expect(markSessionExecutionUncertain(db, ownership)).toBe(true)
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('atomic-uncertain')).toEqual({ status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get('atomic-uncertain', 'turn-1')).toEqual({ status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_transcript_checkpoints WHERE session_id=?').get('atomic-uncertain')).toBeUndefined()
    db.close()
  })

  it('标记执行开始时 claim 与队列在同一 SQLite 事务中提交', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'atomic-start', turnId: 'turn-1', ownerId: 'process-1' })
    expect(owner).toMatchObject({ acquired: true })
    const ownership = { sessionId: 'atomic-start', turnId: 'turn-1', ownerId: 'process-1', generation: owner.generation }
    getDbConnection(db).exec(`CREATE TRIGGER fail_started_queue BEFORE UPDATE ON session_execution_queue
      WHEN NEW.session_id = 'atomic-start' AND NEW.status = 'executing' BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END`)

    expect(() => markSessionExecutionStarted(db, ownership)).toThrow('injected queue failure')
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('atomic-start')).toEqual({ status: 'claimed' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get('atomic-start', 'turn-1')).toEqual({ status: 'claimed' })
    db.close()
  })

  it('reconciles a durable transcript entry whose checkpoint was marked uncertain after commit', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'recover-session', turnId: 'recover-turn', ownerId: 'process-1' })
    expect(owner).toMatchObject({ acquired: true })
    const ownership = { sessionId: 'recover-session', turnId: 'recover-turn', ownerId: 'process-1', generation: owner.generation }
    expect(commitSessionTranscript(db, { sessionId: 'recover-session', turnId: 'recover-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'accepted' }] })).toMatchObject({ committed: true, version: 1 })
    expect(markSessionExecutionUncertain(db, ownership)).toBe(true)
    expect(readSessionTranscript(db, 'recover-session').status).toBe('commit_uncertain')
    expect(reconcileCommittedSessionTranscripts(db)).toBe(1)
    expect(readSessionTranscript(db, 'recover-session')).toMatchObject({ version: 1, lastTurnId: 'recover-turn', status: 'ready' })
    expect(claimSessionExecution(db, { sessionId: 'recover-session', turnId: 'next-turn', ownerId: 'process-2' })).toMatchObject({ acquired: true })
    expect(reconcileCommittedSessionTranscripts(db)).toBe(0)
    db.close()
  })

  it('keeps a session blocked when uncertain execution has no committed transcript entry', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'blocked-session', turnId: 'unknown-turn', ownerId: 'process-1' })
    expect(owner).toMatchObject({ acquired: true })
    expect(markSessionExecutionUncertain(db, { sessionId: 'blocked-session', turnId: 'unknown-turn', ownerId: 'process-1', generation: owner.generation })).toBe(true)
    expect(reconcileCommittedSessionTranscripts(db)).toBe(0)
    expect(readSessionTranscript(db, 'blocked-session').status).toBe('commit_uncertain')
    expect(claimSessionExecution(db, { sessionId: 'blocked-session', turnId: 'next-turn', ownerId: 'process-2' })).toMatchObject({ acquired: false, reason: 'blocked' })
    db.close()
  })

  it('requires an explicit reviewed resolution before unblocking a missing transcript commit', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'manual-session', turnId: 'manual-turn', ownerId: 'process-1' })
    expect(owner).toMatchObject({ acquired: true })
    expect(markSessionExecutionUncertain(db, { sessionId: 'manual-session', turnId: 'manual-turn', ownerId: 'process-1', generation: owner.generation })).toBe(true)

    expect(reconcileUncertainSessionTranscript(db, {
      sessionId: 'manual-session', turnId: 'manual-turn', expectedVersion: 0,
      outcome: 'failed', messages: [{ role: 'user', content: 'reviewed input' }],
      operatorId: 'operator-1', rationale: 'Reviewed canonical History; retain the accepted user request only.', now: 42
    })).toEqual({ reconciled: true, version: 1 })
    expect(readSessionTranscript(db, 'manual-session')).toMatchObject({
      version: 1, lastTurnId: 'manual-turn', status: 'ready',
      messages: [{ role: 'user', content: 'reviewed input' }]
    })
    expect(getDbConnection(db).prepare('SELECT resolution, operator_id, rationale FROM session_transcript_reconciliations').get())
      .toEqual({ resolution: 'commit-reviewed', operator_id: 'operator-1', rationale: 'Reviewed canonical History; retain the accepted user request only.' })
    expect(claimSessionExecution(db, { sessionId: 'manual-session', turnId: 'next-turn', ownerId: 'process-2' })).toMatchObject({ acquired: true })
    db.close()
  })

  it('retains interrupted as the audited reconciliation outcome', () => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'interrupted-review', turnId: 'interrupted-turn', ownerId: 'process-1' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionUncertain(db, { sessionId: 'interrupted-review', turnId: 'interrupted-turn', ownerId: 'process-1', generation: owner.generation })
    expect(reconcileUncertainSessionTranscript(db, {
      sessionId: 'interrupted-review', turnId: 'interrupted-turn', expectedVersion: 0,
      outcome: 'interrupted', messages: [], operatorId: 'operator-1', rationale: 'Reviewed process restart terminal.'
    })).toEqual({ reconciled: true, version: 1 })
    expect(getDbConnection(db).prepare('SELECT outcome FROM session_transcript_entries WHERE session_id=?').get('interrupted-review')).toEqual({ outcome: 'interrupted' })
    db.close()
  })

  it.each([
    ['different turn', { turnId: 'other-turn', expectedVersion: 0, operatorId: 'operator-1', rationale: 'reviewed' }],
    ['stale version', { turnId: 'manual-turn', expectedVersion: 1, operatorId: 'operator-1', rationale: 'reviewed' }],
    ['missing operator', { turnId: 'manual-turn', expectedVersion: 0, operatorId: '', rationale: 'reviewed' }],
    ['missing rationale', { turnId: 'manual-turn', expectedVersion: 0, operatorId: 'operator-1', rationale: ' ' }]
  ])('refuses manual reconciliation with %s', (_case, override) => {
    const db = createMemoryAppDb()
    const owner = claimSessionExecution(db, { sessionId: 'manual-session', turnId: 'manual-turn', ownerId: 'process-1' })
    expect(owner).toMatchObject({ acquired: true })
    markSessionExecutionUncertain(db, { sessionId: 'manual-session', turnId: 'manual-turn', ownerId: 'process-1', generation: owner.generation })
    expect(reconcileUncertainSessionTranscript(db, {
      sessionId: 'manual-session', turnId: override.turnId, expectedVersion: override.expectedVersion,
      outcome: 'failed', messages: [], operatorId: override.operatorId, rationale: override.rationale
    })).toMatchObject({ reconciled: false })
    expect(readSessionTranscript(db, 'manual-session').status).toBe('commit_uncertain')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM session_transcript_reconciliations').get()).toMatchObject({ count: 0 })
    db.close()
  })
})
