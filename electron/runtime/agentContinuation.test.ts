import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CREATE_TABLES_SQL } from '../database/schema'
import { runMigrations } from '../database/migrations'
import { createOrGetAgentContinuation, validateContinuationCheckpoint, claimAgentContinuation, setAgentContinuationStatus, setAgentContinuationStatusForTurn, reconcileRunningAgentContinuations } from './agentContinuation'
import type { HistoryEvent, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { rebuildClaudeMessagesFromHistory } from './canonicalHistory'
import { createTurnCoordinatorStorage } from '../turnCoordinatorStorage'
import { TurnRuntime } from '../turnRuntime'
import { createSession, appendMessage, openDatabase, getDbConnection } from '../database'

function event(sequence: number, kind: HistoryEvent['kind'], payload: unknown): HistoryEvent {
  return { invocationId: 'source-invocation', turnId: 'source-turn', sequence, schemaVersion: 1,
    eventId: `e-${sequence}`, idempotencyKey: `i-${sequence}`, kind, payload }
}

function snapshot(extra: HistoryEvent[] = []): HistorySnapshot {
  const events = [
    event(1, 'invocation-context-committed', {
      messages: [{ role: 'user', content: 'start' }], requiredUserMessage: { id: 'source-user', message: { role: 'user', content: 'start' } }
    }),
    event(2, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'tool-1', name: 'lookup', input: { q: 'x' } }] } }),
    event(3, 'tool-call-started', { toolCallId: 'tool-1' }),
    event(4, 'tool-call-finished', { toolCallId: 'tool-1', replayContent: 'found', isError: false }),
    event(5, 'model-response-committed', { message: { role: 'assistant', content: 'done' } }),
    event(6, 'invocation-completed', { status: 'completed' }),
    ...extra
  ]
  return { invocationId: 'source-invocation', version: events.length, schemaVersion: 1, events }
}

function db(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec(CREATE_TABLES_SQL)
  runMigrations(conn)
  return conn
}

describe('agent continuation checkpoint', () => {
  it('重建已提交工具结果，校验 checkpoint 摘要並原子幂等占用', () => {
    const conn = db()
    const source = snapshot()
    const first = createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'req-1', createdBy: 'user-1', frozenConfig: { model: 'm1' }, newId: (() => { let id = 0; return () => `id-${++id}` })(), now: () => 10 })
    expect(first.targetStartToken).toBe('id-4')
    expect(first.checkpointSequence).toBe(5)
    expect(first.transcript).toContainEqual(expect.objectContaining({ role: 'user', content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'tool-1', content: 'found' })] }))
    const target = new SqliteAgentHistory(conn, 1, Date.now, 'session-1').readSync(first.targetInvocationId)
    expect(target.events).toHaveLength(1)
    expect(rebuildClaudeMessagesFromHistory(target.events)).toEqual(first.transcript)
    expect(target.events[0]).toMatchObject({
      invocationId: first.targetInvocationId,
      turnId: first.targetTurnId,
      kind: 'invocation-context-committed',
      payload: {
        continuationSource: { invocationId: first.sourceInvocationId, checkpointSequence: first.checkpointSequence, checkpointSha256: first.checkpointSha256 },
        messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', toolCallId: 'tool-1', content: 'found' })])
      }
    })
    expect(createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'req-1', createdBy: 'user-1', frozenConfig: { model: 'm1' } }).continuationId).toBe(first.continuationId)
    expect(createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'req-1', createdBy: 'user-1', frozenConfig: { model: 'm1' } }).targetStartToken).toBe(first.targetStartToken)
    expect(() => createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'other-session', requestIdempotencyKey: 'req-1', createdBy: 'other-session', frozenConfig: { model: 'm1' } })).toThrow('CONTINUATION_IDEMPOTENCY_CONFLICT')
    expect(() => createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'req-2', createdBy: 'user-1', frozenConfig: { model: 'm1' } })).toThrow('CONTINUATION_ALREADY_CLAIMED')
    expect(claimAgentContinuation(conn, first.continuationId, { model: 'different' }, 11)).toBe(false)
    expect(claimAgentContinuation(conn, first.continuationId, { model: 'm1' }, 12)).toBe(true)
    expect(claimAgentContinuation(conn, first.continuationId, { model: 'm1' }, 13)).toBe(false)
    conn.close()
  })

  it('未结算 started 工具、未结算提案和未解决审批均不可恢复', () => {
    const unknown = snapshot()
    unknown.events.splice(3, 1)
    expect(() => validateContinuationCheckpoint(unknown)).toThrow('UNKNOWN_SIDE_EFFECT')

    const unresolved = snapshot()
    unresolved.events.splice(2, unresolved.events.length - 2, event(3, 'approval-waiting', { toolCallId: 'tool-1' }), event(4, 'invocation-failed', { status: 'failed' }))
    unresolved.events.forEach((item, index) => { item.sequence = index + 1 })
    expect(() => validateContinuationCheckpoint(unresolved)).toThrow('UNRESOLVED_APPROVAL')
  })

  it('拒绝取消/中断 invocation 与已变更的 checkpoint 摘要', () => {
    const cancelled = snapshot()
    cancelled.events[cancelled.events.length - 1] = event(6, 'invocation-interrupted', { status: 'cancelled' })
    expect(() => validateContinuationCheckpoint(cancelled)).toThrow('SOURCE_INVOCATION_NOT_RECOVERABLE')

    const conn = db()
    const source = snapshot()
    const first = createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'stable', createdBy: 'u', frozenConfig: {} })
    const changed = structuredClone(source)
    ;(changed.events[4]!.payload as { message: { content: string } }).message.content = 'tampered'
    expect(() => createOrGetAgentContinuation({ conn, snapshot: changed, sessionId: 'session-1', requestIdempotencyKey: 'stable', createdBy: 'u', frozenConfig: {} })).toThrow('CONTINUATION_IDEMPOTENCY_CONFLICT')
    expect(first.targetInvocationId).not.toBe(source.invocationId)
    conn.close()
  })

  it('checkpoint 缺少 required user 身份时拒绝且不占用', () => {
    const source = snapshot()
    delete (source.events[0]!.payload as Record<string, unknown>).requiredUserMessage
    expect(() => validateContinuationCheckpoint(source)).toThrow('CHECKPOINT_REQUIRED_USER_MISSING')
  })

  it('即使 invocation 后续普通失败，checkpoint 含安全拒绝或用户拒绝审批仍不可续跑', () => {
    const policyDenied = snapshot()
    policyDenied.events.splice(5, 0, event(6, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'denied-tool', name: 'edit_file', input: { path: 'x' } }] } }))
    policyDenied.events.splice(6, 0, event(7, 'tool-call-not-dispatched', { toolCallId: 'denied-tool', reason: 'POLICY_DENY', replayContent: 'denied' }))
    policyDenied.events.forEach((item, index) => { item.sequence = index + 1 })
    expect(() => validateContinuationCheckpoint(policyDenied)).toThrow('SAFETY_REJECTION_NOT_RECOVERABLE')

    const approvalDenied = snapshot()
    approvalDenied.events.splice(5, 0,
      event(6, 'approval-waiting', { toolCallId: 'tool-1' }),
      event(7, 'approval-resolved', { toolCallId: 'tool-1', approved: false, outcome: 'denied' }))
    approvalDenied.events.forEach((item, index) => { item.sequence = index + 1 })
    expect(() => validateContinuationCheckpoint(approvalDenied)).toThrow('SAFETY_REJECTION_NOT_RECOVERABLE')
  })

  it('同 key 不能绑定不同冻结配置，即使 checkpoint 不变', () => {
    const conn = db()
    const source = snapshot()
    createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'config-key', createdBy: 'u', frozenConfig: { model: 'model-a' } })
    expect(() => createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'config-key', createdBy: 'u', frozenConfig: { model: 'model-b' } }))
      .toThrow('CONTINUATION_IDEMPOTENCY_CONFLICT')
    conn.close()
  })

  it('拒绝跨 turn History、孤立结果、重复结果与安全拒绝终态', () => {
    const crossTurn = snapshot()
    crossTurn.events[2] = { ...crossTurn.events[2]!, turnId: 'other-turn' }
    expect(() => validateContinuationCheckpoint(crossTurn)).toThrow('CHECKPOINT_IDENTITY_MISMATCH')

    const orphan = snapshot()
    orphan.events[3] = event(4, 'tool-call-not-dispatched', { toolCallId: 'orphan' })
    expect(() => validateContinuationCheckpoint(orphan)).toThrow('CHECKPOINT_TOOL_PAIR_CONFLICT')

    const duplicated = snapshot()
    duplicated.events.splice(5, 0, event(6, 'tool-call-finished', { toolCallId: 'tool-1', replayContent: 'duplicate' }))
    duplicated.events.forEach((item, index) => { item.sequence = index + 1 })
    expect(() => validateContinuationCheckpoint(duplicated)).toThrow('CHECKPOINT_TOOL_PAIR_CONFLICT')

    const denied = snapshot()
    denied.events[denied.events.length - 1] = event(6, 'invocation-failed', { status: 'denied', reason: 'POLICY_DENY' })
    expect(() => validateContinuationCheckpoint(denied)).toThrow('SAFETY_REJECTION_NOT_RECOVERABLE')
  })

  it('checkpoint 占用 insert 失败会回滚，不留下半条记录', () => {
    const conn = db()
    conn.exec(`CREATE TRIGGER reject_continuation BEFORE INSERT ON agent_continuations BEGIN SELECT RAISE(ABORT, 'injected continuation failure'); END`)
    expect(() => createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'rollback', createdBy: 'u', frozenConfig: {} }))
      .toThrow('injected continuation failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_continuations').get()).toEqual({ count: 0 })
    conn.close()
  })

  it('目标 continuation History 初始化失败时同时回滚占用记录与 stream', () => {
    const conn = db()
    conn.exec(`CREATE TRIGGER reject_continuation_history BEFORE INSERT ON agent_history_events BEGIN SELECT RAISE(ABORT, 'injected target history failure'); END`)
    expect(() => createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'history-rollback', createdBy: 'u', frozenConfig: {} }))
      .toThrow('injected target history failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_continuations').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_streams').get()).toEqual({ count: 0 })
    conn.close()
  })

  it('规范化冻结配置摘要不受对象 key 顺序影响', () => {
    const conn = db()
    const source = snapshot()
    const first = createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'stable-config', createdBy: 'u', frozenConfig: { model: 'm', nested: { a: 1, b: 2 } } })
    expect(createOrGetAgentContinuation({ conn, snapshot: source, sessionId: 'session-1', requestIdempotencyKey: 'stable-config', createdBy: 'u', frozenConfig: { nested: { b: 2, a: 1 }, model: 'm' } }).continuationId).toBe(first.continuationId)
    conn.close()
  })

  it('continuation status 只允许 running 进入单一终态', () => {
    const conn = db()
    const record = createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'status', createdBy: 'u', frozenConfig: {} })
    expect(setAgentContinuationStatus(conn, record.continuationId, 'completed', 10)).toBe(false)
    expect(claimAgentContinuation(conn, record.continuationId, {}, 11)).toBe(true)
    expect(setAgentContinuationStatus(conn, record.continuationId, 'completed', 12)).toBe(true)
    expect(setAgentContinuationStatus(conn, record.continuationId, 'failed', 13)).toBe(false)
    expect(conn.prepare('SELECT status FROM agent_continuations WHERE continuation_id=?').get(record.continuationId)).toEqual({ status: 'completed' })
    conn.close()
  })

  it('executor terminal 可按 targetTurnId 收敛 continuation，且只更新一次', () => {
    const conn = db()
    const record = createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'terminal-status', createdBy: 'u', frozenConfig: {} })
    expect(claimAgentContinuation(conn, record.continuationId, {})).toBe(true)
    expect(setAgentContinuationStatusForTurn(conn, record.targetTurnId, 'failed', 14)).toBe(true)
    expect(setAgentContinuationStatusForTurn(conn, record.targetTurnId, 'completed', 15)).toBe(false)
    expect(conn.prepare('SELECT status FROM agent_continuations WHERE continuation_id=?').get(record.continuationId)).toEqual({ status: 'failed' })
    conn.close()
  })

  it('重启后将无工具派发的 running 收敛为 interrupted，后续显式点击以新身份重试', () => {
    const conn = db()
    const record = createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'crash-before-tool', createdBy: 'u', frozenConfig: {} })
    expect(claimAgentContinuation(conn, record.continuationId, {})).toBe(true)
    expect(reconcileRunningAgentContinuations(conn, true, 20)).toEqual({ interrupted: 1, unknownSideEffect: 0, settled: 0 })
    expect(conn.prepare('SELECT status FROM agent_continuations WHERE continuation_id=?').get(record.continuationId)).toEqual({ status: 'interrupted' })
    expect(claimAgentContinuation(conn, record.continuationId, {})).toBe(false)
    const retry = createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'explicit-retry', createdBy: 'u', frozenConfig: {}, newId: (() => { let id = 0; return () => `retry-${++id}` })(), now: () => 21 })
    expect(retry).toMatchObject({ continuationId: record.continuationId, status: 'pending', targetInvocationId: 'retry-1', targetTurnId: 'retry-2' })
    expect(retry.targetInvocationId).not.toBe(record.targetInvocationId)
    expect(claimAgentContinuation(conn, retry.continuationId, {}, 22)).toBe(true)
    conn.close()
  })

  it('重启时存在未结算的工具派发记录则标记 unknown_side_effect，不自动重放', () => {
    const conn = db()
    const record = createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'crash-after-tool-dispatch', createdBy: 'u', frozenConfig: {} })
    expect(claimAgentContinuation(conn, record.continuationId, {})).toBe(true)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(record.targetInvocationId, 2, 'tool-started', 'tool-started', record.targetTurnId, 1, 'tool-call-started', JSON.stringify({ toolCallId: 'external-write' }), 11)
    expect(reconcileRunningAgentContinuations(conn, true, 20)).toEqual({ interrupted: 0, unknownSideEffect: 1, settled: 0 })
    expect(conn.prepare('SELECT status FROM agent_continuations WHERE continuation_id=?').get(record.continuationId)).toEqual({ status: 'unknown_side_effect' })
    expect(claimAgentContinuation(conn, record.continuationId, {})).toBe(false)
    expect(() => createOrGetAgentContinuation({ conn, snapshot: snapshot(), sessionId: 'session-1', requestIdempotencyKey: 'unsafe-explicit-retry', createdBy: 'u', frozenConfig: {} })).toThrow('CONTINUATION_ALREADY_CLAIMED')
    conn.close()
  })

  it('creates the continuation Turn with the claimed checkpoint identity and runs once per idempotency key', async () => {
    const appDb = openDatabase(':memory:')
    const session = createSession(appDb, { name: 'continuation-service' })
    const user = appendMessage(appDb, { id: 'continued-user', sessionId: session.id, role: 'user', content: 'start', timestamp: 1, status: 'sent' })
    const snapshotValue = snapshot()
    ;((snapshotValue.events[0]!.payload as { requiredUserMessage: { id: string } }).requiredUserMessage).id = user.message.id
    const safety = { workDirProfileId: 'profile', workDirSha256: 'a'.repeat(64), authorizationVersion: 'auth', toolSetSha256: 'tools', executionConfigSha256: 'd'.repeat(64) }
    const config = { lane: 'desktop' as const, model: 'm', continuationSafetySnapshot: safety }
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(appDb), deps: { now: () => 10, id: (() => { let i = 0; return () => `runtime-${++i}` })() } })
    const { startAgentContinuation } = await import('./agentContinuation')
    const started = await startAgentContinuation({
      conn: getDbConnection(appDb), snapshot: snapshotValue, sessionId: session.id, userMessageId: user.message.id,
      requestIdempotencyKey: 'start-once', createdBy: session.id, frozenConfig: config, runtime, executionConfig: config
    })
    expect(started).toMatchObject({ accepted: true, turn: { requestId: started.continuation.targetInvocationId, turnId: started.continuation.targetTurnId } })
    expect(started.turn?.startToken).toBe(started.continuation.targetStartToken)
    expect(started.turn?.executionConfig?.continuationSource).toEqual({
      continuationId: started.continuation.continuationId, invocationId: started.continuation.sourceInvocationId, sourceTurnId: started.continuation.sourceTurnId,
      checkpointSequence: started.continuation.checkpointSequence, checkpointSha256: started.continuation.checkpointSha256
    })
    const duplicate = await startAgentContinuation({
      conn: getDbConnection(appDb), snapshot: snapshotValue, sessionId: session.id, userMessageId: user.message.id,
      requestIdempotencyKey: 'start-once', createdBy: session.id, frozenConfig: config, runtime, executionConfig: config
    })
    expect(duplicate.started).toBe(false)
    expect(duplicate.continuation.targetTurnId).toBe(started.continuation.targetTurnId)
    appDb.close()
  })
})
