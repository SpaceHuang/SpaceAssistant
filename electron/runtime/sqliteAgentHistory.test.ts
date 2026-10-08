import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import { runMigrations } from '../database/migrations'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { runInTransaction } from '../database/transaction'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { reconcileTerminalContentSegments, SqliteAgentHistory } from './sqliteAgentHistory'
import { CREATE_TABLES_SQL } from '../database/schema'
import { ensureCompactionTransaction, ensureFinalRequestContextEvent, ensureRequestProjectionEvents, ensureRequestRetryEvent, ensureRequestUsageEvent, ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, getSessionEventSink, readSessionEvents } from '../sessionEvents'
import { claimSessionExecution, markSessionExecutionStarted } from '../database/sessionTranscript'
import { createMemoryAppDb } from '../database/testHelpers'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { appendMessage, createSession } from '../database/operations'
import { certifyCanonicalSessionApiRead, setCanonicalApiReadFeatureEnabled } from '../sessionStorage/certification'
import { markSessionMessageContentWriteStopped } from '../sessionStorage/maintenance'
import { enableCanonicalSessionWriteAuthority } from './sessionContentWriteAuthority'
import { createSpillStore, reconcileSpillOrphansAgainstCanonicalHistory, type SpillStore } from '../storage/spillStore'
import { buildAssistantActivityTimeline } from '../../src/shared/assistantActivityTimeline'

function createDb(dbPath = ':memory:'): DatabaseSync {
  const conn = new DatabaseSync(dbPath)
  conn.exec(CREATE_TABLES_SQL)
  conn.prepare('INSERT OR IGNORE INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '15')
  runMigrations(conn)
  return conn
}

const event = (id: string, sequence: number): HistoryEvent => ({
  invocationId: 'inv-1', turnId: 'turn-1', sequence, schemaVersion: 1, eventId: id,
  idempotencyKey: `client:${id}`, kind: sequence === 1 ? 'tool-call-started' : 'tool-call-finished', payload: { id }
})

describe('SqliteAgentHistory', () => {
  it('fails closed before provider context or interrupted-turn recovery can use a missing source spill', async () => {
    const temp = createTempDatabase('history-spill-fail-closed-')
    const conn = getDbConnection(temp.db)
    const sessionId = 'spill-recovery-fail-closed'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const root = path.join(path.dirname(temp.dbPath), 'spill')
    const store = createSpillStore(root)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const sourceBody = 'provider and recovery source body '.repeat(3_000)
    await history.appendBatch([{
      invocationId: 'spill-recovery-invocation', turnId: 'spill-recovery-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-recovery-context', idempotencyKey: 'spill-recovery-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'u', role: 'user', content: sourceBody }] }
    }], 0)
    const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-recovery-context')!.payload_json as string) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    await fs.rm(path.join(root, stored.messages[0]!.content.__spaceassistant_spill_v1.locator))
    expect(() => history.readSync('spill-recovery-invocation')).toThrowError(expect.objectContaining({ code: 'SPILL_CONTENT_UNAVAILABLE' }))
    await expect(history.recoverInterruptedInvocations()).rejects.toThrowError(expect.objectContaining({ code: 'SPILL_CONTENT_UNAVAILABLE' }))
    temp.cleanup()
  })

  it('writes the SDK result transcript in the same transaction that appends its terminal event', async () => {
    const conn = createDb()
    const sessionId = 'sdk-terminal-commit-session'
    const turnId = 'sdk-terminal-commit-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES(?,?, 'process',1,'executing',1,1)`).run(sessionId, turnId)
    conn.prepare(`INSERT INTO session_execution_queue(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES(?,?, 'process',1,'executing',1,1)`).run(sessionId, turnId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const registry = new ModelProviderRegistry()
    registry.register({ routeId: 'sdk-terminal-commit', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'sdk-terminal-commit-provider', stream: async function* () {
        yield { type: 'text-delta', text: 'answer' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const permits = new InMemorySafetyPermitStore()
    await runAgentTurn({
      registry, routeId: 'sdk-terminal-commit', invocationId: 'sdk-terminal-commit-invocation', sessionId, turnId,
      sessionTranscriptBaseVersion: 0,
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 10 }, maxModelTurns: 1, history,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(),
      toolExecution: createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(),
        resolveExpected: async () => { throw new Error('tool execution is not expected') }, execute: async () => ({ output: undefined }) })
    })

    expect(conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get(sessionId))
      .toEqual({ version: 1, last_turn_id: turnId, status: 'ready' })
    expect(conn.prepare('SELECT outcome,event_start,event_end FROM session_turn_commit_receipts WHERE session_id=?').get(sessionId))
      .toMatchObject({ outcome: 'completed', event_start: 1, event_end: expect.any(Number) })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(sessionId)).toEqual({ status: 'transcript_committed' })
    expect(conn.prepare("SELECT kind FROM agent_history_events WHERE invocation_id=? ORDER BY sequence DESC LIMIT 1").get('sdk-terminal-commit-invocation'))
      .toEqual({ kind: 'invocation-completed' })
    conn.close()
  })

  it('commits the accepted user transcript with a provider-failure terminal event', async () => {
    const conn = createDb()
    const sessionId = 'sdk-failed-terminal-session'
    const turnId = 'sdk-failed-terminal-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES(?,?, 'process',1,'executing',1,1)`).run(sessionId, turnId)
    conn.prepare(`INSERT INTO session_execution_queue(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES(?,?, 'process',1,'executing',1,1)`).run(sessionId, turnId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const registry = new ModelProviderRegistry()
    registry.register({ routeId: 'sdk-failed-terminal', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'sdk-failed-terminal-provider', stream: async function* () { throw new Error('provider failed') }
    })
    const permits = new InMemorySafetyPermitStore()
    await expect(runAgentTurn({
      registry, routeId: 'sdk-failed-terminal', invocationId: 'sdk-failed-terminal-invocation', sessionId, turnId,
      sessionTranscriptBaseVersion: 0, sessionTranscriptFailureMessages: [{ role: 'user', content: 'question' }],
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 10 }, maxModelTurns: 1, history,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(),
      toolExecution: createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(),
        resolveExpected: async () => { throw new Error('tool execution is not expected') }, execute: async () => ({ output: undefined }) })
    })).rejects.toThrow('provider failed')

    expect(conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get(sessionId))
      .toEqual({ version: 1, last_turn_id: turnId, status: 'ready' })
    expect(conn.prepare('SELECT outcome FROM session_turn_commit_receipts WHERE session_id=?').get(sessionId)).toEqual({ outcome: 'failed' })
    expect(conn.prepare("SELECT kind FROM agent_history_events WHERE invocation_id=? ORDER BY sequence DESC LIMIT 1").get('sdk-failed-terminal-invocation'))
      .toEqual({ kind: 'invocation-failed' })
    conn.close()
  })

  it('commits the canonical terminal event with its transcript receipt, checkpoint and execution fence', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('atomic-terminal-session','s','m',0.7,1,1,1,'{}','{}',1,'generation')`).run()
    const owner = claimSessionExecution(db, { sessionId: 'atomic-terminal-session', turnId: 'atomic-terminal-turn', ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    expect(markSessionExecutionStarted(db, { sessionId: 'atomic-terminal-session', turnId: 'atomic-terminal-turn', ownerId: 'process', generation: owner.generation })).toBe(true)
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'atomic-terminal-session')
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-terminal-assistant','atomic-terminal-session','assistant','beforeafter','streaming',1,10,0)`).run()
    conn.prepare('UPDATE messages SET content_segments=? WHERE id=?')
      .run(JSON.stringify([{ content: 'before', startTime: 1, endTime: 2 }, { content: 'after', startTime: 4, endTime: 5 }]), 'atomic-terminal-assistant')
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('atomic-terminal-turn','atomic-terminal-request','atomic-terminal-session','atomic-terminal-assistant','executing',1,1,0)`).run()
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical',write_mode='dual-write'
      WHERE session_id='atomic-terminal-session'`).run()
    conn.prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)`)
      .run('atomic-terminal-session', 'generation')
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,1,0,1,'seed-event','seed-invocation',1,1)`)
      .run('atomic-terminal-session', 'generation')
    const terminal: HistoryEvent = { ...event('atomic-terminal', 1), invocationId: 'atomic-terminal-invocation', turnId: 'atomic-terminal-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    const intent = { sessionId: 'atomic-terminal-session', baseVersion: 0, outcome: 'completed' as const,
      messages: [{ role: 'user', content: 'accepted' }, { id: 'atomic-terminal-assistant', role: 'assistant', content: 'beforeafter' }],
      messageMirror: { messageId: 'atomic-terminal-assistant', status: 'completed' as const, content: 'beforeafter' } }

    await history.appendBatch([terminal], 0, intent)

    expect(conn.prepare('SELECT kind,session_seq FROM agent_history_events WHERE event_id=?').get('atomic-terminal'))
      .toEqual({ kind: 'invocation-completed', session_seq: 1 })
    expect(conn.prepare('SELECT base_version,next_version,outcome,event_start,event_end FROM session_turn_commit_receipts WHERE session_id=?').get('atomic-terminal-session'))
      .toMatchObject({ base_version: 0, next_version: 1, outcome: 'completed', event_start: 1, event_end: 1 })
    expect(conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get('atomic-terminal-session'))
      .toEqual({ version: 1, last_turn_id: 'atomic-terminal-turn', status: 'ready' })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('atomic-terminal-session'))
      .toEqual({ status: 'transcript_committed' })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('atomic-terminal-assistant'))
      .toEqual({ content: 'beforeafter', status: 'completed' })
    const persistedSegments = JSON.parse(conn.prepare('SELECT content_segments FROM messages WHERE id=?').get('atomic-terminal-assistant')!.content_segments as string)
    expect(persistedSegments).toEqual([{ content: 'before', startTime: 1, endTime: 2 }, { content: 'after', startTime: 4, endTime: 5 }])
    expect(buildAssistantActivityTimeline({ content: 'beforeafter', contentSegments: persistedSegments,
      toolCalls: [{ id: 'tool-1', toolName: 'lookup', input: {}, status: 'completed', startedAt: 3 }], timestamp: 0 })
      .map((item) => item.kind)).toEqual(['text', 'tool', 'text'])
    expect(conn.prepare(`SELECT message_revision,api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
      .get('atomic-terminal-session')).toEqual({ message_revision: 3, api_read_mode: 'revalidation-required', write_mode: 'dual-write', cleanup_state: 'retained' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility WHERE session_id=?').get('atomic-terminal-session')).toBeUndefined()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get('atomic-terminal-session')).toBeUndefined()
    db.close()
  })

  it('reconciles a stale partial checkpoint to the final body when it cannot preserve its text segments', () => {
    expect(reconcileTerminalContentSegments(JSON.stringify([
      { content: 'short checkpoint', startTime: 20, endTime: 21 }
    ]), 'canonical answer', 30)).toEqual([{ content: 'canonical answer', startTime: 30, endTime: 30 }])
  })

  it('corrects stale segments after a real response mirror has already replaced the checkpoint body', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'stale-terminal-segments-session'
    const turnId = 'stale-terminal-segments-turn'
    const messageId = 'stale-terminal-segments-assistant'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId, ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    expect(markSessionExecutionStarted(db, { sessionId, turnId, ownerId: 'process', generation: owner.generation })).toBe(true)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,content_segments,schema_version,timestamp,sequence)
      VALUES(?,?, 'assistant','short checkpoint','streaming',?,1,10,0)`).run(messageId, sessionId,
      JSON.stringify([{ content: 'short checkpoint', startTime: 20, endTime: 21 }]))
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?,?,?,?,'executing',1,1,0)`).run(turnId, `${turnId}-request`, sessionId, messageId)
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical',write_mode='dual-write' WHERE session_id=?`).run(sessionId)
    conn.prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,1)`)
      .run(sessionId, 'generation')
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,1,0,1,'seed-event','seed-invocation',1,1)`)
      .run(sessionId, 'generation')
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await history.appendBatch([{ ...event('stale-response-event', 1), invocationId: 'stale-invocation', turnId,
      kind: 'model-response-committed', payload: { message: { id: messageId, role: 'assistant', content: [
        { type: 'text', text: 'canonical answer' }
      ] } } }], 0)
    expect(conn.prepare('SELECT content,content_segments FROM messages WHERE id=?').get(messageId)).toEqual({
      content: 'canonical answer', content_segments: JSON.stringify([{ content: 'short checkpoint', startTime: 20, endTime: 21 }])
    })

    const terminal: HistoryEvent = { ...event('stale-terminal-event', 2), invocationId: 'stale-invocation', turnId,
      kind: 'invocation-completed', payload: { status: 'completed' } }
    await history.appendBatch([terminal], 1, { sessionId, baseVersion: 0, outcome: 'completed',
      messages: [{ role: 'user', content: 'accepted' }, { id: messageId, role: 'assistant', content: 'canonical answer' }],
      messageMirror: { messageId, status: 'completed', content: 'canonical answer' } })

    const completed = conn.prepare('SELECT content,status,content_segments FROM messages WHERE id=?').get(messageId) as
      { content: string; status: string; content_segments: string }
    expect(completed).toMatchObject({ content: 'canonical answer', status: 'completed' })
    expect(JSON.parse(completed.content_segments)).toEqual([{ content: 'canonical answer', startTime: 100, endTime: 100 }])
    db.close()
  })

  it('does not restore cleared legacy content when committing a canonical-backed-only terminal mirror', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'canonical-only-terminal-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId: 'canonical-only-terminal-turn', ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    expect(markSessionExecutionStarted(db, { sessionId, turnId: 'canonical-only-terminal-turn', ownerId: 'process', generation: owner.generation })).toBe(true)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence,content_storage_state)
      VALUES('canonical-only-terminal-assistant',?,'assistant','','streaming',1,10,0,'canonical-backed-only')`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('canonical-only-terminal-turn','canonical-only-terminal-request',?,'canonical-only-terminal-assistant','executing',1,1,0)`).run(sessionId)
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical',write_mode='canonical'
      WHERE session_id=?`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const terminal: HistoryEvent = { ...event('canonical-only-terminal-event', 1), invocationId: 'canonical-only-terminal-invocation', turnId: 'canonical-only-terminal-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    const intent = { sessionId, baseVersion: 0, outcome: 'completed' as const,
      messages: [{ role: 'user', content: 'accepted' }, { id: 'canonical-only-terminal-assistant', role: 'assistant', content: 'canonical answer' }],
      messageMirror: { messageId: 'canonical-only-terminal-assistant', status: 'completed' as const, content: 'canonical answer' } }

    await history.appendBatch([terminal], 0, intent)

    expect(conn.prepare('SELECT content,status,content_storage_state FROM messages WHERE id=?').get('canonical-only-terminal-assistant'))
      .toEqual({ content: '', status: 'completed', content_storage_state: 'canonical-backed-only' })
    db.close()
  })

  it('atomically mirrors a stable assistant response into its streaming legacy row', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-response-mirror-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-response-assistant',?,'assistant','initial checkpoint','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('atomic-response-turn','atomic-response-request',?,'atomic-response-assistant','executing',1,1,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    await history.appendBatch([{ ...event('atomic-response-event', 1), invocationId: 'atomic-response-invocation', turnId: 'atomic-response-turn', kind: 'model-response-committed',
      payload: { message: { id: 'atomic-response-assistant', role: 'assistant', content: [
        { type: 'text', text: 'provider response' }, { type: 'thinking', thinking: 'private reasoning' }
      ] } } }], 0)

    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('atomic-response-assistant'))
      .toEqual({ content: 'provider response', status: 'streaming' })
    expect(conn.prepare('SELECT kind FROM agent_history_events WHERE event_id=?').get('atomic-response-event'))
      .toEqual({ kind: 'model-response-committed' })
    db.close()
  })

  it('does not restore cleared legacy content when mirroring a canonical-backed-only streaming response', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'canonical-only-streaming-response-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence,content_storage_state)
      VALUES('canonical-only-streaming-assistant',?,'assistant','','streaming',1,10,0,'canonical-backed-only')`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('canonical-only-streaming-turn','canonical-only-streaming-request',?,'canonical-only-streaming-assistant','executing',1,1,0)`).run(sessionId)
    conn.prepare(`UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await history.appendBatch([{ ...event('canonical-only-streaming-event', 1), invocationId: 'canonical-only-streaming-invocation',
      turnId: 'canonical-only-streaming-turn', kind: 'model-response-committed',
      payload: { message: { id: 'canonical-only-streaming-assistant', role: 'assistant', content: 'provider response' } } }], 0)

    expect(conn.prepare('SELECT content,status,content_storage_state FROM messages WHERE id=?').get('canonical-only-streaming-assistant'))
      .toEqual({ content: '', status: 'streaming', content_storage_state: 'canonical-backed-only' })
    expect(conn.prepare('SELECT kind FROM agent_history_events WHERE event_id=?').get('canonical-only-streaming-event'))
      .toEqual({ kind: 'model-response-committed' })
    db.close()
  })

  it('preserves UI bodies during compaction while atomically mirroring a distinct committed assistant response', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'compaction-response-mirror-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES
      ('compaction-response-user',?,'user','full UI prompt','sent',1,10,0),
      ('compaction-response-assistant',?,'assistant','assistant checkpoint','streaming',1,11,1)`).run(sessionId, sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('compaction-response-turn','compaction-response-request',?,'compaction-response-assistant','executing',1,1,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([
      { ...event('compaction-response-snapshot-event', 1), invocationId: 'compaction-response-invocation', turnId: 'compaction-response-turn', kind: 'transcript-compacted',
        payload: { messages: [{ id: 'compaction-response-user', role: 'user', content: 'provider summary', timestamp: 10 }] } },
      { ...event('compaction-response-model-event', 2), invocationId: 'compaction-response-invocation', turnId: 'compaction-response-turn', kind: 'model-response-committed',
        payload: { message: { id: 'compaction-response-assistant', role: 'assistant', content: 'committed answer' } } }
    ], 0)).resolves.toMatchObject({ version: 2, duplicate: false })

    expect(conn.prepare('SELECT id,content,status FROM messages WHERE id IN (?,?) ORDER BY id').all(
      'compaction-response-user', 'compaction-response-assistant'
    )).toEqual([
      { id: 'compaction-response-assistant', content: 'committed answer', status: 'streaming' },
      { id: 'compaction-response-user', content: 'full UI prompt', status: 'sent' }
    ])
    expect((await history.read('compaction-response-invocation')).events.map(({ kind }) => kind))
      .toEqual(['transcript-compacted', 'model-response-committed'])
    db.close()
  })

  it('revokes stale API eligibility when a canonical compaction changes the transcript without changing the message skeleton', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'compaction-invalidates-api-eligibility-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('compaction-eligibility-user',?,'user','full UI prompt','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    await history.appendBatch([{ ...event('compaction-eligibility-context-event', 1), invocationId: 'compaction-eligibility-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'compaction-eligibility-user', role: 'user', content: 'full UI prompt', timestamp: 10 }] } }], 0)
    const watermark = conn.prepare(`SELECT session_seq,commit_order,event_id,invocation_id FROM agent_history_events WHERE event_id=?`)
      .get('compaction-eligibility-context-event') as { session_seq: number; commit_order: number; event_id: string; invocation_id: string }
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?`).run(sessionId)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,1,?,?,?,?,?,1)`)
      .run(sessionId, 'generation', watermark.session_seq, watermark.commit_order, watermark.event_id, watermark.invocation_id, 1)

    await history.appendBatch([{ ...event('compaction-eligibility-snapshot-event', 2), invocationId: 'compaction-eligibility-invocation', kind: 'transcript-compacted',
      payload: { messages: [{ id: 'compaction-eligibility-user', role: 'user', content: 'provider summary', timestamp: 10 }] } }], 1)

    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').all(sessionId)).toEqual([])
    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(sessionId))
      .toEqual({ api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('compaction-eligibility-user'))
      .toEqual({ content: 'full UI prompt' })
    db.close()
  })

  it('preserves API eligibility when an already committed History event is replayed idempotently', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'idempotent-history-eligibility-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const committed: HistoryEvent = { ...event('idempotent-eligibility-event', 1), invocationId: 'idempotent-eligibility-invocation',
      kind: 'transcript-compacted', payload: { messages: [{ role: 'user', content: 'same provider snapshot' }] } }
    await history.appendBatch([committed], 0)
    const watermark = conn.prepare(`SELECT session_seq,commit_order,event_id,invocation_id FROM agent_history_events WHERE event_id=?`)
      .get(committed.eventId) as { session_seq: number; commit_order: number; event_id: string; invocation_id: string }
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?`).run(sessionId)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,0,?,?,?,?,?,1)`)
      .run(sessionId, 'generation', watermark.session_seq, watermark.commit_order, watermark.event_id, watermark.invocation_id, 1)

    await expect(history.appendBatch([committed], 0)).resolves.toMatchObject({ version: 1, duplicate: true })
    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(sessionId))
      .toEqual({ api_read_mode: 'canonical' })
    expect(conn.prepare('SELECT session_id,canonical_session_seq,watermark_event_id FROM canonical_session_api_context_eligibility WHERE session_id=?')
      .get(sessionId)).toEqual({ session_id: sessionId, canonical_session_seq: watermark.session_seq, watermark_event_id: watermark.event_id })
    db.close()
  })

  it('invalidates API eligibility when a caller appends directly through the shared History transaction primitive', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'direct-history-eligibility-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?`).run(sessionId)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,0,0,0,NULL,NULL,1,1)`)
      .run(sessionId, 'generation')
    const directEvent: HistoryEvent = { ...event('direct-append-compaction', 1), invocationId: 'direct-append-invocation',
      kind: 'transcript-compacted', payload: { messages: [{ role: 'user', content: 'provider summary' }] } }

    runInTransaction(conn, () => appendSqliteAgentHistoryBatchInTransaction(conn, [directEvent], 0,
      { schemaVersion: 1, sessionId, now: () => 2 }))

    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(sessionId))
      .toEqual({ api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').all(sessionId)).toEqual([])
    db.close()
  })

  it('rejects a malformed canonical assistant response before persisting it', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'malformed-response-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{
      ...event('malformed-response-event', 1), invocationId: 'malformed-response-invocation',
      kind: 'model-response-committed', payload: { finishReason: 'stop' }
    }], 0)).rejects.toThrow('canonical assistant response payload is invalid')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('malformed-response-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it.each([
    ['payload null', null],
    ['messages missing', {}],
    ['messages not an array', { messages: 'not-a-message-list' }],
    ['message is not an object', { messages: [null] }],
    ['message role is unsupported', { messages: [{ role: 'developer', content: 'invalid' }] }],
    ['message content block is unsupported', { messages: [{ role: 'user', content: [{ type: 'audio', data: 'invalid' }] }] }],
    ['tool result has no proposal', { messages: [{ role: 'tool', toolCallId: 'missing-call', content: 'result', isError: false }] }]
  ] as const)('rejects a malformed canonical invocation context (%s) before persisting it', async (_caseName, payload) => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = `malformed-context-${_caseName.replaceAll(' ', '-')}-session`
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{
      ...event(`malformed-context-${_caseName.replaceAll(' ', '-')}-event`, 1),
      invocationId: `malformed-context-${_caseName.replaceAll(' ', '-')}-invocation`,
      kind: 'invocation-context-committed', payload
    }], 0)).rejects.toThrow('canonical invocation context payload is invalid')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE invocation_id=?').get(`malformed-context-${_caseName.replaceAll(' ', '-')}-invocation`))
      .toEqual({ count: 0 })
    db.close()
  })

  it('accepts a canonical invocation snapshot ending in an unresolved assistant tool proposal', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'pending-context-tool-proposal-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('pending-context-tool-proposal-event', 1), invocationId: 'pending-context-tool-proposal-invocation',
      kind: 'invocation-context-committed', payload: { messages: [
        { role: 'assistant', toolCalls: [{ id: 'pending-proposal', name: 'lookup', input: { query: 'q' } }] }
      ] } }], 0)).resolves.toMatchObject({ version: 1, duplicate: false })
    db.close()
  })

  it('rejects a malformed canonical compaction snapshot before persisting it', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'malformed-compaction-snapshot-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('malformed-compaction-snapshot-event', 1), invocationId: 'malformed-compaction-snapshot-invocation',
      kind: 'transcript-compacted', payload: { messages: [{ role: 'user', content: [{ type: 'audio', data: 'unsupported' }] }] } }], 0))
      .rejects.toThrow('canonical transcript snapshot payload is invalid')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('malformed-compaction-snapshot-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects a malformed canonical replay message before persisting it', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'malformed-replay-message-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('malformed-replay-message-event', 1), invocationId: 'malformed-replay-message-invocation',
      kind: 'replay-message-committed', payload: { message: { role: 'user', content: [{ type: 'audio', data: 'unsupported' }] } } }], 0))
      .rejects.toThrow('canonical replay message is invalid')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('malformed-replay-message-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects a canonical replay message with an empty stable ID before persisting it', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'empty-id-replay-message-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('empty-id-replay-message-event', 1), invocationId: 'empty-id-replay-message-invocation',
      kind: 'replay-message-committed', payload: { message: { id: '', role: 'user', content: 'continue' } } }], 0))
      .rejects.toThrow('canonical replay message is invalid')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('empty-id-replay-message-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('persists an output-recovery replay message without a UI message ID as canonical-only history', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'canonical-only-replay-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const replay = { role: 'user', content: '[runtime output recovery] continue the original request' } as const

    await expect(history.appendBatch([{ ...event('canonical-only-replay-event', 1), invocationId: 'canonical-only-replay-invocation',
      kind: 'replay-message-committed', payload: { message: replay } }], 0)).resolves.toMatchObject({ version: 1, duplicate: false })
    const read = history.readCanonicalSessionTranscriptForShadow(sessionId)
    expect(read).toMatchObject({ kind: 'matched', messages: [] })
    if (read.kind !== 'matched') throw new Error(`unexpected canonical transcript read: ${read.reason}`)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId)).toEqual({ count: 0 })
    db.close()
  })

  it('keeps an anonymous output-recovery replay in the watermark while session transcript matches the UI row', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'session-replay-with-ui-base'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('replay-ui-user',?,'user','original request','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    await history.appendBatch([
      { ...event('replay-ui-context-event', 1), invocationId: 'replay-ui-invocation', kind: 'invocation-context-committed', payload: {
        messages: [{ id: 'replay-ui-user', role: 'user', content: 'original request', timestamp: 10 }]
      } }
    ], 0)
    const baseline = history.readCanonicalSessionTranscriptForShadow(sessionId)
    expect(baseline.kind).toBe('matched')
    if (baseline.kind !== 'matched') throw new Error(`unexpected baseline read: ${baseline.reason}`)
    expect(history.writeCanonicalSessionCache({ ...baseline, cacheKey: 'replay-transcript', value: JSON.stringify(baseline.messages) })).toBe(true)

    await history.appendBatch([{ ...event('replay-ui-anonymous-replay-event', 1), invocationId: 'replay-ui-replay-invocation', kind: 'replay-message-committed', payload: {
        message: { role: 'user', content: '[runtime output recovery] continue the original request' }
      } }], 0)

    expect(history.readCanonicalSessionTranscriptWithCache(sessionId, 'replay-transcript', [
      { id: 'replay-ui-user', role: 'user', content: 'original request', timestamp: 10 }
    ])).toMatchObject({ kind: 'matched', source: 'L1', replayedEvents: 1, messages: [{ id: 'replay-ui-user' }], watermark: {
      watermarkEventId: 'replay-ui-anonymous-replay-event', eventCount: 2
    } })
    expect((await history.read('replay-ui-replay-invocation')).events.map((entry) => entry.kind)).toEqual(['replay-message-committed'])
    db.close()
  })

  it('rejects an assistant response block that has no exact legacy content projection', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'unprojectable-response-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('unprojectable-response-assistant',?,'assistant','legacy checkpoint','streaming',1,1,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
      VALUES('unprojectable-response-turn','unprojectable-response-request',?,'unprojectable-response-assistant','executing',1,1)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{
      ...event('unprojectable-response-event', 1), invocationId: 'unprojectable-response-invocation', turnId: 'unprojectable-response-turn',
      kind: 'model-response-committed', payload: { message: { id: 'unprojectable-response-assistant', role: 'assistant', content: [
        { type: 'audio', data: 'no legacy text projection' }
      ] } }
    }], 0)).rejects.toThrow('canonical assistant response content cannot be mirrored exactly')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('unprojectable-response-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('unprojectable-response-assistant'))
      .toEqual({ content: 'legacy checkpoint', status: 'streaming' })
    db.close()
  })

  it('rejects a canonical assistant response ID owned by another turn', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-response-cross-turn-session'
    const turnId = 'atomic-response-current-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES
      ('current-response-assistant',?,'assistant','current checkpoint','streaming',1,10,0),
      ('other-response-assistant',?,'assistant','other checkpoint','streaming',1,11,1)`).run(sessionId, sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'current-response-request',?,'current-response-assistant','executing',1,1,0)`).run(turnId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('cross-turn-response-event', 1), invocationId: 'cross-turn-response-invocation', turnId,
      kind: 'model-response-committed', payload: { message: { id: 'other-response-assistant', role: 'assistant', content: 'forged response' } } }], 0))
      .rejects.toThrow('canonical assistant response identity does not belong to the turn')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('cross-turn-response-event')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('other-response-assistant'))
      .toEqual({ content: 'other checkpoint', status: 'streaming' })
    db.close()
  })

  it('rejects a tool-call-only assistant response ID owned by another turn', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'tool-only-cross-turn-session'
    const turnId = 'tool-only-current-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES
      ('tool-only-current-assistant',?,'assistant','checkpoint','streaming',1,10,0),
      ('tool-only-other-assistant',?,'assistant','other checkpoint','streaming',1,11,1)`).run(sessionId, sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
      VALUES(?, 'tool-only-current-request',?,'tool-only-current-assistant','executing',1,1)`).run(turnId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('tool-only-cross-turn-event', 1), invocationId: 'tool-only-cross-turn-invocation', turnId,
      kind: 'model-response-committed', payload: { message: { id: 'tool-only-other-assistant', role: 'assistant',
        toolCalls: [{ id: 'tool-only-call', name: 'lookup', input: { query: 'q' } }] } } }], 0))
      .rejects.toThrow('canonical assistant response identity does not belong to the turn')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('tool-only-cross-turn-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects a stable assistant response ID when its legacy skeleton is not streaming', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-response-missing-skeleton-session'
    const turnId = 'atomic-response-missing-skeleton-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('missing-skeleton-assistant',?,'assistant','existing final body','completed',1,1,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'missing-skeleton-request',?,'missing-skeleton-assistant','executing',1,1,0)`).run(turnId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('missing-skeleton-response-event', 1), invocationId: 'missing-skeleton-response-invocation', turnId,
      kind: 'model-response-committed', payload: { message: { id: 'missing-skeleton-assistant', role: 'assistant', content: 'canonical response' } } }], 0))
      .rejects.toThrow('canonical assistant response mirror target is missing or not streaming')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('missing-skeleton-response-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('allows a turn-owned canonical assistant response without a legacy mirror ID', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'missing-response-id-session'
    const turnId = 'missing-response-id-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('assigned-response-assistant',?,'assistant','legacy checkpoint','streaming',1,1,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'missing-response-id-request',?,'assigned-response-assistant','executing',1,1,0)`).run(turnId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('missing-response-id-event', 1), invocationId: 'missing-response-id-invocation', turnId,
      kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'response without identity' } } }], 0))
      .resolves.toMatchObject({ version: 1, duplicate: false })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('missing-response-id-event'))
      .toEqual({ count: 1 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('assigned-response-assistant'))
      .toEqual({ content: 'legacy checkpoint', status: 'streaming' })
    db.close()
  })

  it('atomically mirrors the accepted required user message with its canonical base context', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-mirror-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,attachments,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user',?,'user','stale accepted body','[{"id":"attachment-a","fileName":"photo.png"}]','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    await history.appendBatch([{ ...event('atomic-user-context-event', 1), invocationId: 'atomic-user-context-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user', role: 'user', content: [
        { type: 'text', text: 'accepted canonical body' }, { type: 'image', mimeType: 'image/png', data: 'base64-image-data' }
      ] }], requiredUserMessage: { id: 'atomic-required-user', message: { role: 'user', content: [
        { type: 'text', text: 'accepted canonical body' }, { type: 'image', mimeType: 'image/png', data: 'base64-image-data' }
      ] } } } }], 0)

    expect(conn.prepare('SELECT content,attachments,status FROM messages WHERE id=?').get('atomic-required-user'))
      .toEqual({ content: 'accepted canonical body', attachments: '[{"id":"attachment-a","fileName":"photo.png"}]', status: 'sent' })
    expect(conn.prepare('SELECT kind FROM agent_history_events WHERE event_id=?').get('atomic-user-context-event'))
      .toEqual({ kind: 'invocation-context-committed' })
    db.close()
  })

  it('atomically mirrors stable-ID assistant bodies present in a new provider base context', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-context-assistant-mirror-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('context-assistant',?,'assistant','stale assistant body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await history.appendBatch([{ ...event('context-assistant-mirror-event', 1), invocationId: 'context-assistant-mirror-invocation',
      kind: 'invocation-context-committed', payload: { messages: [
        { id: 'context-assistant', role: 'assistant', content: 'canonical assistant body', timestamp: 10 }
      ] } }], 0)

    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('context-assistant'))
      .toEqual({ content: 'canonical assistant body', status: 'sent' })
    expect(conn.prepare('SELECT kind FROM agent_history_events WHERE event_id=?').get('context-assistant-mirror-event'))
      .toEqual({ kind: 'invocation-context-committed' })
    db.close()
  })

  it('rejects duplicate or cross-role stable IDs in a canonical context that targets desktop skeleton rows', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'context-mirror-duplicate-identity-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('context-shared-id',?,'user','stale body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('context-duplicate-identity-event', 1), invocationId: 'context-duplicate-identity-invocation',
      kind: 'invocation-context-committed', payload: { messages: [
        { id: 'context-shared-id', role: 'user', content: 'first body' },
        { id: 'context-shared-id', role: 'assistant', content: 'conflicting role body' }
      ] } }], 0)).rejects.toThrow('canonical context message identity is duplicated or conflicts with its legacy row')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('context-duplicate-identity-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,role FROM messages WHERE id=?').get('context-shared-id'))
      .toEqual({ content: 'stale body', role: 'user' })
    db.close()
  })

  it('rejects duplicate required-user IDs inside the context before mirroring the required-user field', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'context-required-user-duplicate-identity-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('context-required-user-shared-id',?,'user','legacy body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('context-required-user-duplicate-event', 1), invocationId: 'context-required-user-duplicate-invocation',
      kind: 'invocation-context-committed', payload: {
        messages: [
          { id: 'context-required-user-shared-id', role: 'user', content: 'accepted body' },
          { id: 'context-required-user-shared-id', role: 'user', content: 'accepted body' }
        ],
        requiredUserMessage: { id: 'context-required-user-shared-id', message: { role: 'user', content: 'accepted body' } }
      } }], 0)).rejects.toThrow('required user message does not match canonical context identity')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('context-required-user-duplicate-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('context-required-user-shared-id'))
      .toEqual({ content: 'legacy body' })
    db.close()
  })

  it('mirrors the accepted user while preserving another stable-ID streaming assistant row', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'context-mirror-intermediate-state-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES
      ('context-current-user',?,'user','stale accepted user','sent',1,10,0),
      ('context-streaming-assistant',?,'assistant','partial assistant','streaming',1,11,1)`).run(sessionId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('context-mirror-intermediate-event', 1), invocationId: 'context-mirror-intermediate-invocation',
      kind: 'invocation-context-committed', payload: {
        messages: [
          { id: 'context-streaming-assistant', role: 'assistant', content: 'unsafe partial', timestamp: 11 },
          { id: 'context-current-user', role: 'user', content: 'accepted user', timestamp: 10 }
        ],
        requiredUserMessage: { id: 'context-current-user', message: { role: 'user', content: 'accepted user' } }
      } }], 0)).resolves.toMatchObject({ version: 1, duplicate: false })

    expect(conn.prepare('SELECT id,content,status FROM messages WHERE id IN (?,?) ORDER BY id')
      .all('context-current-user', 'context-streaming-assistant')).toEqual([
      { id: 'context-current-user', content: 'accepted user', status: 'sent' },
      { id: 'context-streaming-assistant', content: 'partial assistant', status: 'streaming' }
    ])
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('context-mirror-intermediate-event'))
      .toEqual({ count: 1 })
    db.close()
  })

  it('preserves a failed assistant checkpoint while its owning turn is still executing', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'context-mirror-open-failed-turn-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('open-failed-assistant',?,'assistant','failure checkpoint','failed',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
      VALUES('open-failed-turn','open-failed-request',?,'open-failed-assistant','executing',1,1)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('open-failed-context-event', 1), invocationId: 'open-failed-context-invocation',
      kind: 'invocation-context-committed', payload: { messages: [
        { id: 'open-failed-assistant', role: 'assistant', content: 'canonical final answer', timestamp: 10 }
      ] } }], 0)).resolves.toMatchObject({ version: 1, duplicate: false })

    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('open-failed-assistant'))
      .toEqual({ content: 'failure checkpoint', status: 'failed' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('open-failed-context-event'))
      .toEqual({ count: 1 })
    db.close()
  })

  it('rolls back all context mirrors when a later legacy body update fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'context-mirror-update-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES
      ('context-failure-user',?,'user','stale user','sent',1,10,0),
      ('context-failure-assistant',?,'assistant','stale assistant','sent',1,11,1)`).run(sessionId, sessionId)
    conn.exec(`CREATE TRIGGER fail_context_assistant_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='context-failure-assistant' BEGIN SELECT RAISE(ABORT, 'injected context mirror failure'); END`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('context-mirror-failure-event', 1), invocationId: 'context-mirror-failure-invocation',
      kind: 'invocation-context-committed', payload: { messages: [
        { id: 'context-failure-user', role: 'user', content: 'canonical user', timestamp: 10 },
        { id: 'context-failure-assistant', role: 'assistant', content: 'canonical assistant', timestamp: 11 }
      ] } }], 0)).rejects.toThrow('injected context mirror failure')

    expect(conn.prepare('SELECT id,content FROM messages WHERE id IN (?,?) ORDER BY id')
      .all('context-failure-user', 'context-failure-assistant')).toEqual([
      { id: 'context-failure-assistant', content: 'stale assistant' },
      { id: 'context-failure-user', content: 'stale user' }
    ])
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('context-mirror-failure-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('commits canonical required-user context without a legacy mirror when no UI skeleton exists', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'canonical-only-required-user-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('canonical-only-required-user-event', 1), invocationId: 'canonical-only-required-user-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', content: 'standalone accepted body' }],
        requiredUserMessage: { id: 'external-user-id', message: { role: 'user', content: 'standalone accepted body' } } } }], 0))
      .resolves.toMatchObject({ version: 1, duplicate: false })
    expect(conn.prepare('SELECT kind FROM agent_history_events WHERE event_id=?').get('canonical-only-required-user-event'))
      .toEqual({ kind: 'invocation-context-committed' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM messages WHERE id=?').get('external-user-id')).toEqual({ count: 0 })
    db.close()
  })

  it('rejects a required user mirror that conflicts with its canonical context identity or body', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-conflict-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-conflict',?,'user','original body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-conflict-event', 1), invocationId: 'atomic-user-context-conflict-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user-conflict', role: 'user', content: 'canonical context body' }],
        requiredUserMessage: { id: 'atomic-required-user-conflict', message: { role: 'user', content: 'different accepted body' } } } }], 0))
      .rejects.toThrow('required user message does not match canonical context identity')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-conflict-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('atomic-required-user-conflict'))
      .toEqual({ content: 'original body', status: 'sent' })
    db.close()
  })

  it('rejects required user mirror content when either canonical projection contains unsupported blocks', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-unsupported-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-unsupported',?,'user','original body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-unsupported-event', 1), invocationId: 'atomic-user-context-unsupported-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user-unsupported', role: 'user', content: [
        { type: 'text', text: 'same visible text' }, { type: 'audio', data: 'not supported by the legacy mirror' }
      ] }], requiredUserMessage: { id: 'atomic-required-user-unsupported', message: { role: 'user', content: [
        { type: 'text', text: 'same visible text' }, { type: 'audio', data: 'different unsupported payload' }
      ] } } } }], 0))
      .rejects.toThrow('canonical invocation context payload is invalid')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-unsupported-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects a required user whose canonical image blocks differ from the context snapshot', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-image-conflict-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-image-conflict',?,'user','same text','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-image-conflict-event', 1), invocationId: 'atomic-user-context-image-conflict-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user-image-conflict', role: 'user', content: [
        { type: 'text', text: 'same text' }, { type: 'image', mimeType: 'image/png', data: 'canonical-image' }
      ] }], requiredUserMessage: { id: 'atomic-required-user-image-conflict', message: { role: 'user', content: [
        { type: 'text', text: 'same text' }, { type: 'image', mimeType: 'image/png', data: 'different-image' }
      ] } } } }], 0))
      .rejects.toThrow('required user message does not match canonical context identity')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-image-conflict-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects duplicate canonical context identities for the required user', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-duplicate-id-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-duplicate-id',?,'user','original body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-duplicate-id-event', 1), invocationId: 'atomic-user-context-duplicate-id-invocation', kind: 'invocation-context-committed',
      payload: { messages: [
        { id: 'atomic-required-user-duplicate-id', role: 'user', content: 'same body' },
        { id: 'atomic-required-user-duplicate-id', role: 'user', content: 'same body' }
      ], requiredUserMessage: { id: 'atomic-required-user-duplicate-id', message: { role: 'user', content: 'same body' } } } }], 0))
      .rejects.toThrow('required user message does not match canonical context identity')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-duplicate-id-event'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects required user content that is accepted by the assistant projector but cannot be mirrored', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-thinking-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-thinking',?,'user','original body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-thinking-event', 1), invocationId: 'atomic-user-context-thinking-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user-thinking', role: 'user', content: [
        { type: 'text', text: 'visible body' }, { type: 'thinking', thinking: 'unexpected private block' }
      ] }], requiredUserMessage: { id: 'atomic-required-user-thinking', message: { role: 'user', content: [
        { type: 'text', text: 'visible body' }, { type: 'thinking', thinking: 'unexpected private block' }
      ] } } } }], 0))
      .rejects.toThrow('required user message does not match canonical context identity')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-thinking-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('atomic-required-user-thinking')).toEqual({ content: 'original body' })
    db.close()
  })

  it('rejects a malformed explicit required-user identity instead of committing context without its mirror', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-malformed-required-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-malformed',?,'user','original body','sent',1,10,0)`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-malformed-required-event', 1), invocationId: 'atomic-user-context-malformed-required-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user-malformed', role: 'user', content: 'accepted body' }],
        requiredUserMessage: { id: 'atomic-required-user-malformed', message: { role: 'assistant', content: 'wrong role' } } } }], 0))
      .rejects.toThrow('required user message does not match canonical context identity')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-malformed-required-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('atomic-required-user-malformed'))
      .toEqual({ content: 'original body' })
    db.close()
  })

  it('rolls back a canonical base context when its required user message mirror fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-user-context-mirror-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-required-user-failure',?,'user','original body','sent',1,10,0)`).run(sessionId)
    conn.exec(`CREATE TRIGGER fail_required_user_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='atomic-required-user-failure' BEGIN SELECT RAISE(ABORT, 'injected required user mirror failure'); END`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-user-context-failure-event', 1), invocationId: 'atomic-user-context-failure-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'atomic-required-user-failure', role: 'user', content: 'canonical body' }],
        requiredUserMessage: { id: 'atomic-required-user-failure', message: { role: 'user', content: 'canonical body' } } } }], 0))
      .rejects.toThrow('injected required user mirror failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-user-context-failure-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('atomic-required-user-failure'))
      .toEqual({ content: 'original body', status: 'sent' })
    db.close()
  })

  it('rolls back message revision and preserves API eligibility when a later event fails after context mirroring', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-context-later-event-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-context-later-failure-user',?,'user','original body','sent',1,10,0)`).run(sessionId)
    conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?`).run(sessionId)
    conn.prepare(`INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,
      canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version)
      VALUES(?,?,0,0,0,'seed-event','seed-invocation',1,1)`).run(sessionId, 'generation')
    conn.exec(`CREATE TRIGGER fail_later_history_event BEFORE INSERT ON agent_history_events
      WHEN NEW.event_id='atomic-context-later-failure-event' BEGIN SELECT RAISE(ABORT, 'injected later History failure'); END`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([
      { ...event('atomic-context-before-failure-event', 1), invocationId: 'atomic-context-later-failure-invocation', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'atomic-context-later-failure-user', role: 'user', content: 'canonical body' }] } },
      { ...event('atomic-context-later-failure-event', 2), invocationId: 'atomic-context-later-failure-invocation' }
    ], 0)).rejects.toThrow('injected later History failure')

    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('atomic-context-later-failure-user'))
      .toEqual({ content: 'original body' })
    expect(conn.prepare('SELECT message_revision,api_read_mode FROM session_message_content_cutover WHERE session_id=?').get(sessionId))
      .toEqual({ message_revision: 1, api_read_mode: 'canonical' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').get(sessionId))
      .toEqual({ session_id: sessionId })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE invocation_id=?').get('atomic-context-later-failure-invocation'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('rolls back a canonical response when its streaming message mirror fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-response-mirror-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-response-failure-assistant',?,'assistant','initial checkpoint','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('atomic-response-failure-turn','atomic-response-failure-request',?,'atomic-response-failure-assistant','executing',1,1,0)`).run(sessionId)
    conn.exec(`CREATE TRIGGER fail_streaming_response_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='atomic-response-failure-assistant' BEGIN SELECT RAISE(ABORT, 'injected streaming mirror failure'); END`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)

    await expect(history.appendBatch([{ ...event('atomic-response-failure-event', 1), invocationId: 'atomic-response-failure-invocation', turnId: 'atomic-response-failure-turn', kind: 'model-response-committed',
      payload: { message: { id: 'atomic-response-failure-assistant', role: 'assistant', content: 'provider response' } } }], 0))
      .rejects.toThrow('injected streaming mirror failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-response-failure-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('atomic-response-failure-assistant'))
      .toEqual({ content: 'initial checkpoint', status: 'streaming' })
    db.close()
  })

  it('keeps large canonical response inline and mirrored when source spill preparation fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'inline-response-spill-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('inline-response-assistant',?,'assistant','checkpoint','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('inline-response-turn','inline-response-request',?,'inline-response-assistant','executing',1,1,0)`).run(sessionId)
    const body = 'large response content '.repeat(4000)
    const spillStore = { commitSourceTruthUnderFence: vi.fn(async () => { throw new Error('injected source spill preparation failure') }) } as unknown as SpillStore
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId, spillStore)

    await history.appendBatch([{ ...event('inline-response-event', 1), invocationId: 'inline-response-invocation', turnId: 'inline-response-turn', kind: 'model-response-committed',
      payload: { message: { id: 'inline-response-assistant', role: 'assistant', content: body } } }], 0)

    const stored = conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?').get('inline-response-event') as { payload_json: string }
    expect(JSON.parse(stored.payload_json)).toMatchObject({ message: { id: 'inline-response-assistant', content: body } })
    expect(conn.prepare('SELECT content,status,content_storage_state FROM messages WHERE id=?').get('inline-response-assistant'))
      .toEqual({ content: body, status: 'streaming', content_storage_state: 'legacy' })
    expect(spillStore.commitSourceTruthUnderFence).toHaveBeenCalledOnce()
    db.close()
  })

  it('keeps large required user context inline and mirrored when source spill preparation fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'inline-user-context-spill-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const body = 'large accepted user context '.repeat(4000)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('inline-user-context-user',?,'user','old accepted body','sent',1,10,0)`).run(sessionId)
    const spillStore = { commitSourceTruthUnderFence: vi.fn(async () => { throw new Error('injected source spill preparation failure') }) } as unknown as SpillStore
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId, spillStore)

    await history.appendBatch([{ ...event('inline-user-context-event', 1), invocationId: 'inline-user-context-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'inline-user-context-user', role: 'user', content: body }],
        requiredUserMessage: { id: 'inline-user-context-user', message: { role: 'user', content: body } } } }], 0)

    const stored = conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?').get('inline-user-context-event') as { payload_json: string }
    expect(JSON.parse(stored.payload_json)).toMatchObject({
      messages: [{ id: 'inline-user-context-user', content: body }],
      requiredUserMessage: { id: 'inline-user-context-user', message: { role: 'user', content: body } }
    })
    expect(conn.prepare('SELECT content,status,content_storage_state FROM messages WHERE id=?').get('inline-user-context-user'))
      .toEqual({ content: body, status: 'sent', content_storage_state: 'legacy' })
    expect(spillStore.commitSourceTruthUnderFence).toHaveBeenCalledOnce()
    db.close()
  })

  it('rolls back a spilled required-user context on mirror failure and reclaims its unreferenced source file', async () => {
    const temp = createTempDatabase('history-required-user-spill-mirror-failure-')
    const conn = getDbConnection(temp.db)
    const sessionId = 'spilled-user-context-mirror-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const body = 'large accepted user context '.repeat(4000)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('spilled-user-context-failure-user',?,'user','old accepted body','sent',1,10,0)`).run(sessionId)
    conn.exec(`CREATE TRIGGER fail_large_user_context_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='spilled-user-context-failure-user' BEGIN SELECT RAISE(ABORT, 'injected large user mirror failure'); END`)
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const spillStore = createSpillStore(spillRoot)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId, spillStore)

    await expect(history.appendBatch([{ ...event('spilled-user-context-failure-event', 1), invocationId: 'spilled-user-context-failure-invocation', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spilled-user-context-failure-user', role: 'user', content: body }],
        requiredUserMessage: { id: 'spilled-user-context-failure-user', message: { role: 'user', content: body } } } }], 0))
      .rejects.toThrow('injected large user mirror failure')

    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('spilled-user-context-failure-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId)).toBeUndefined()
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('spilled-user-context-failure-user'))
      .toEqual({ content: 'old accepted body', status: 'sent' })
    const spillFiles = await fs.readdir(spillRoot)
    expect(spillFiles).toHaveLength(1)
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(spillStore, conn)).resolves.toEqual(spillFiles)
    await expect(fs.readdir(spillRoot)).resolves.toEqual([])
    temp.cleanup()
  })

  it('rolls back a spilled assistant response on mirror failure and reclaims its unreferenced source file', async () => {
    const temp = createTempDatabase('history-assistant-spill-mirror-failure-')
    const conn = getDbConnection(temp.db)
    const sessionId = 'spilled-assistant-mirror-failure-session'
    const turnId = 'spilled-assistant-mirror-failure-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('spilled-assistant-failure-message',?,'assistant','old streaming checkpoint','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'spilled-assistant-failure-request',?,'spilled-assistant-failure-message','executing',1,1,0)`).run(turnId, sessionId)
    conn.exec(`CREATE TRIGGER fail_spilled_assistant_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='spilled-assistant-failure-message' BEGIN SELECT RAISE(ABORT, 'injected spilled assistant mirror failure'); END`)
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const spillStore = createSpillStore(spillRoot)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId, spillStore)
    const body = 'large assistant response '.repeat(4000)

    await expect(history.appendBatch([{ ...event('spilled-assistant-failure-event', 1), invocationId: 'spilled-assistant-failure-invocation', turnId,
      kind: 'model-response-committed', payload: { message: { id: 'spilled-assistant-failure-message', role: 'assistant', content: body } } }], 0))
      .rejects.toThrow('injected spilled assistant mirror failure')

    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('spilled-assistant-failure-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId)).toBeUndefined()
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('spilled-assistant-failure-message'))
      .toEqual({ content: 'old streaming checkpoint', status: 'streaming' })
    const spillFiles = await fs.readdir(spillRoot)
    expect(spillFiles).toHaveLength(1)
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(spillStore, conn)).resolves.toEqual(spillFiles)
    await expect(fs.readdir(spillRoot)).resolves.toEqual([])
    temp.cleanup()
  })

  it('rolls back spilled terminal output, transcript, receipt and execution fence on mirror failure', async () => {
    const temp = createTempDatabase('history-terminal-spill-mirror-failure-')
    const conn = getDbConnection(temp.db)
    const sessionId = 'spilled-terminal-mirror-failure-session'
    const turnId = 'spilled-terminal-mirror-failure-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(temp.db, { sessionId, turnId, ownerId: 'spill-mirror-failure-owner' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(temp.db, { sessionId, turnId, ownerId: 'spill-mirror-failure-owner', generation: owner.generation })
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('spilled-terminal-failure-message',?,'assistant','old streaming checkpoint','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'spilled-terminal-failure-request',?,'spilled-terminal-failure-message','executing',1,1,0)`).run(turnId, sessionId)
    conn.exec(`CREATE TRIGGER fail_spilled_terminal_mirror BEFORE UPDATE OF content ON messages
      WHEN OLD.id='spilled-terminal-failure-message' BEGIN SELECT RAISE(ABORT, 'injected spilled terminal mirror failure'); END`)
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const spillStore = createSpillStore(spillRoot)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId, spillStore)
    const largeOutput = 'large terminal output '.repeat(4000)

    await expect(history.appendBatch([{ ...event('spilled-terminal-failure-event', 1), invocationId: turnId, turnId,
      kind: 'invocation-completed', payload: { status: 'completed', outputText: largeOutput } }], 0, {
      sessionId, baseVersion: 0, outcome: 'completed',
      messages: [{ id: 'spilled-terminal-failure-message', role: 'assistant', content: largeOutput }],
      messageMirror: { messageId: 'spilled-terminal-failure-message', status: 'completed', content: largeOutput }
    })).rejects.toThrow('injected spilled terminal mirror failure')

    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('spilled-terminal-failure-event'))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get(sessionId))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_turn_commit_receipts WHERE session_id=?').get(sessionId))
      .toEqual({ count: 0 })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(sessionId))
      .toEqual({ status: 'executing' })
    expect(conn.prepare('SELECT status FROM session_execution_queue WHERE session_id=?').get(sessionId))
      .toEqual({ status: 'executing' })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('spilled-terminal-failure-message'))
      .toEqual({ content: 'old streaming checkpoint', status: 'streaming' })
    expect(conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId)).toBeUndefined()
    const spillFiles = await fs.readdir(spillRoot)
    expect(spillFiles).toHaveLength(2)
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(spillStore, conn)).resolves.toEqual(expect.arrayContaining(spillFiles))
    await expect(fs.readdir(spillRoot)).resolves.toEqual([])
    temp.cleanup()
  })

  it('rolls back the canonical terminal event if its atomic transcript receipt fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('atomic-terminal-failure','s','m',0.7,1,1,1,'{}','{}',1,'generation')`).run()
    const owner = claimSessionExecution(db, { sessionId: 'atomic-terminal-failure', turnId: 'atomic-terminal-turn', ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(db, { sessionId: 'atomic-terminal-failure', turnId: 'atomic-terminal-turn', ownerId: 'process', generation: owner.generation })
    conn.exec(`CREATE TRIGGER fail_terminal_transcript_receipt BEFORE INSERT ON session_turn_commit_receipts
      WHEN NEW.session_id='atomic-terminal-failure' BEGIN SELECT RAISE(ABORT, 'injected terminal receipt failure'); END`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'atomic-terminal-failure')
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('atomic-terminal-failure-assistant','atomic-terminal-failure','assistant','legacy checkpoint','streaming',1,10,0)`).run()
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('atomic-terminal-turn','atomic-terminal-failure-request','atomic-terminal-failure','atomic-terminal-failure-assistant','executing',1,1,0)`).run()
    const terminal: HistoryEvent = { ...event('atomic-terminal-failure-event', 1), invocationId: 'atomic-terminal-failure-invocation', turnId: 'atomic-terminal-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    await expect(history.appendBatch([terminal], 0, { sessionId: 'atomic-terminal-failure', baseVersion: 0, outcome: 'completed',
      messages: [{ role: 'user', content: 'accepted' }, { id: 'atomic-terminal-failure-assistant', role: 'assistant', content: 'canonical answer' }],
      messageMirror: { messageId: 'atomic-terminal-failure-assistant', status: 'completed', content: 'canonical answer' } })).rejects.toThrow('injected terminal receipt failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-terminal-failure-event')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get('atomic-terminal-failure')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('atomic-terminal-failure')).toEqual({ status: 'executing' })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('atomic-terminal-failure-assistant'))
      .toEqual({ content: 'legacy checkpoint', status: 'streaming' })
    db.close()
  })

  it('rolls back terminal History and transcript when the required message mirror target is absent', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-terminal-mirror-missing'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId: 'atomic-terminal-mirror-turn', ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(db, { sessionId, turnId: 'atomic-terminal-mirror-turn', ownerId: 'process', generation: owner.generation })
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('existing-terminal-assistant',?,'assistant','existing','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES('atomic-terminal-mirror-turn','atomic-terminal-mirror-request',?,'existing-terminal-assistant','executing',1,1,0)`).run(sessionId)
    const terminal: HistoryEvent = { ...event('atomic-terminal-mirror-event', 1), invocationId: 'atomic-terminal-mirror-invocation',
      turnId: 'atomic-terminal-mirror-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    await expect(history.appendBatch([terminal], 0, { sessionId, baseVersion: 0, outcome: 'completed', messages: [{ id: 'missing-assistant', role: 'assistant', content: 'done' }],
      messageMirror: { messageId: 'missing-assistant', status: 'completed', content: 'done' } }))
      .rejects.toThrow('terminal message mirror target does not belong to the committed turn')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-terminal-mirror-event')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get(sessionId)).toEqual({ count: 0 })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(sessionId)).toEqual({ status: 'executing' })
    db.close()
  })

  it('rejects a terminal assistant mirror whose stable ID belongs to a different turn', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-terminal-cross-turn-session'
    const turnId = 'atomic-terminal-current-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    claimSessionExecution(db, { sessionId, turnId, ownerId: 'process' })
    markSessionExecutionStarted(db, { sessionId, turnId, ownerId: 'process', generation: 1 })
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES
      ('current-turn-assistant',?,'assistant','current','streaming',1,10,0),
      ('other-turn-assistant',?,'assistant','other','completed',1,11,1)`).run(sessionId, sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'current-request',?,'current-turn-assistant','executing',1,1,0)`).run(turnId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const terminal: HistoryEvent = { ...event('cross-turn-terminal-event', 1), invocationId: 'cross-turn-terminal-invocation',
      turnId, kind: 'invocation-completed', payload: { status: 'completed' } }

    await expect(history.appendBatch([terminal], 0, { sessionId, baseVersion: 0, outcome: 'completed', messages: [{ id: 'other-turn-assistant', role: 'assistant', content: 'forged cross-turn body' }],
      messageMirror: { messageId: 'other-turn-assistant', status: 'completed', content: 'forged cross-turn body' } }))
      .rejects.toThrow('terminal message mirror target does not belong to the committed turn')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('cross-turn-terminal-event')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get(sessionId)).toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('other-turn-assistant'))
      .toEqual({ content: 'other', status: 'completed' })
    db.close()
  })

  it('rejects terminal outcome and assistant status that disagree', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'terminal-outcome-mismatch-session'
    const turnId = 'terminal-outcome-mismatch-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId, ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(db, { sessionId, turnId, ownerId: 'process', generation: owner.generation })
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('outcome-mismatch-assistant',?,'assistant','answer','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?, 'outcome-mismatch-request',?,'outcome-mismatch-assistant','executing',1,1,0)`).run(turnId, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const terminal: HistoryEvent = { ...event('outcome-mismatch-terminal', 1), invocationId: 'outcome-mismatch-invocation', turnId,
      kind: 'invocation-completed', payload: { status: 'completed' } }

    await expect(history.appendBatch([terminal], 0, { sessionId, baseVersion: 0, outcome: 'completed', messages: [{ role: 'assistant', content: 'answer' }],
      messageMirror: { messageId: 'outcome-mismatch-assistant', status: 'failed', content: 'answer' } }))
      .rejects.toThrow('terminal message mirror status does not match its outcome')
    await expect(history.appendBatch([terminal], 0, { sessionId, baseVersion: 0, outcome: 'failed', messages: [{ role: 'assistant', content: 'answer' }],
      messageMirror: { messageId: 'outcome-mismatch-assistant', status: 'failed', content: 'answer' } }))
      .rejects.toThrow('terminal History kind does not match the transcript outcome')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('outcome-mismatch-terminal')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('outcome-mismatch-assistant'))
      .toEqual({ content: 'answer', status: 'streaming' })
    db.close()
  })

  it.each([
    ['failed', 'invocation-failed', 'failed', 'failed'],
    ['timed-out', 'invocation-failed', 'timed_out', 'failed'],
    ['cancelled', 'invocation-interrupted', 'cancelled', 'cancelled'],
    ['interrupted', 'invocation-interrupted', 'interrupted', 'failed']
  ] as const)('accepts the %s terminal outcome/message status pair', async (caseName, kind, outcome, messageStatus) => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = `terminal-matrix-${caseName}-session`
    const turnId = `terminal-matrix-${caseName}-turn`
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId, ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(db, { sessionId, turnId, ownerId: 'process', generation: owner.generation })
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES(?,?, 'assistant','partial','streaming',1,10,0)`).run(`${caseName}-assistant`, sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?,?,?,?,'executing',1,1,0)`).run(turnId, `${caseName}-request`, sessionId, `${caseName}-assistant`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const terminal: HistoryEvent = { ...event(`${caseName}-terminal-event`, 1), invocationId: `${caseName}-invocation`, turnId,
      kind, payload: { status: caseName === 'timed-out' ? 'failed' : caseName } }

    await expect(history.appendBatch([terminal], 0, { sessionId, baseVersion: 0, outcome, messages: [{ role: 'assistant', content: 'partial' }],
      messageMirror: { messageId: `${caseName}-assistant`, status: messageStatus } })).resolves.toMatchObject({ duplicate: false })
    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get(`${caseName}-assistant`))
      .toEqual({ content: 'partial', status: messageStatus })
    expect(conn.prepare('SELECT outcome FROM session_turn_commit_receipts WHERE session_id=?').get(sessionId)).toEqual({ outcome })
    db.close()
  })

  it('commits the SDK failed outcome and block-text message mirror through SQLite atomically', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'sdk-failed-block-mirror-session'
    const turnId = 'sdk-failed-block-mirror-turn'
    const invocationId = 'sdk-failed-block-mirror-invocation'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId, ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(db, { sessionId, turnId, ownerId: 'process', generation: owner.generation })
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES('sdk-failed-block-assistant',?,'assistant','legacy partial','streaming',1,10,0)`).run(sessionId)
    conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at,version)
      VALUES(?,?,?,'sdk-failed-block-assistant','executing',1,1,0)`).run(turnId, `${turnId}-request`, sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const registry = new ModelProviderRegistry()
    registry.register({ routeId: 'sqlite-sdk-failure', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'sqlite-sdk-failure-provider', stream: async function* () {
        yield { type: 'text-delta', text: 'partial answer' }
        throw new Error('provider disconnected')
      }
    })
    const permits = new InMemorySafetyPermitStore()

    await expect(runAgentTurn({
      registry, routeId: 'sqlite-sdk-failure', invocationId, turnId, sessionId,
      sessionTranscriptBaseVersion: 0, assistantMessageId: 'sdk-failed-block-assistant', history,
      sessionTranscriptFailureMessages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', id: 'sdk-failed-block-assistant', content: [
          { type: 'text', text: 'partial canonical answer' }, { type: 'thinking', thinking: 'private reasoning' }
        ] }
      ], request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 32 }, maxModelTurns: 1,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits,
        policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(), toolExecution: createPermitBoundToolExecutionPort({ permits,
        admission: new InMemoryExecutionAdmissionCoordinator(), resolveExpected: async () => { throw new Error('tool execution is not expected') },
        execute: async () => ({ output: undefined }) })
    })).rejects.toThrow('provider disconnected')

    expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get('sdk-failed-block-assistant'))
      .toEqual({ content: 'partial canonical answer', status: 'failed' })
    expect(conn.prepare('SELECT outcome FROM session_turn_commit_receipts WHERE session_id=?').get(sessionId)).toEqual({ outcome: 'failed' })
    expect(conn.prepare('SELECT version,status FROM session_transcript_checkpoints WHERE session_id=?').get(sessionId))
      .toMatchObject({ version: 1, status: 'ready' })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(sessionId)).toEqual({ status: 'transcript_committed' })
    const transcript = conn.prepare('SELECT messages_json FROM session_transcript_entries WHERE session_id=?').get(sessionId) as { messages_json: string }
    expect(JSON.parse(transcript.messages_json)).toContainEqual(expect.objectContaining({
      role: 'assistant', id: 'sdk-failed-block-assistant', content: [
        { type: 'text', text: 'partial canonical answer' }, { type: 'thinking', thinking: 'private reasoning' }
      ]
    }))
    db.close()
  })

  it('rolls back the canonical terminal event and receipt if its atomic checkpoint fails', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'atomic-terminal-checkpoint-failure'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'generation')`).run(sessionId)
    const owner = claimSessionExecution(db, { sessionId, turnId: 'atomic-terminal-turn', ownerId: 'process' })
    if (!owner.acquired) throw new Error('test setup could not claim session')
    markSessionExecutionStarted(db, { sessionId, turnId: 'atomic-terminal-turn', ownerId: 'process', generation: owner.generation })
    conn.exec(`CREATE TRIGGER fail_terminal_transcript_checkpoint BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.session_id='${sessionId}' BEGIN SELECT RAISE(ABORT, 'injected terminal checkpoint failure'); END`)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
    const terminal: HistoryEvent = { ...event('atomic-terminal-checkpoint-failure-event', 1), invocationId: 'atomic-terminal-checkpoint-failure-invocation', turnId: 'atomic-terminal-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    await expect(history.appendBatch([terminal], 0, { sessionId, baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'accepted' }] }))
      .rejects.toThrow('injected terminal checkpoint failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?').get('atomic-terminal-checkpoint-failure-event')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_turn_commit_receipts WHERE session_id=?').get(sessionId)).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get(sessionId)).toEqual({ count: 0 })
    expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(sessionId)).toEqual({ status: 'executing' })
    db.close()
  })

  it('assigns transactional session and global order across streams without consuming order on duplicate retries', async () => {
    const conn = createDb()
    const sessionHistory = new SqliteAgentHistory(conn, 1, () => 100, 'session-order')
    const firstBatch = [event('ordered-1', 1), event('ordered-2', 2)]
    await sessionHistory.appendBatch(firstBatch, 0)
    await expect(sessionHistory.appendBatch(firstBatch, 0)).resolves.toEqual({ version: 2, duplicate: true })
    await new SqliteAgentHistory(conn, 1, () => 101, 'session-order').appendBatch([{
      ...event('ordered-other-stream', 1), invocationId: 'inv-2', turnId: 'turn-2'
    }], 0)

    expect(conn.prepare(`SELECT invocation_id, sequence, session_id, commit_order, session_seq
      FROM agent_history_events ORDER BY commit_order`).all()).toEqual([
      { invocation_id: 'inv-1', sequence: 1, session_id: 'session-order', commit_order: 1, session_seq: 1 },
      { invocation_id: 'inv-1', sequence: 2, session_id: 'session-order', commit_order: 2, session_seq: 2 },
      { invocation_id: 'inv-2', sequence: 1, session_id: 'session-order', commit_order: 3, session_seq: 3 }
    ])
    expect(conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get('session-order')).toEqual({ next_seq: 3 })
    conn.close()
  })

  it('folds canonical provider snapshots from real session history in session order and fails closed when legacy identity differs', async () => {
    const conn = createDb()
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('session-fold','s','m',0.7,1,1,1,'{}','{}',1,'generation-fold')`).run()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-fold')
    await history.appendBatch([{
      ...event('snapshot-a', 1), invocationId: 'snapshot-inv-a', turnId: 'turn-a', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', content: 'first', id: 'user-1', timestamp: 1 },
        { role: 'assistant', content: 'answer', id: 'assistant-1', timestamp: 2 }
      ] }
    }], 0)
    await new SqliteAgentHistory(conn, 1, () => 101, 'session-fold').appendBatch([{
      ...event('snapshot-b', 1), invocationId: 'snapshot-inv-b', turnId: 'turn-b', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'assistant', content: 'answer revised', id: 'assistant-1', timestamp: 2 },
        { role: 'user', content: 'second', id: 'user-2', timestamp: 3 }
      ] }
    }], 0)

    const folded = history.readCanonicalSessionTranscript('session-fold', [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'answer revised', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
    ])
    expect(folded).toEqual({
      kind: 'matched',
      messages: [
        { role: 'user', content: 'first', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'answer revised', timestamp: 2, id: 'assistant-1' },
        { role: 'user', content: 'second', timestamp: 3, id: 'user-2' }
      ],
      sessionId: 'session-fold', sessionGeneration: 'generation-fold',
      sessionSeq: 2, commitOrder: 2, watermarkEventId: 'snapshot-b', watermarkInvocationId: 'snapshot-inv-b', eventCount: 2
    })
    expect(history.readCanonicalSessionTranscript('session-fold', [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'wrong-id', role: 'assistant', content: 'answer revised', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
    ])).toEqual({ kind: 'unavailable', reason: 'legacy-mismatch' })
    expect(history.readCanonicalSessionTranscript('session-fold', [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'answer revised', timestamp: 2, attachments: [{ name: 'not-canonical' }] },
      { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
    ])).toEqual({ kind: 'unavailable', reason: 'legacy-mismatch' })
    for (const unsupported of [
      { thinking: { content: 'thinking', isVisible: false, startTime: 1 } },
      { contentSegments: [{ type: 'text', text: 'first', startTime: 1 }] },
      { toolCalls: [{ id: 'tool', toolName: 'read_file', input: {}, status: 'completed' }] },
      { toolUse: { toolUseId: 'tool', toolName: 'read_file' } },
      { status: 'streaming' }, { sequence: 1 }, { imagesDeliveredToApi: true }, { skillHints: [{ id: 'hint' }] }
    ]) {
      expect(history.readCanonicalSessionTranscript('session-fold', [
        { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'answer revised', timestamp: 2, ...unsupported },
        { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
      ])).toEqual({ kind: 'unavailable', reason: 'legacy-mismatch' })
    }
    const matched = folded as Extract<typeof folded, { kind: 'matched' }>
    expect(history.readCanonicalSessionCache({ ...matched, cacheKey: 'assistant-content' })).toEqual({ kind: 'miss', reason: 'cache-missing' })
    expect(history.writeCanonicalSessionCache({ ...matched, cacheKey: 'assistant-content', value: JSON.stringify(matched.messages) })).toBe(true)
    expect(history.readCanonicalSessionCache({ ...matched, cacheKey: 'assistant-content' })).toMatchObject({ kind: 'hit', value: JSON.stringify(matched.messages), sessionSeq: 2 })
    expect(history.readCanonicalSessionCache({ ...matched, cacheKey: 'assistant-content', sessionGeneration: 'stale-generation' })).toEqual({ kind: 'miss', reason: 'watermark-invalid' })
    conn.prepare("UPDATE agent_history_events SET event_id='replaced-anchor' WHERE event_id='snapshot-b'").run()
    expect(history.readCanonicalSessionCache({ ...matched, cacheKey: 'assistant-content' })).toEqual({ kind: 'miss', reason: 'cache-missing' })
    expect(history.readCanonicalSessionTranscriptWithCache('session-fold', 'assistant-content', [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'answer revised', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
    ])).toMatchObject({ kind: 'matched', source: 'L2' })
    conn.prepare("UPDATE canonical_session_projection_cache SET cache_version=0 WHERE session_id='session-fold' AND cache_key='assistant-content'").run()
    expect(history.readCanonicalSessionCache({ ...matched, cacheKey: 'assistant-content' })).toEqual({ kind: 'miss', reason: 'schema-invalid' })
    expect(history.readCanonicalSessionTranscriptWithCache('session-fold', 'assistant-content', [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'answer revised', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
    ])).toMatchObject({ kind: 'matched', source: 'L2' })
    expect(conn.prepare("SELECT cache_version FROM canonical_session_projection_cache WHERE session_id='session-fold' AND cache_key='assistant-content'").get())
      .toEqual({ cache_version: 1 })
    conn.exec('DROP TABLE canonical_session_projection_cache')
    expect(history.readCanonicalSessionTranscriptWithCache('session-fold', 'assistant-content', [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'answer revised', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'second', timestamp: 3 }
    ])).toMatchObject({ kind: 'matched', source: 'L2' })
    expect(history.readCanonicalSessionTranscript('other-session', [])).toEqual({ kind: 'unavailable', reason: 'session-missing' })
    conn.close()
  })

  it('uses a valid cached seed and folds only the new session suffix', async () => {
    const conn = createDb()
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('session-l1','s','m',0.7,1,1,1,'{}','{}',1,'generation-l1')`).run()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-l1')
    await history.appendBatch([{ ...event('l1-base', 1), invocationId: 'l1-a', kind: 'invocation-context-committed', payload: {
      messages: [{ role: 'user', content: 'one', id: 'l1-user-1', timestamp: 1 }]
    } }], 0)
    const seed = history.readCanonicalSessionTranscript('session-l1', [{ id: 'l1-user-1', role: 'user', content: 'one', timestamp: 1 }])
    if (seed.kind !== 'matched') throw new Error('expected matching canonical seed')
    expect(history.writeCanonicalSessionCache({ ...seed, cacheKey: 'transcript', value: JSON.stringify(seed.messages) })).toBe(true)
    await new SqliteAgentHistory(conn, 1, () => 101, 'session-l1').appendBatch([{ ...event('l1-tail', 1), invocationId: 'l1-b', kind: 'invocation-context-committed', payload: {
      messages: [
        { role: 'user', content: 'one', id: 'l1-user-1', timestamp: 1 },
        { role: 'assistant', content: 'two', id: 'l1-assistant-1', timestamp: 2 }
      ]
    } }], 0)

    expect(history.readCanonicalSessionTranscriptWithCache('session-l1', 'transcript', [
      { id: 'l1-user-1', role: 'user', content: 'one', timestamp: 1 },
      { id: 'l1-assistant-1', role: 'assistant', content: 'two', timestamp: 2 }
    ])).toMatchObject({ kind: 'matched', source: 'L1', messages: [
      { id: 'l1-user-1' }, { id: 'l1-assistant-1' }
    ], replayedEvents: 1 })
    conn.close()
  })

  it('folds committed responses after a context snapshot into the DB session transcript', async () => {
    const conn = createDb()
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('session-response-fold','s','m',0.7,1,1,1,'{}','{}',1,'generation-response')`).run()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-response-fold')
    await history.appendBatch([
      { ...event('response-context', 1), invocationId: 'response-inv', kind: 'invocation-context-committed', payload: {
        messages: [{ role: 'user', content: 'question', id: 'response-user', timestamp: 1 }]
      } },
      { ...event('response-answer', 2), invocationId: 'response-inv', kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: 'answer', id: 'response-assistant', timestamp: 2 }
      } },
      { ...event('response-terminal', 3), invocationId: 'response-inv', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)

    expect(history.readCanonicalSessionTranscript('session-response-fold', [
      { id: 'response-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'response-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
    ])).toEqual({ kind: 'matched', messages: [
      { role: 'user', content: 'question', id: 'response-user', timestamp: 1 },
      { role: 'assistant', content: 'answer', id: 'response-assistant', timestamp: 2 }
    ], sessionId: 'session-response-fold', sessionGeneration: 'generation-response', sessionSeq: 3, commitOrder: 3, watermarkEventId: 'response-terminal', watermarkInvocationId: 'response-inv', eventCount: 3 })
    conn.close()
  })

  it('replays a response event after a cached context without scanning the full session', async () => {
    const conn = createDb()
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('session-l1-response','s','m',0.7,1,1,1,'{}','{}',1,'generation-l1-response')`).run()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-l1-response')
    await history.appendBatch([{ ...event('l1-response-context', 1), invocationId: 'l1-response-inv', kind: 'invocation-context-committed', payload: {
      messages: [{ role: 'user', content: 'question', id: 'l1-response-user', timestamp: 1 }]
    } }], 0)
    const initial = history.readCanonicalSessionTranscript('session-l1-response', [{ id: 'l1-response-user', role: 'user', content: 'question', timestamp: 1 }])
    if (initial.kind !== 'matched') throw new Error('expected initial canonical transcript')
    history.writeCanonicalSessionCache({ ...initial, cacheKey: 'transcript', value: JSON.stringify(initial.messages) })
    await history.appendBatch([
      { ...event('l1-response-answer', 2), invocationId: 'l1-response-inv', kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: 'answer', id: 'l1-response-assistant', timestamp: 2 }
      } },
      { ...event('l1-response-terminal', 3), invocationId: 'l1-response-inv', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 1)

    expect(history.readCanonicalSessionTranscriptWithCache('session-l1-response', 'transcript', [
      { id: 'l1-response-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'l1-response-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
    ])).toMatchObject({ kind: 'matched', source: 'L1', replayedEvents: 2, messages: [
      { id: 'l1-response-user' }, { id: 'l1-response-assistant', timestamp: 2 }
    ] })
    conn.prepare("DELETE FROM agent_history_events WHERE event_id='l1-response-answer'").run()
    expect(history.readCanonicalSessionTranscriptWithCache('session-l1-response', 'transcript', [
      { id: 'l1-response-user', role: 'user', content: 'question', timestamp: 1 }
    ])).toEqual({ kind: 'unavailable', reason: 'order-invalid' })
    conn.close()
  })

  it('distinguishes an empty session watermark and invalidates it when that session id is recreated', async () => {
    const conn = createDb()
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('session-empty-cache','s','m',0.7,1,1,1,'{}','{}',1,'generation-empty-1')`).run()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-empty-cache')
    const first = history.readCanonicalSessionTranscriptWithCache('session-empty-cache', 'transcript', [])
    expect(first).toMatchObject({ kind: 'matched', source: 'L2', messages: [], watermark: {
      sessionSeq: -1, commitOrder: -1, watermarkEventId: null, watermarkInvocationId: null, eventCount: 0
    } })
    expect(history.readCanonicalSessionTranscriptWithCache('session-empty-cache', 'transcript', [])).toMatchObject({ kind: 'matched', source: 'L1', replayedEvents: 0 })
    conn.prepare("UPDATE sessions SET generation='generation-empty-2' WHERE id='session-empty-cache'").run()
    expect(history.readCanonicalSessionTranscriptWithCache('session-empty-cache', 'transcript', [])).toMatchObject({ kind: 'matched', source: 'L2', watermark: { sessionGeneration: 'generation-empty-2' } })
    await history.appendBatch([{ ...event('empty-first-write', 1), invocationId: 'empty-first-inv', kind: 'invocation-context-committed', payload: {
      messages: [{ role: 'user', content: 'first', id: 'empty-first-user', timestamp: 1 }]
    } }], 0)
    expect(history.readCanonicalSessionTranscriptWithCache('session-empty-cache', 'transcript', [
        { id: 'empty-first-user', role: 'user', content: 'first', timestamp: 1 }
    ])).toMatchObject({ kind: 'matched', source: 'L1', replayedEvents: 1 })
    conn.close()
  })

  it.each([['cursor-ahead', 2], ['cursor-behind', 0]] as const)(
    'rejects a stale cached transcript after reopen when the session cursor is %s', async (_label, corruptedCursor) => {
      const temp = createTempDatabase('history-cache-cursor-drift-')
      let db = temp.db
      let conn = getDbConnection(db)
      conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
        VALUES('cursor-drift-session','s','m',0.7,1,1,1,'{}','{}',1,'cursor-drift-generation')`).run()
      let history = new SqliteAgentHistory(conn, 1, Date.now, 'cursor-drift-session')
      await history.appendBatch([{ ...event('cursor-drift-context', 1), invocationId: 'cursor-drift-inv',
        kind: 'invocation-context-committed', payload: { messages: [
          { role: 'user', content: 'canonical user', id: 'cursor-drift-user', timestamp: 1 }
        ] } }], 0)
      const canonical = history.readCanonicalSessionTranscript('cursor-drift-session', [
        { id: 'cursor-drift-user', role: 'user', content: 'canonical user', timestamp: 1 }
      ])
      if (canonical.kind !== 'matched') throw new Error('expected canonical transcript')
      expect(history.writeCanonicalSessionCache({ ...canonical, cacheKey: 'transcript', value: JSON.stringify(canonical.messages) })).toBe(true)
      db.close()

      db = openDatabase(temp.dbPath)
      conn = getDbConnection(db)
      history = new SqliteAgentHistory(conn, 1, Date.now, 'cursor-drift-session')
      conn.prepare('UPDATE session_event_cursor SET next_seq=? WHERE session_id=?').run(corruptedCursor, 'cursor-drift-session')
      const result = history.readCanonicalSessionTranscriptWithCache('cursor-drift-session', 'transcript', [
        { id: 'cursor-drift-user', role: 'user', content: 'canonical user', timestamp: 1 }
      ])
      expect(result).toEqual({ kind: 'unavailable', reason: 'order-invalid' })
      expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('cursor-drift-user')).toBeUndefined()
      db.close()
      temp.cleanup()
    }
  )

  it('uses the latest context or compaction snapshot within one invocation', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-compaction-fold')
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation) VALUES('session-compaction-fold','s','m',0.7,1,1,1,'{}','{}',1,'generation-compact')`).run()
    await history.appendBatch([
      { ...event('context-before-compact', 1), invocationId: 'compact-inv', kind: 'invocation-context-committed', payload: {
        messages: [{ role: 'user', content: 'old', id: 'old-user', timestamp: 1 }]
      } },
      { ...event('context-after-compact', 2), invocationId: 'compact-inv', kind: 'transcript-compacted', payload: {
        messages: [{ role: 'user', content: 'summary', id: 'summary-user', timestamp: 2 }]
      } }
    ], 0)

    expect(history.readCanonicalSessionTranscript('session-compaction-fold', [
      { id: 'summary-user', role: 'user', content: 'summary', timestamp: 2 }
    ])).toMatchObject({ kind: 'matched', messages: [{ id: 'summary-user' }], sessionSeq: 2, commitOrder: 2 })
    conn.close()
  })

  it('fails closed when a later canonical event has no usable transcript snapshot', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-snapshot-gap')
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation) VALUES('session-snapshot-gap','s','m',0.7,1,1,1,'{}','{}',1,'generation-gap')`).run()
    await history.appendBatch([{ ...event('gap-event', 1), invocationId: 'gap-inv', kind: 'model-response-committed', payload: {
      modelTurn: 1, message: { role: 'assistant', id: 'assistant-gap', content: 'body' }
    } }], 0)

    expect(history.readCanonicalSessionTranscript('session-snapshot-gap', [
      { id: 'assistant-gap', role: 'assistant', content: 'body', timestamp: 100 }
    ])).toEqual({ kind: 'unavailable', reason: 'snapshot-invalid' })
    conn.close()
  })

  it('rolls back allocated event order when a canonical batch fails before insert', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-order-rollback')
    conn.exec(`CREATE TRIGGER reject_ordered_history BEFORE INSERT ON agent_history_events
      BEGIN SELECT RAISE(ABORT, 'injected canonical insert failure'); END`)
    await expect(history.appendBatch([event('rollback-order', 1)], 0)).rejects.toThrow('injected canonical insert failure')
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_commit_cursor').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT * FROM session_event_cursor').all()).toEqual([])
    conn.exec('DROP TRIGGER reject_ordered_history')

    await history.appendBatch([event('rollback-order', 1)], 0)
    expect(conn.prepare('SELECT commit_order, session_seq FROM agent_history_events WHERE event_id=?').get('rollback-order'))
      .toEqual({ commit_order: 1, session_seq: 1 })
    conn.close()
  })

  it('registers terminal projection repair obligations atomically with canonical append', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('terminal-obligation', 1),
      kind: 'invocation-completed',
      payload: { status: 'completed', sessionLedger: { location: { workDir: '/workspace', sessionId: 'session-1', createdAt: 1 }, turnId: 'turn-1', reason: 'completed' } }
    }], 0)

    expect(conn.prepare('SELECT repair_kind, status, invocation_id FROM canonical_projection_repairs ORDER BY repair_kind').all()).toEqual([
      { repair_kind: 'invocation-projections', status: 'pending', invocation_id: 'inv-1' }
    ])
    await history.classifyLegacyProjectionRepairs(10)
    await history.recoverInterruptedInvocations({ repairInvocationTerminal: async () => undefined })
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='inv-1'").get()).toEqual({ status: 'completed', attempts: 1 })
    conn.close()
  })

  it('rolls back canonical terminal append when durable repair obligation registration fails', async () => {
    const conn = createDb()
    conn.exec(`CREATE TRIGGER reject_projection_repair BEFORE INSERT ON canonical_projection_repairs
      BEGIN SELECT RAISE(ABORT, 'injected repair queue failure'); END`)
    const history = new SqliteAgentHistory(conn)
    await expect(history.appendBatch([{
      ...event('terminal-atomic-failure', 1), kind: 'invocation-completed',
      payload: { status: 'completed', sessionLedger: { location: { workDir: '/workspace', sessionId: 'session-1', createdAt: 1 }, turnId: 'turn-1', reason: 'completed' } }
    }], 0)).rejects.toThrow('injected repair queue failure')
    expect(conn.prepare("SELECT COUNT(*) AS count FROM agent_history_events WHERE invocation_id='inv-1'").get()).toEqual({ count: 0 })
    expect(conn.prepare("SELECT COUNT(*) AS count FROM agent_history_streams WHERE invocation_id='inv-1'").get()).toEqual({ count: 0 })
    conn.close()
  })

  it('classifies legacy terminal streams in resumable batches and does not classify open streams', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const appendTerminal = (invocationId: string, status: 'completed' | 'failed') => {
      const terminalEvent: HistoryEvent = {
        ...event(`${invocationId}:terminal`, 1), invocationId, turnId: `${invocationId}:turn`,
        kind: status === 'completed' ? 'invocation-completed' : 'invocation-failed', payload: { status, sessionLedger: {
          location: { workDir: '/workspace', sessionId: `session-${invocationId}`, createdAt: 1 }, turnId: `${invocationId}:turn`, reason: status
        } }
      }
      conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)').run(invocationId, `session-${invocationId}`)
      conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at)
        VALUES(?, 1, ?, ?, ?, 1, ?, ?, 1)`).run(invocationId, terminalEvent.eventId, terminalEvent.idempotencyKey, terminalEvent.turnId, terminalEvent.kind, JSON.stringify(terminalEvent.payload))
    }
    appendTerminal('legacy-a', 'completed')
    appendTerminal('legacy-b', 'failed')
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 0, 1, ?)').run('open-c', 'session-open-c')

    await expect(history.classifyLegacyProjectionRepairs(1)).resolves.toMatchObject({ classified: 1, complete: false })
    expect(conn.prepare("SELECT invocation_id FROM canonical_projection_repairs WHERE repair_kind='invocation-projections'").all()).toEqual([{ invocation_id: 'legacy-a' }])
    await expect(history.classifyLegacyProjectionRepairs(2)).resolves.toMatchObject({ classified: 2, complete: true })
    expect(conn.prepare("SELECT invocation_id FROM canonical_projection_repairs WHERE repair_kind='invocation-projections' ORDER BY invocation_id").all()).toEqual([
      { invocation_id: 'legacy-a' }, { invocation_id: 'legacy-b' }
    ])
    await expect(history.classifyLegacyProjectionRepairs(2)).resolves.toMatchObject({ classified: 0, complete: true })
    conn.close()
  })

  it('fails closed on corrupt legacy payloads without advancing the classification cursor', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)').run('legacy-corrupt', 'session-corrupt')
    conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at)
      VALUES('legacy-corrupt', 1, 'corrupt-event', 'corrupt-key', 'corrupt-turn', 1, 'invocation-completed', '{not-json', 1)`).run()

    await expect(history.classifyLegacyProjectionRepairs(10)).rejects.toThrow()

    expect(conn.prepare("SELECT status, after_invocation_id FROM canonical_projection_repair_migration WHERE migration_key='legacy-classification-v1'").get())
      .toEqual({ status: 'pending', after_invocation_id: null })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM canonical_projection_repairs').get()).toEqual({ count: 0 })
    conn.close()
  })

  it('retains failed terminal repair obligations across restart and completes them only after retry succeeds', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)').run('legacy-terminal', 'session-legacy')
    conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id)
      VALUES('legacy-terminal', 1, 'legacy-end', 'legacy-end-key', 'legacy-turn', 1, 'invocation-completed', ?, 1, 'session-legacy')`).run(JSON.stringify({ status: 'completed', sessionLedger: {
        location: { workDir: '/workspace', sessionId: 'session-legacy', createdAt: 1 }, turnId: 'legacy-turn', reason: 'completed'
      } }))
    await history.classifyLegacyProjectionRepairs(10)
    expect(conn.prepare("SELECT status FROM canonical_projection_repair_migration WHERE migration_key='legacy-classification-v1'").get()).toEqual({ status: 'complete' })
    expect(conn.prepare("SELECT status FROM canonical_projection_repairs WHERE invocation_id='legacy-terminal'").get()).toEqual({ status: 'pending' })
    const failed = vi.fn(async () => { throw new Error('projection unavailable') })
    await history.recoverInterruptedInvocations({ repairInvocationTerminal: failed })
    expect(failed).toHaveBeenCalledTimes(1)
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='legacy-terminal'").get()).toEqual({ status: 'pending', attempts: 1 })

    const succeeds = vi.fn(async () => undefined)
    await new SqliteAgentHistory(conn).recoverInterruptedInvocations({ repairInvocationTerminal: succeeds })
    expect(succeeds).toHaveBeenCalledTimes(1)
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='legacy-terminal'").get()).toEqual({ status: 'completed', attempts: 2 })
    conn.close()
  })

  it('classifies and completes a nonterminal projection obligation by its target event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-nonterminal', createdAt: 1 }
    const requestId = 'legacy-nonterminal:round:1'
    const requestEvent: HistoryEvent = {
      ...event('legacy-request-started', 1), invocationId: 'legacy-nonterminal', kind: 'model-request-started',
      payload: { requestId, modelTurn: 1, attempt: 1, sessionLedger: {
        location,
        requestHeader: { requestId, attempt: 1, turnId: 'turn-1' },
        requestContext: { requestId, attempt: 1, turnId: 'turn-1' }
      } }
    }
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)').run('legacy-nonterminal', location.sessionId)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id)
      VALUES(?, 1, ?, ?, ?, 1, ?, ?, 1, ?)`).run(requestEvent.invocationId, requestEvent.eventId, requestEvent.idempotencyKey, requestEvent.turnId, requestEvent.kind, JSON.stringify(requestEvent.payload), location.sessionId)

    await history.classifyLegacyProjectionRepairs(10)
    expect(conn.prepare('SELECT repair_id, target_key, status FROM canonical_projection_repairs WHERE invocation_id=?').all('legacy-nonterminal')).toEqual([{
      repair_id: 'legacy-nonterminal:invocation-projections:legacy-request-started', target_key: 'legacy-request-started', status: 'pending'
    }])
    const repairRequest = vi.fn(async () => undefined)
    await history.recoverInterruptedInvocations({ repairModelRequestLedger: repairRequest })
    expect(repairRequest).toHaveBeenCalledWith(location, {
      requestHeader: { requestId, attempt: 1, turnId: 'turn-1' },
      requestContext: { requestId, attempt: 1, turnId: 'turn-1' }
    })
    expect(conn.prepare('SELECT status, attempts FROM canonical_projection_repairs WHERE repair_id=?').get('legacy-nonterminal:invocation-projections:legacy-request-started')).toEqual({ status: 'completed', attempts: 1 })
    conn.close()
  })

  it('does not parse completed terminal streams once legacy classification is complete', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)')
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id)
      VALUES(?, 1, ?, ?, ?, 1, 'invocation-completed', '{"status":"completed"}', 1, ?)`)
    for (let index = 0; index < 64; index += 1) {
      const id = `stable-final-${index.toString().padStart(3, '0')}`
      insertStream.run(id, `session-${id}`)
      insertEvent.run(id, `${id}:event`, `${id}:key`, `${id}:turn`, `session-${id}`)
    }
    await history.classifyLegacyProjectionRepairs(10)
    await history.classifyLegacyProjectionRepairs(100)
    expect(conn.prepare("SELECT status FROM canonical_projection_repair_migration WHERE migration_key='legacy-classification-v1'").get()).toEqual({ status: 'complete' })
    let reads = 0
    const original = history.read.bind(history)
    vi.spyOn(history, 'read').mockImplementation(async (id) => { reads += 1; return original(id) })
    await history.recoverInterruptedInvocations()
    expect(reads).toBe(0)
    conn.close()
  })

  it('keeps startup reads proportional to nonterminal streams and pending repair obligations', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, ?, 1, ?)')
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id)
      VALUES(?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`)
    for (let index = 0; index < 128; index += 1) {
      const id = `finished-${index.toString().padStart(3, '0')}`
      insertStream.run(id, 1, `session-${id}`)
      insertEvent.run(id, 1, `${id}:terminal`, `${id}:terminal-key`, `${id}:turn`, 'invocation-completed', '{"status":"completed"}', `session-${id}`)
    }
    const location = { workDir: '/workspace', sessionId: 'session-open-pending', createdAt: 1 }
    const requestId = 'open-pending:round:1'
    insertStream.run('open-pending', 1, location.sessionId)
    insertEvent.run('open-pending', 1, 'open-request', 'open-request-key', 'open-turn', 'model-request-started', JSON.stringify({
      requestId, modelTurn: 1, attempt: 1,
      sessionLedger: { location, requestHeader: { requestId, attempt: 1, turnId: 'open-turn' }, requestContext: { requestId, attempt: 1, turnId: 'open-turn' } }
    }), location.sessionId)
    await history.classifyLegacyProjectionRepairs(200)
    const reads = vi.spyOn(history, 'read')

    await history.recoverInterruptedInvocations({ repairModelRequestLedger: async () => undefined, repairInvocationTerminal: async () => undefined })

    expect(reads).toHaveBeenCalledTimes(2)
    expect(conn.prepare("SELECT status FROM canonical_projection_repairs WHERE repair_id='open-pending:invocation-projections:open-request'").get()).toEqual({ status: 'completed' })
    conn.close()
  })

  it('skips interrupted-invocation writes for a persisted write-stopped session', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'write-stopped recovery fence', model: 'test' })
    setCanonicalApiReadFeatureEnabled(db, true)
    appendMessage(db, { id: 'write-stopped-recovery-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'write-stopped-recovery-invocation', turnId: 'write-stopped-recovery-turn', sequence: 1,
      schemaVersion: 1, eventId: 'write-stopped-recovery-context', idempotencyKey: 'write-stopped-recovery-context',
      kind: 'invocation-context-committed', payload: { messages: [{ id: 'write-stopped-recovery-user', role: 'user', content: 'question', timestamp: 1 }] }
    }], 0)
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
    expect(markSessionMessageContentWriteStopped(db, session.id)).toBe(true)

    const recovered = await new SqliteAgentHistory(conn).recoverInterruptedInvocations()

    expect(recovered).toEqual([])
    expect(conn.prepare('SELECT kind FROM agent_history_events WHERE invocation_id=? ORDER BY sequence')
      .all('write-stopped-recovery-invocation')).toEqual([{ kind: 'invocation-context-committed' }])
    db.close()
  })

  it('keeps completed history outside the indexed startup recovery workset as terminal history grows', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, ?, 1, ?)')
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at)
      VALUES(?, 1, ?, ?, ?, 1, ?, ?, 1)`)
    const insertTerminal = (invocationId: string) => {
      insertStream.run(invocationId, 1, `session-${invocationId}`)
      insertEvent.run(invocationId, `${invocationId}:terminal`, `${invocationId}:terminal-key`, `${invocationId}:turn`,
        'invocation-completed', '{"status":"completed"}')
    }

    for (let index = 0; index < 128; index += 1) insertTerminal(`terminal-${index.toString().padStart(4, '0')}`)
    insertStream.run('active-work', 0, 'session-active-work')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await history.classifyLegacyProjectionRepairs(100)).complete) break
    }

    const workBefore = history.listStartupRecoveryWorkset()
    for (let index = 128; index < 640; index += 1) insertTerminal(`terminal-${index.toString().padStart(4, '0')}`)
    const workAfter = history.listStartupRecoveryWorkset()
    const plan = conn.prepare(`EXPLAIN QUERY PLAN SELECT invocation_id, session_id
      FROM canonical_history_recovery_work ORDER BY invocation_id`).all() as Array<{ detail: string }>

    expect(workBefore).toEqual([{ invocationId: 'active-work', sessionId: 'session-active-work' }])
    expect(workAfter).toEqual(workBefore)
    expect(plan.map(({ detail }) => detail).join(' ')).not.toMatch(/agent_history_(?:streams|events)/)
    expect(conn.prepare(`SELECT status FROM canonical_history_recovery_work_migration
      WHERE migration_key='active-invocations-v1'`).get()).toEqual({ status: 'complete' })
    const reads = vi.spyOn(history, 'read')
    await history.recoverInterruptedInvocations()
    expect(reads).toHaveBeenCalledTimes(1)
    conn.close()
  })

  it('resumes the bounded recovery-work census after reopen and keeps streams inserted behind its cursor', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-recovery-work-resume-'))
    const dbPath = path.join(directory, 'history.db')
    let conn = createDb(dbPath)
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,?,1,?)')
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES(?,1,?,?,?,1,?,?,1)`)
    const addTerminal = (invocationId: string) => {
      insertStream.run(invocationId, 1, `session-${invocationId}`)
      insertEvent.run(invocationId, `${invocationId}:terminal`, `${invocationId}:terminal-key`, `${invocationId}:turn`,
        'invocation-completed', '{"status":"completed"}')
    }
    try {
      addTerminal('100-terminal')
      insertStream.run('200-open', 0, 'session-200-open')
      insertStream.run('300-open', 0, 'session-300-open')
      const firstPass = await new SqliteAgentHistory(conn).classifyLegacyProjectionRepairs(1)
      expect(firstPass).toMatchObject({ complete: false, recoveryClassified: 1 })
      insertStream.run('050-late-open', 0, 'session-050-late-open')
      conn.close()

      conn = createDb(dbPath)
      const history = new SqliteAgentHistory(conn)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await history.classifyLegacyProjectionRepairs(1)).complete) break
      }

      expect(conn.prepare(`SELECT status FROM canonical_history_recovery_work_migration
        WHERE migration_key='active-invocations-v1'`).get()).toEqual({ status: 'complete' })
      expect(history.listStartupRecoveryWorkset()).toEqual([
        { invocationId: '050-late-open', sessionId: 'session-050-late-open' },
        { invocationId: '200-open', sessionId: 'session-200-open' },
        { invocationId: '300-open', sessionId: 'session-300-open' }
      ])
    } finally {
      conn.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('retries terminal projection repair on a later recovery pass without rescanning completed streams', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'terminal-retry-session', createdAt: 1 }
    await history.appendBatch([{
      ...event('terminal-retry-event', 1), invocationId: 'terminal-retry-invocation', kind: 'invocation-completed',
      payload: { status: 'completed', sessionLedger: { location, turnId: 'terminal-retry-turn', reason: 'completed' } }
    }], 0)
    await history.classifyLegacyProjectionRepairs(10)

    const failing = vi.fn(async () => { throw new Error('projection unavailable') })
    await history.recoverInterruptedInvocations({ repairInvocationTerminal: failing })
    expect(failing).toHaveBeenCalledTimes(1)
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='terminal-retry-invocation'").get())
      .toEqual({ status: 'pending', attempts: 1 })

    const succeeding = vi.fn(async () => undefined)
    await new SqliteAgentHistory(conn).recoverInterruptedInvocations({ repairInvocationTerminal: succeeding })
    expect(succeeding).toHaveBeenCalledWith(location, { status: 'completed', turnId: 'terminal-retry-turn', reason: 'completed' })
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='terminal-retry-invocation'").get())
      .toEqual({ status: 'completed', attempts: 2 })
    conn.close()
  })

  it('keeps terminal repair in the pending-work queue after nonterminal recovery has been narrowed', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'terminal-failed-session', createdAt: 1 }
    await history.appendBatch([{
      ...event('terminal-failed-event', 1), invocationId: 'terminal-failed-invocation', kind: 'invocation-completed',
      payload: { status: 'completed', sessionLedger: { location, turnId: 'terminal-failed-turn', reason: 'completed' } }
    }], 0)
    await history.classifyLegacyProjectionRepairs(10)
    const fail = vi.fn(async () => { throw new Error('injected projection failure') })
    await new SqliteAgentHistory(conn).recoverInterruptedInvocations({ repairInvocationTerminal: fail })
    expect(fail).toHaveBeenCalledOnce()
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='terminal-failed-invocation'").get())
      .toEqual({ status: 'pending', attempts: 1 })

    const retry = vi.fn(async () => undefined)
    await new SqliteAgentHistory(conn).recoverInterruptedInvocations({ repairInvocationTerminal: retry })
    expect(retry).toHaveBeenCalledWith(location, { status: 'completed', turnId: 'terminal-failed-turn', reason: 'completed' })
    expect(conn.prepare("SELECT status, attempts FROM canonical_projection_repairs WHERE invocation_id='terminal-failed-invocation'").get())
      .toEqual({ status: 'completed', attempts: 2 })
    conn.close()
  })

  it('produces the same restart state and sidecar projections with exhaustive and classified worksets', async () => {
    const sessionId = 'recovery-equivalence-session'
    const locationFor = (createdAt: number) => ({ workDir: '/workspace', sessionId, createdAt })
    const exercise = async (classifyBeforeRecovery: boolean) => {
      const conn = createDb()
      const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId)
      const openRequestId = 'equivalence-open:round:1'
      await history.appendBatch([{
        ...event('equivalence-open-request', 1), invocationId: 'a-open', turnId: 'a-open-turn', kind: 'model-request-started',
        payload: {
          requestId: openRequestId, modelTurn: 1, attempt: 1,
          sessionLedger: {
            location: locationFor(1),
            requestHeader: { requestId: openRequestId, attempt: 1, turnId: 'a-open-turn' },
            requestContext: { requestId: openRequestId, attempt: 1, turnId: 'a-open-turn' }
          }
        }
      }], 0)
      await history.appendBatch([{
        ...event('equivalence-done-terminal', 1), invocationId: 'z-done', turnId: 'z-done-turn', kind: 'invocation-completed',
        payload: {
          status: 'completed', sessionLedger: {
            location: locationFor(2), turnId: 'z-done-turn', reason: 'completed'
          }
        }
      }], 0)
      if (classifyBeforeRecovery) {
        await history.classifyLegacyProjectionRepairs(1)
        await history.classifyLegacyProjectionRepairs(10)
      }
      const projections: Array<{ kind: string; invocation: string; value: unknown }> = []
      const recoveryOptions = {
        repairModelRequestLedger: async (location: CompactionLedgerLocation, projection: { requestHeader: Record<string, unknown>; requestContext: Record<string, unknown> }) => {
          projections.push({ kind: 'request', invocation: 'a-open', value: { location, projection } })
        },
        repairInvocationTerminal: async (location: CompactionLedgerLocation, terminal: Record<string, unknown>) => {
          projections.push({
            kind: `terminal:${terminal.status}`,
            invocation: terminal.turnId === 'a-open-turn' ? 'a-open' : 'z-done',
            value: { location, terminal }
          })
        }
      }
      const states = await history.recoverInterruptedInvocations(recoveryOptions)
      const eventsByInvocation = await Promise.all(['a-open', 'z-done'].map(async (invocationId) => ({
        invocationId,
        events: (await history.read(invocationId)).events
      })))
      conn.close()
      return { states, eventsByInvocation, projections }
    }

    await expect(exercise(true)).resolves.toEqual(await exercise(false))
  })

  it('preserves all projection repairs and restart state across classified and exhaustive recovery', async () => {
    const location = { workDir: '/workspace', sessionId: 'recovery-matrix-session', createdAt: 1000 }
    const exercise = async (classifyBeforeRecovery: boolean) => {
      const conn = createDb()
      const history = new SqliteAgentHistory(conn, 1, () => 100, 'recovery-matrix-session')
      const append = async (invocationId: string, entries: Array<{ id: string; kind: HistoryEvent['kind']; turnId?: string; payload: Record<string, unknown> }>) => {
        await history.appendBatch(entries.map(({ id, kind, turnId, payload }, index) => ({
          ...event(id, index + 1), invocationId, turnId: turnId ?? `${invocationId}-turn`, kind, payload
        })), 0)
      }
      await append('matrix-request', [{
        id: 'matrix-request-start', kind: 'model-request-started', payload: {
          requestId: 'matrix-request:round:1', modelTurn: 1, attempt: 1,
          sessionLedger: { location, requestHeader: { requestId: 'matrix-request:round:1', attempt: 1, turnId: 'matrix-request-turn' }, requestContext: { requestId: 'matrix-request:round:1', attempt: 1, turnId: 'matrix-request-turn' } }
        }
      }])
      await append('matrix-response', [{
        id: 'matrix-response-committed', kind: 'model-response-committed', payload: {
          modelTurn: 1, attempt: 1,
          message: { role: 'assistant', content: 'done', toolCalls: [{ id: 'matrix-call', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: {
            location, stepId: 'matrix-response',
            toolCalls: [{ toolUseId: 'matrix-call', name: 'read_file', args: { path: 'a.txt' } }],
            requestUsage: { requestId: 'matrix-response:round:1', turnId: 'matrix-response-turn', usage: { inputTokens: 4 } },
            requestContext: { requestId: 'matrix-response:round:1', turnId: 'matrix-response-turn', attempt: 1, contextUsage: { pressureTokens: 5 } }
          }
        }
      }])
      await append('matrix-retry', [{
        id: 'matrix-retry-scheduled', kind: 'provider-retry-scheduled', payload: {
          requestId: 'matrix-retry:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
          sessionLedger: { location, requestRetry: { requestId: 'matrix-retry:round:1', attempt: 1, code: 'provider_context_overflow', backoffMs: 0 } }
        }
      }])
      await append('matrix-compaction', [{
        id: 'matrix-compacted', kind: 'transcript-compacted', payload: {
          messages: [{ role: 'user', content: 'current' }],
          sessionLedger: { location, start: { compactionId: 'matrix-compact' }, summary: { compactionId: 'matrix-compact' } }
        }
      }])
      await append('matrix-terminal', [{
        id: 'matrix-terminal-event', kind: 'invocation-completed', payload: {
          status: 'completed', sessionLedger: { location, turnId: 'matrix-terminal-turn', reason: 'completed' }
        }
      }])
      await append('matrix-tool', [{
        id: 'matrix-tool-proposal', kind: 'model-response-committed', payload: {
          modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'matrix-tool-call', name: 'read_file', input: { path: 'b.txt' } }] },
          sessionLedger: { location, stepId: 'matrix-tool', toolCalls: [{ toolUseId: 'matrix-tool-call', name: 'read_file', args: { path: 'b.txt' } }] }
        }
      }, {
        id: 'matrix-tool-finished', kind: 'tool-call-finished', payload: {
          toolCallId: 'matrix-tool-call', result: { success: true, data: 'ok' },
          sessionLedger: { location, stepId: 'matrix-tool', result: { success: true, data: 'ok' } }
        }
      }])
      await append('matrix-open', [{
        id: 'matrix-open-request', kind: 'model-request-started', payload: { requestId: 'matrix-open:round:1', modelTurn: 1, attempt: 1 }
      }])
      if (classifyBeforeRecovery) {
        const first = await history.classifyLegacyProjectionRepairs(2)
        const remainder = await history.classifyLegacyProjectionRepairs(20)
        expect(first.complete || remainder.complete).toBe(true)
        expect(remainder.complete).toBe(true)
      }
      const calls: Array<{ kind: string; args: unknown[] }> = []
      const callback = (kind: string) => async (...args: unknown[]) => { calls.push({ kind, args }) }
      const states = await history.recoverInterruptedInvocations({
        repairModelRequestLedger: callback('request'),
        repairProviderRetryLedger: callback('retry'),
        repairUsageLedger: callback('usage'),
        repairFinalRequestContextLedger: callback('final-context'),
        repairToolCallLedger: callback('tool-call'),
        repairToolLedger: callback('tool-result'),
        repairCompaction: callback('compaction'),
        repairInvocationTerminal: callback('terminal')
      })
      const snapshot = await Promise.all(['matrix-request', 'matrix-response', 'matrix-tool', 'matrix-retry', 'matrix-compaction', 'matrix-terminal', 'matrix-open']
        .map(async (invocationId) => ({ invocationId, events: (await history.read(invocationId)).events })))
      const repairs = conn.prepare('SELECT invocation_id, target_key, status, attempts FROM canonical_projection_repairs ORDER BY invocation_id, target_key').all()
      conn.close()
      return {
        states,
        snapshot,
        calls: calls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        repairs
      }
    }

    const classified = await exercise(true)
    const exhaustive = await exercise(false)
    expect(classified).toEqual(exhaustive)
    expect(classified.calls.map(({ kind }) => kind).sort()).toEqual([
      'compaction', 'final-context', 'request', 'retry', 'terminal', 'terminal', 'terminal', 'terminal', 'terminal',
      'tool-call', 'tool-call', 'tool-result', 'usage'
    ])
    expect(classified.repairs).toHaveLength(11)
    expect(classified.repairs.every((repair) => repair.status === 'completed' && repair.attempts === 1)).toBe(true)
  })

  it('keeps each classified projection target pending after callback failure and retries it after restart', async () => {
    const location = { workDir: '/workspace', sessionId: 'repair-failure-matrix', createdAt: 1000 }
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const specs: Array<{ kind: string; events: HistoryEvent[]; invocationId: string; targetEventId: string }> = [
      { kind: 'request', invocationId: 'inv-request', targetEventId: 'failure-request', events: [{ ...event('failure-request', 1), invocationId: 'inv-request', kind: 'model-request-started', payload: {
        requestId: 'inv-request:round:1', modelTurn: 1, attempt: 1,
        sessionLedger: { location, requestHeader: { requestId: 'inv-request:round:1', attempt: 1 }, requestContext: { requestId: 'inv-request:round:1', attempt: 1 } }
      } }] },
      { kind: 'retry', invocationId: 'inv-retry', targetEventId: 'failure-retry', events: [
        { ...event('failure-retry-request', 1), invocationId: 'inv-retry', turnId: 'turn-1', kind: 'model-request-started', payload: {
          requestId: 'inv-retry:round:1', modelTurn: 1, attempt: 1,
          sessionLedger: { location, requestHeader: { requestId: 'inv-retry:round:1', attempt: 1 }, requestContext: { requestId: 'inv-retry:round:1', attempt: 1 } }
        } },
        { ...event('failure-retry', 2), invocationId: 'inv-retry', turnId: 'turn-1', kind: 'provider-retry-scheduled', payload: {
          requestId: 'inv-retry:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
          sessionLedger: { location, requestRetry: { turnId: 'turn-1', stepId: 'inv-retry', requestId: 'inv-retry:round:1', attempt: 1, code: 'provider_context_overflow', backoffMs: 0 } }
        } }
      ] },
      { kind: 'tool-call', invocationId: 'inv-tool-call', targetEventId: 'failure-tool-call', events: [{ ...event('failure-tool-call', 1), invocationId: 'inv-tool-call', kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'failure-tool-call-id', name: 'read_file', input: { path: 'a' } }] },
        sessionLedger: { location, stepId: 'inv-tool-call', toolCalls: [{ toolUseId: 'failure-tool-call-id', name: 'read_file', args: { path: 'a' } }] }
      } }] },
      { kind: 'usage', invocationId: 'inv-usage', targetEventId: 'failure-usage', events: [{ ...event('failure-usage', 1), invocationId: 'inv-usage', kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', toolCalls: [] }, sessionLedger: { location, requestUsage: { requestId: 'inv-usage:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } }
      } }] },
      { kind: 'final-context', invocationId: 'inv-final-context', targetEventId: 'failure-final-context', events: [{ ...event('failure-final-context', 1), invocationId: 'inv-final-context', kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', toolCalls: [] }, sessionLedger: { location, requestContext: { requestId: 'inv-final-context:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 1 } } }
      } }] },
      { kind: 'tool-result', invocationId: 'inv-tool-result', targetEventId: 'failure-tool-result', events: [
        { ...event('failure-tool-proposal', 1), invocationId: 'inv-tool-result', kind: 'model-response-committed', payload: {
          modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'failure-tool-result-id', name: 'read_file', input: { path: 'a' } }] },
          sessionLedger: { location, stepId: 'inv-tool-result', toolCalls: [{ toolUseId: 'failure-tool-result-id', name: 'read_file', args: { path: 'a' } }] }
        } },
        { ...event('failure-tool-result', 2), invocationId: 'inv-tool-result', kind: 'tool-call-not-dispatched', payload: {
          toolCallId: 'failure-tool-result-id', sessionLedger: { location, stepId: 'inv-tool-result', result: { success: false, notExecuted: true } }
        } }
      ] },
      { kind: 'terminal', invocationId: 'inv-terminal', targetEventId: 'failure-terminal', events: [{ ...event('failure-terminal', 1), invocationId: 'inv-terminal', kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-1', reason: 'completed' }
      } }] }
    ]
    for (const { events } of specs) await history.appendBatch(events, 0)
    const classify = await history.classifyLegacyProjectionRepairs(20)
    expect(classify.complete).toBe(true)
    for (const { invocationId, events } of specs) {
      if (invocationId === 'inv-tool-call' || invocationId === 'inv-tool-result') continue
      if (invocationId === 'inv-terminal') continue
      const last = events.at(-1)!
      const version = events.length
      await history.appendBatch([{
        ...event(`${invocationId}-terminal-seal`, version + 1), invocationId, turnId: last.turnId,
        kind: 'invocation-completed', payload: { status: 'completed' }
      }], version)
    }
    const failed = async () => { throw new Error('injected projection repair failure') }
    await history.recoverInterruptedInvocations({
      repairModelRequestLedger: failed, repairProviderRetryLedger: failed, repairToolCallLedger: failed, repairUsageLedger: failed,
      repairFinalRequestContextLedger: failed, repairToolLedger: failed, repairCompaction: failed, repairInvocationTerminal: failed
    })
    expect(conn.prepare("SELECT COUNT(*) AS count FROM canonical_projection_repairs WHERE status='pending' AND attempts=1").get()).toEqual({ count: 11 })
    expect(conn.prepare("SELECT COUNT(*) AS count FROM canonical_projection_repairs WHERE status='completed'").get()).toEqual({ count: 0 })
    const retryHistory = new SqliteAgentHistory(conn)
    const successOptions = {
      repairModelRequestLedger: vi.fn(async () => undefined),
      repairProviderRetryLedger: vi.fn(async () => undefined),
      repairToolCallLedger: vi.fn(async () => undefined),
      repairUsageLedger: vi.fn(async () => undefined),
      repairFinalRequestContextLedger: vi.fn(async () => undefined),
      repairToolLedger: vi.fn(async () => undefined),
      repairCompaction: vi.fn(async () => undefined),
      repairInvocationTerminal: vi.fn(async () => undefined)
    }
    await retryHistory.recoverInterruptedInvocations(successOptions)
    expect(conn.prepare("SELECT repair_id, target_key, status, attempts FROM canonical_projection_repairs WHERE status='pending'").all()).toEqual([])
    expect(conn.prepare("SELECT COUNT(*) AS count FROM canonical_projection_repairs WHERE status='completed' AND attempts=2").get()).toEqual({ count: 11 })
    for (const callback of [successOptions.repairModelRequestLedger, successOptions.repairProviderRetryLedger,
      successOptions.repairToolCallLedger, successOptions.repairUsageLedger, successOptions.repairFinalRequestContextLedger,
      successOptions.repairToolLedger, successOptions.repairInvocationTerminal]) expect(callback).toHaveBeenCalled()
    conn.close()
  })

  it.each(['before-commit', 'after-commit-ack-lost'] as const)('settles SDK terminal History append failure against real SQLite: %s', async (failurePoint) => {
    const conn = createDb()
    const durableHistory = new SqliteAgentHistory(conn)
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register({ routeId: `terminal-${failurePoint}`, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'terminal-fault-provider', stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'accepted answer' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const history = failurePoint === 'before-commit'
      ? (() => {
          conn.exec(`CREATE TRIGGER fail_completion_terminal BEFORE INSERT ON agent_history_events
            WHEN NEW.kind='invocation-completed' BEGIN SELECT RAISE(ABORT, 'injected terminal History failure'); END`)
          return durableHistory
        })()
      : {
          appendBatch: async (events: readonly HistoryEvent[], version: number) => {
            const result = await durableHistory.appendBatch(events, version)
            if (events.some((entry) => entry.kind === 'invocation-completed')) throw new Error('completion acknowledgement lost')
            return result
          },
          read: (invocationId: string) => durableHistory.read(invocationId)
        }
    const permits = new InMemorySafetyPermitStore()
    const onTurnFinished = vi.fn()

    const run = runAgentTurn({
      registry, routeId: `terminal-${failurePoint}`, invocationId: `terminal-${failurePoint}`, turnId: `turn-${failurePoint}`,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 }, maxModelTurns: 1, history,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(),
      toolExecution: createPermitBoundToolExecutionPort({
        permits, admission: new InMemoryExecutionAdmissionCoordinator(),
        resolveExpected: async () => { throw new Error('tool execution is not expected') },
        execute: async () => ({ output: undefined })
      }),
      observer: { onTurnFinished }
    })

    if (failurePoint === 'before-commit') await expect(run).rejects.toThrow('injected terminal History failure')
    else await expect(run).resolves.toMatchObject({ text: 'accepted answer' })

    const events = (await durableHistory.read(`terminal-${failurePoint}`)).events
    const terminals = events.filter((entry) => ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(entry.kind))
    expect(providerCalls).toBe(1)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.kind).toBe(failurePoint === 'before-commit' ? 'invocation-failed' : 'invocation-completed')
    expect(onTurnFinished).toHaveBeenCalledTimes(failurePoint === 'before-commit' ? 0 : 1)
    conn.close()
  })

  it('resolves requestId to the canonical turn stream from the durable AcceptedTurn ledger', async () => {
    const conn = createDb()
    const acceptedTurn = createAcceptedTurn({
      turnId: 'approval-turn', requestId: 'approval-request', sessionId: 'approval-session', lane: 'automation',
      startToken: 'approval-start', currentUserMessageId: 'approval-user', transcriptVersion: 0, config: { lane: 'automation' }
    })
    conn.prepare('INSERT INTO accepted_turn_contexts(turn_id,session_id,request_id,accepted_turn_json,created_at) VALUES(?,?,?,?,?)')
      .run(acceptedTurn.turnId, acceptedTurn.sessionId, acceptedTurn.requestId, JSON.stringify(acceptedTurn), 1)
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'approval-session')
    await history.appendBatch([{ ...event('approval-event', 1), invocationId: acceptedTurn.turnId, turnId: acceptedTurn.turnId }], 0)

    expect(conn.prepare('SELECT request_id,turn_id FROM accepted_turn_contexts').all()).toEqual([{ request_id: 'approval-request', turn_id: 'approval-turn' }])
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accepted_turn_contexts'").get()).toBeDefined()
    expect(history.readSync('approval-request')).toMatchObject({ invocationId: 'approval-turn', events: [{ turnId: 'approval-turn' }] })
    conn.close()
  })

  it('resolves a shared requestId only to the turn owned by this session', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema_version', '15')")
    conn.exec(CREATE_TABLES_SQL)
    runMigrations(conn)
    conn.exec(`CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session_id, request_id));`)
    for (const sessionId of ['session-a', 'session-b']) {
      conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation) VALUES(?,'s','m',0.7,1,1,1,'{}','{}',1,?)`).run(sessionId, `generation-${sessionId}`)
      const messageId = `${sessionId}-assistant`
      conn.prepare("INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES(?,?,'assistant','','completed',1,1,1)").run(messageId, sessionId)
      conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
        VALUES(?, 'same-request', ?, ?, 'completed', 1, 1)`).run(`${sessionId}-turn`, sessionId, messageId)
      const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
      await history.appendBatch([
        { ...event(`${sessionId}-context`, 1), invocationId: `${sessionId}-turn`, turnId: `${sessionId}-turn`, kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: sessionId }] } },
        { ...event(`${sessionId}-terminal`, 2), invocationId: `${sessionId}-turn`, turnId: `${sessionId}-turn`, kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
    }

    const sessionASnapshot = new SqliteAgentHistory(conn, 1, Date.now, 'session-a').readSync('same-request')
    const sessionBSnapshot = new SqliteAgentHistory(conn, 1, Date.now, 'session-b').readSync('same-request')
    expect(sessionASnapshot.invocationId).toBe('session-a-turn')
    expect(sessionASnapshot.events[0]?.payload).toMatchObject({ messages: [{ role: 'user', content: 'session-a' }] })
    expect(sessionBSnapshot.invocationId).toBe('session-b-turn')
    expect(sessionBSnapshot.events[0]?.payload).toMatchObject({ messages: [{ role: 'user', content: 'session-b' }] })
    expect(() => new SqliteAgentHistory(conn, 1, Date.now, 'session-a').readSync('session-b-turn'))
      .toThrow(/does not belong to session/)
    expect(() => new SqliteAgentHistory(conn).readSync('same-request')).toThrow(/maps to multiple session turns/)
    conn.close()
  })

  it('indexes invocations by owning session and rejects rebinding a stream to another session', async () => {
    const conn = createDb()
    const sessionA = new SqliteAgentHistory(conn, 1, Date.now, 'session-a')
    const sessionB = new SqliteAgentHistory(conn, 1, Date.now, 'session-b')
    await sessionA.appendBatch([event('session-a-event', 1)], 0)
    await sessionB.appendBatch([{ ...event('session-b-event', 1), invocationId: 'inv-2', turnId: 'turn-2' }], 0)

    expect(sessionA.listInvocationIdsForSession('session-a')).toEqual(['inv-1'])
    expect(sessionA.listInvocationIdsForSession('session-b')).toEqual(['inv-2'])
    await expect(new SqliteAgentHistory(conn, 1, Date.now, 'session-b').appendBatch([event('session-a-next', 2)], 1))
      .rejects.toThrow(/belongs to session-a/)
    expect(sessionA.listInvocationIdsForSession('session-a')).toEqual(['inv-1'])
    conn.close()
  })

  it('returns only the latest completed invocation snapshot for a session', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-reader')
    const appendInvocation = async (invocationId: string, sequence: number, kind: HistoryEvent['kind'], payload: unknown) => history.appendBatch([{
      ...event(`${invocationId}-${sequence}`, sequence), invocationId, turnId: invocationId, kind, payload
    }], sequence - 1)
    await appendInvocation('inv-older', 1, 'invocation-context-committed', { messages: [{ role: 'user', content: 'old' }] })
    await appendInvocation('inv-older', 2, 'invocation-completed', { status: 'completed' })
    await appendInvocation('inv-latest', 1, 'invocation-context-committed', { messages: [{ role: 'user', content: 'latest' }] })

    expect(await history.readLatestCompletedInvocationForSession('session-reader')).toBeUndefined()
    await expect(history.readLatestCompletedInvocationForSession('session-reader', { excludeInvocationId: 'inv-latest' }))
      .resolves.toMatchObject({ invocationId: 'inv-older' })

    await appendInvocation('inv-latest', 2, 'invocation-completed', { status: 'completed' })
    await new SqliteAgentHistory(conn, 1, () => 100, 'other-session').appendBatch([{
      ...event('other-session-event', 1), invocationId: 'inv-other', turnId: 'inv-other', kind: 'invocation-context-committed', payload: { messages: [] }
    }], 0)

    await expect(history.readLatestCompletedInvocationForSession('session-reader')).resolves.toMatchObject({
      invocationId: 'inv-latest', version: 2,
      events: [expect.objectContaining({ eventId: 'inv-latest-1' }), expect.objectContaining({ kind: 'invocation-completed' })]
    })
    conn.close()
  })

  it('rejects a History event whose session owner drifts from its invocation stream', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'event-owner-session')
    await history.appendBatch([{
      ...event('event-owner-context', 1), invocationId: 'event-owner-invocation', turnId: 'event-owner-turn',
      kind: 'invocation-context-committed', payload: { messages: [{ id: 'event-owner-user', role: 'user', content: 'body', timestamp: 1 }] }
    }], 0)
    conn.prepare('UPDATE agent_history_events SET session_id=? WHERE event_id=?').run('foreign-session', 'event-owner-context')

    expect(() => history.readSync('event-owner-invocation')).toThrow(/event session ownership differs from its invocation stream/)
    conn.close()
  })

  it('reads legacy History events whose session owner is inherited from the stream', () => {
    const conn = createDb()
    const invocationId = 'legacy-null-owner-invocation'
    const sessionId = 'legacy-null-owner-session'
    const legacyEvent = {
      ...event('legacy-null-owner-event', 1), invocationId, turnId: 'legacy-null-owner-turn',
      kind: 'tool-call-started' as const
    }
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id)
      VALUES(?,1,1,?)`).run(invocationId, sessionId)
    conn.prepare(`INSERT INTO agent_history_events(
      invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id,commit_order,session_seq
    ) VALUES(?,1,?,?,?,?,?,?,1,NULL,NULL,NULL)`).run(
      invocationId, legacyEvent.eventId, legacyEvent.idempotencyKey, legacyEvent.turnId, 1,
      legacyEvent.kind, JSON.stringify(legacyEvent.payload)
    )

    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    expect(history.listInvocationIdsForSession(sessionId)).toEqual([invocationId])
    expect(history.readSync(invocationId).events).toMatchObject([{ eventId: legacyEvent.eventId, kind: legacyEvent.kind }])
    conn.close()
  })

  it('distinguishes a session without History from a latest open canonical stream', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-latest-state')
    await expect(history.readLatestInvocationForSession('session-latest-state')).resolves.toEqual({ kind: 'none' })
    await history.appendBatch([{
      ...event('latest-incomplete-context', 1), invocationId: 'latest-incomplete', turnId: 'latest-incomplete-turn',
      kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'in progress' }] }
    }], 0)

    await expect(history.readLatestInvocationForSession('session-latest-state')).resolves.toEqual({ kind: 'unavailable', invocationId: 'latest-incomplete' })
    conn.close()
  })

  it('uses the last completed transcript after a later invocation has a failed terminal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-failed-latest')
    await history.appendBatch([
      { ...event('prior-context', 1), invocationId: 'prior-completed', turnId: 'prior-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'prior' }] } },
      { ...event('prior-done', 2), invocationId: 'prior-completed', turnId: 'prior-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    await history.appendBatch([
      { ...event('failed-context', 1), invocationId: 'latest-failed', turnId: 'latest-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'failed request' }] } },
      { ...event('failed-terminal', 2), invocationId: 'latest-failed', turnId: 'latest-turn', kind: 'invocation-failed', payload: { status: 'failed' } }
    ], 0)

    await expect(history.readLatestInvocationForSession('session-failed-latest')).resolves.toMatchObject({
      kind: 'completed', snapshot: { invocationId: 'prior-completed' }
    })
    conn.close()
  })

  it('returns a user-cancelled canonical transcript for validated next-turn cutover', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-cancelled-latest')
    await history.appendBatch([
      { ...event('cancelled-context', 1), invocationId: 'user-cancelled', turnId: 'cancelled-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'accepted user input' }] } },
      { ...event('cancelled-terminal', 2), invocationId: 'user-cancelled', turnId: 'cancelled-turn', kind: 'invocation-interrupted', payload: { status: 'cancelled' } }
    ], 0)

    await expect(history.readLatestInvocationForSession('session-cancelled-latest')).resolves.toMatchObject({
      kind: 'cancelled', snapshot: { invocationId: 'user-cancelled' }
    })
    await expect(history.readLatestCompletedInvocationForSession('session-cancelled-latest')).resolves.toBeUndefined()
    conn.close()
  })

  it('does not treat a completion-kind terminal with a failed status as a usable session transcript', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-terminal-payload-mismatch')
    await history.appendBatch([
      { ...event('mismatched-terminal-context', 1), invocationId: 'mismatched-terminal', turnId: 'mismatched-terminal-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'must not handoff' }] } },
      { ...event('mismatched-terminal-done', 2), invocationId: 'mismatched-terminal', turnId: 'mismatched-terminal-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare('UPDATE agent_history_events SET payload_json = ? WHERE event_id = ?')
      .run(JSON.stringify({ status: 'failed' }), 'mismatched-terminal-done')

    await expect(history.readLatestInvocationForSession('session-terminal-payload-mismatch'))
      .rejects.toThrow(/history stream mismatched-terminal is corrupt: completed invocation terminal requires completed status/)
    await expect(history.readLatestCompletedInvocationForSession('session-terminal-payload-mismatch'))
      .rejects.toThrow(/history stream mismatched-terminal is corrupt: completed invocation terminal requires completed status/)
    conn.close()
  })

  it('fails closed when a persisted invocation uses a schema version newer than this adapter', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-future-schema')
    await history.appendBatch([
      { ...event('future-schema-context', 1), invocationId: 'future-schema-invocation', turnId: 'future-schema-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'do not replay with an old schema' }] } },
      { ...event('future-schema-completed', 2), invocationId: 'future-schema-invocation', turnId: 'future-schema-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare('UPDATE agent_history_streams SET schema_version = ? WHERE invocation_id = ?').run(2, 'future-schema-invocation')
    conn.prepare('UPDATE agent_history_events SET schema_version = ? WHERE invocation_id = ?').run(2, 'future-schema-invocation')

    await expect(history.readLatestInvocationForSession('session-future-schema'))
      .rejects.toThrow(/history stream future-schema-invocation is corrupt: unsupported schema version 2 \(adapter supports 1\)/)
    await expect(history.read('future-schema-invocation'))
      .rejects.toThrow(/unsupported schema version 2/)
    conn.close()
  })

  it('fails closed when a persisted event kind is unknown to the History contract', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-unknown-event')
    await history.appendBatch([
      { ...event('unknown-event-context', 1), invocationId: 'unknown-event-invocation', turnId: 'unknown-event-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'unknown event' }] } },
      { ...event('unknown-event-completed', 2), invocationId: 'unknown-event-invocation', turnId: 'unknown-event-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare('UPDATE agent_history_events SET kind = ? WHERE invocation_id = ? AND sequence = ?')
      .run('future-history-event', 'unknown-event-invocation', 1)

    await expect(history.readLatestInvocationForSession('session-unknown-event'))
      .rejects.toThrow(/history stream unknown-event-invocation is corrupt: unsupported history event kind future-history-event/)
    conn.close()
  })

  it('does not include legacy streams with unknown session ownership in a session transcript index', async () => {
    const conn = createDb()
    const ownedHistory = new SqliteAgentHistory(conn, 1, () => 100, 'session-owner')
    const legacyHistory = new SqliteAgentHistory(conn, 1, () => 90)
    await legacyHistory.appendBatch([
      { ...event('legacy-context', 1), kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'belongs somewhere' }] } },
      { ...event('legacy-completed', 2), kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    await ownedHistory.appendBatch([
      { ...event('owned-context', 1), invocationId: 'owned-invocation', turnId: 'owned-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'owned' }] } },
      { ...event('owned-completed', 2), invocationId: 'owned-invocation', turnId: 'owned-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)

    expect(ownedHistory.listInvocationIdsForSession('session-owner')).toEqual(['owned-invocation'])
    expect(await ownedHistory.readLatestCompletedInvocationForSession('session-owner')).toMatchObject({ invocationId: 'owned-invocation' })
    conn.close()
  })

  it('rejects a durable terminal batch when a previous batch still has a pending tool proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('cross-batch-proposal', 1), kind: 'model-response-committed',
      payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-cross-batch' }] } }
    }], 0)

    await expect(history.appendBatch([{
      ...event('cross-batch-terminal', 2), kind: 'invocation-completed', payload: { status: 'completed' }
    }], 1)).rejects.toThrow(/pending tool calls or approvals/)
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 1, events: [expect.objectContaining({ eventId: 'cross-batch-proposal' })]
    })
    conn.close()
  })

  it('repairs a missing request_usage event from canonical attempt ledger metadata', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-usage-repair-'))
    const location = { workDir: root, sessionId: 'session-usage', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const repairUsageLedger = vi.fn((repairLocation, requestUsage) => {
      expect(repairLocation).toEqual(location)
      return ensureRequestUsageEvent(sink, requestUsage as never)
    })
    await history.appendBatch([
      {
        ...event('discarded-attempt', 1), kind: 'model-attempt-discarded',
        payload: { modelTurn: 1, attempt: 1, reasonCode: 'SILENT_CONTEXT_OVERFLOW', sessionLedger: { location, requestUsage: {
          schemaVersion: 1, requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { input_tokens: 20, output_tokens: 2 }, source: 'api', resultDisposition: 'discarded_overflow'
        } } }
      },
      {
        ...event('model-response', 2), kind: 'model-response-committed',
        payload: {
          modelTurn: 1,
          attempt: 2,
          message: { role: 'assistant', content: 'done' },
          sessionLedger: { location, requestUsage: {
            schemaVersion: 1, requestId: 'inv-1:round:1:attempt:2', turnId: 'turn-1', usage: { input_tokens: 12, output_tokens: 3 }, source: 'api'
          } }
        }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairUsageLedger })

    expect(repairUsageLedger).toHaveBeenNthCalledWith(1, location, {
      schemaVersion: 1, requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { input_tokens: 20, output_tokens: 2 }, source: 'api', resultDisposition: 'discarded_overflow'
    })
    expect(repairUsageLedger).toHaveBeenNthCalledWith(2, location, {
      schemaVersion: 1, requestId: 'inv-1:round:1:attempt:2', turnId: 'turn-1', usage: { input_tokens: 12, output_tokens: 3 }, source: 'api'
    })
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'request_usage', payload: { requestId: 'inv-1:round:1', usage: { input_tokens: 20, output_tokens: 2 }, resultDisposition: 'discarded_overflow' } },
      { type: 'request_usage', payload: { requestId: 'inv-1:round:1:attempt:2', usage: { input_tokens: 12, output_tokens: 3 } } }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('rejects a request_usage sidecar bound to another invocation before session projection', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/cross-invocation-usage', sessionId: 'session-usage-owner', createdAt: 1000 }
    const repairUsageLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([{
      ...event('cross-invocation-usage', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done' }, sessionLedger: { location, requestUsage: {
        schemaVersion: 1, requestId: 'other-invocation:round:1', turnId: 'turn-1', usage: { input_tokens: 2, output_tokens: 1 }, source: 'api'
      } } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairUsageLedger, onUsageLedgerRepairError: onRepairError })

    expect(repairUsageLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'other-invocation:round:1')
    conn.close()
  })

  it('replays missing tool proposal and result ledger events in canonical History order', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-ledger-order-'))
    const location = { workDir: root, sessionId: 'session-order', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const proposal = (id: string, sequence: number) => ({
      ...event(`response-${sequence}`, sequence), kind: 'model-response-committed' as const,
      payload: { message: { role: 'assistant', toolCalls: [{ id, name: 'read_file', input: { path: `${id}.txt` } }] }, sessionLedger: {
        location, stepId: `${id}:step`, toolCalls: [{ toolUseId: id, name: 'read_file', args: { path: `${id}.txt` } }]
      } }
    })
    await history.appendBatch([
      proposal('call-1', 1),
      { ...event('finished-1', 2), kind: 'tool-call-finished', payload: { toolCallId: 'call-1', result: { success: true, data: 'one' }, sessionLedger: { location, stepId: 'call-1:step', result: { success: true, data: 'one' } } } },
      proposal('call-2', 3),
      { ...event('finished-2', 4), kind: 'tool-call-finished', payload: { toolCallId: 'call-2', result: { success: true, data: 'two' }, sessionLedger: { location, stepId: 'call-2:step', result: { success: true, data: 'two' } } } }
    ], 0)

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: (repairLocation, toolCall) => ensureToolCallEvent(sink, toolCall as never),
      repairToolLedger: (repairLocation, result) => ensureToolResultEvent(sink, result as never)
    })

    const repaired = await readSessionEvents(sink.eventsPath)
    expect(repaired.map(({ type, payload }) => [type, payload.toolUseId])).toEqual([
      ['tool_call', 'call-1'], ['tool_result', 'call-1'], ['tool_call', 'call-2'], ['tool_result', 'call-2']
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs missing tool-call session events from a canonical model response envelope', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-tool-call-repair-'))
    const location = { workDir: root, sessionId: 'session-1', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const repairToolCallLedger = vi.fn((repairLocation, toolCall) => {
      expect(repairLocation).toEqual(location)
      return ensureToolCallEvent(sink, toolCall)
    })
    await history.appendBatch([{
      ...event('model-response', 1),
      kind: 'model-response-committed',
      payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'tc-proposed', name: 'write_file', input: { path: 'a.txt' } }] },
        sessionLedger: {
          location,
          stepId: 'req-1:model:1', toolCalls: [{ toolUseId: 'tc-proposed', name: 'write_file', args: { path: 'a.txt' } }]
        }
      }
    }], 0)

    await history.recoverInterruptedInvocations({ repairToolCallLedger })

    expect(repairToolCallLedger).toHaveBeenCalledWith(
      location,
      { toolUseId: 'tc-proposed', turnId: 'turn-1', stepId: 'req-1:model:1', name: 'write_file', args: { path: 'a.txt' } }
    )
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'tool_call', payload: { toolUseId: 'tc-proposed', turnId: 'turn-1', stepId: 'req-1:model:1', name: 'write_file', args: { path: 'a.txt' } } }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs the tool result session ledger from a canonical tool completion event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-tool-repair-'))
    const location = { workDir: root, sessionId: 'session-1', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const repairToolLedger = vi.fn((repairLocation, repairEvent) => {
      expect(repairLocation).toEqual(location)
      return ensureToolResultEvent(sink, repairEvent)
    })
    await history.appendBatch([{
      ...event('tool-finished', 1),
      kind: 'tool-call-finished',
      payload: {
        toolCallId: 'tc-1', toolName: 'read_file', isError: false, result: { success: true, data: 'file contents' },
        sessionLedger: {
          location,
          stepId: 'req-1', result: { success: true, data: 'file contents' }
        }
      }
    }], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger })

    expect(repairToolLedger).toHaveBeenCalledWith(
      location,
      { toolUseId: 'tc-1', turnId: 'turn-1', stepId: 'req-1', result: { success: true, data: 'file contents' } }
    )
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'tool_result', payload: { toolUseId: 'tc-1', turnId: 'turn-1', stepId: 'req-1', result: { success: true, data: 'file contents' } } }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('rejects a tool result sidecar whose call id differs from the canonical proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/cross-tool-result', sessionId: 'session-tool-owner', createdAt: 1000 }
    const repairToolLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('proposal-identity', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'expected-call', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: { location, stepId: 'expected-step', toolCalls: [{ toolUseId: 'expected-call', name: 'read_file', args: { path: 'a.txt' } }] } }
      },
      {
        ...event('finished-identity', 2), kind: 'tool-call-finished',
        payload: { toolCallId: 'other-call', sessionLedger: { location, stepId: 'other-step', result: { success: true, data: 'foreign result' } } }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'other-call')
    conn.close()
  })

  it('rejects a tool result sidecar that differs from the canonical completion result', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/result-drift', sessionId: 'session-result-drift', createdAt: 1000 }
    const repairToolLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('proposal-result-drift', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-result-drift', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: { location, stepId: 'result-drift-step', toolCalls: [{ toolUseId: 'call-result-drift', name: 'read_file', args: { path: 'a.txt' } }] } }
      },
      {
        ...event('finished-result-drift', 2), kind: 'tool-call-finished',
        payload: {
          toolCallId: 'call-result-drift', result: { success: true, data: 'canonical contents' },
          sessionLedger: { location, stepId: 'result-drift-step', result: { success: true, data: 'different contents' } }
        }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'call-result-drift')
    conn.close()
  })

  it('rejects an orphan tool result when canonical model responses declare no tool calls', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/orphan-tool-result', sessionId: 'session-orphan-result', createdAt: 1000 }
    const repairToolLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([
      { ...event('response-without-tools', 1), kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'done' } } },
      { ...event('orphan-result', 2), kind: 'tool-call-finished', payload: { toolCallId: 'orphan-call', sessionLedger: {
        location, stepId: 'orphan-step', result: { success: true, data: 'unrequested result' }
      } } }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'orphan-call')
    conn.close()
  })

  it('rejects a tool proposal sidecar whose call id is absent from the canonical response', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/cross-tool-proposal', sessionId: 'session-proposal-owner', createdAt: 1000 }
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([{
      ...event('proposal-sidecar-identity', 1), kind: 'model-response-committed',
      payload: { message: { role: 'assistant', toolCalls: [{ id: 'canonical-call', name: 'read_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'request:model:1', toolCalls: [{ toolUseId: 'foreign-call', name: 'read_file', args: { path: 'secret.txt' } }] } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolCallLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'foreign-call')
    conn.close()
  })

  it('does not project later tool results after an earlier proposal projection fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-order', sessionId: 'session-order', createdAt: 1000 }
    await history.appendBatch([
      {
        ...event('response-order', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-order', name: 'read_file', input: { path: '/tmp/a.txt' } }] },
          sessionLedger: { location, stepId: 'request-order:model:1', toolCalls: [{ toolUseId: 'call-order', name: 'read_file', args: { path: '/tmp/a.txt' } }] } }
      },
      {
        ...event('finished-order', 2), kind: 'tool-call-finished',
        payload: { toolCallId: 'call-order', result: { success: true, data: 'contents' }, sessionLedger: { location, stepId: 'request-order:model:1', result: { success: true, data: 'contents' } } }
      }
    ], 0)
    let failProposalOnce = true
    const repairOrder: string[] = []
    const repairProposal = vi.fn(async () => {
      if (failProposalOnce) {
        failProposalOnce = false
        throw new Error('injected proposal JSONL failure')
      }
      repairOrder.push('tool_call')
    })
    const repairResult = vi.fn(async () => { repairOrder.push('tool_result') })
    const onRepairError = vi.fn()

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: repairProposal,
      repairToolLedger: repairResult,
      onToolLedgerRepairError: onRepairError
    })

    expect(repairProposal).toHaveBeenCalledOnce()
    expect(repairResult).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'call-order')

    await history.recoverInterruptedInvocations({ repairToolCallLedger: repairProposal, repairToolLedger: repairResult })
    expect(repairProposal).toHaveBeenCalledTimes(2)
    expect(repairResult).toHaveBeenCalledOnce()
    expect(repairOrder).toEqual(['tool_call', 'tool_result'])
    conn.close()
  })

  it('continues recovery for an independent session ledger after another ledger projection fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const firstLocation = { workDir: '/tmp/recovery-first', sessionId: 'session-first', createdAt: 1000 }
    const secondLocation = { workDir: '/tmp/recovery-second', sessionId: 'session-second', createdAt: 2000 }
    await history.appendBatch([
      {
        ...event('response-first', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-first', name: 'read_file', input: { path: '/tmp/a.txt' } }] },
          sessionLedger: { location: firstLocation, stepId: 'step-first', toolCalls: [{ toolUseId: 'call-first', name: 'read_file', args: { path: '/tmp/a.txt' } }] } }
      },
      {
        ...event('finished-first', 2), kind: 'tool-call-finished',
        payload: { toolCallId: 'call-first', result: { success: true, data: 'first' }, sessionLedger: { location: firstLocation, stepId: 'step-first', result: { success: true, data: 'first' } } }
      },
      {
        ...event('response-second', 3), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-second', name: 'read_file', input: { path: '/tmp/b.txt' } }] },
          sessionLedger: { location: secondLocation, stepId: 'step-second', toolCalls: [{ toolUseId: 'call-second', name: 'read_file', args: { path: '/tmp/b.txt' } }] } }
      },
      {
        ...event('finished-second', 4), kind: 'tool-call-finished',
        payload: { toolCallId: 'call-second', result: { success: true, data: 'second' }, sessionLedger: { location: secondLocation, stepId: 'step-second', result: { success: true, data: 'second' } } }
      }
    ], 0)
    const repaired: string[] = []
    const repairProposal = vi.fn(async (location: { sessionId: string }, call: { toolUseId: string }) => {
      if (location.sessionId === firstLocation.sessionId) throw new Error('first ledger is unavailable')
      repaired.push(`${call.toolUseId}:tool_call`)
    })
    const repairResult = vi.fn(async (location: { sessionId: string }, result: { toolUseId: string }) => {
      if (location.sessionId === firstLocation.sessionId) throw new Error('first ledger is unavailable')
      repaired.push(`${result.toolUseId}:tool_result`)
    })
    const onRepairError = vi.fn()

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: repairProposal,
      repairToolLedger: repairResult,
      onToolLedgerRepairError: onRepairError
    })

    expect(repairProposal).toHaveBeenCalledTimes(2)
    expect(repairResult).toHaveBeenCalledTimes(1)
    expect(repaired).toEqual(['call-second:tool_call', 'call-second:tool_result'])
    expect(onRepairError).toHaveBeenCalledTimes(1)
    conn.close()
  })

  it('recovers a tool result when the JSONL sink fails after canonical History commit', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-outbox-recovery-'))
    const location = { workDir: root, sessionId: 'session-outbox', createdAt: 1000 }
    await fs.writeFile(path.join(root, 'sessions'), 'block session directory creation')
    const result = { success: true, data: { content: 'committed output' }, auditRef: 'audit:tc-outbox' }
    await history.appendBatch([{
      ...event('tool-finished-outbox', 1),
      kind: 'tool-call-finished',
      payload: { toolCallId: 'tc-outbox', isError: false, result, auditRef: result.auditRef, sessionLedger: { location, stepId: 'req-outbox', result } }
    }], 0)

    const failedSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await expect(failedSink.appendCritical({ type: 'tool_result', payload: { toolUseId: 'tc-outbox', stepId: 'req-outbox', result } })).rejects.toThrow()
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [{ kind: 'tool-call-finished' }] })
    await expect(failedSink.close()).rejects.toThrow()
    await fs.rm(path.join(root, 'sessions'))

    const recoveredSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await history.recoverInterruptedInvocations({
      repairToolLedger: (_location, repairEvent) => ensureToolResultEvent(recoveredSink, repairEvent as never)
    })
    await expect(readSessionEvents(recoveredSink.eventsPath)).resolves.toMatchObject([
      { type: 'tool_result', payload: { toolUseId: 'tc-outbox', stepId: 'req-outbox', result } }
    ])
    await recoveredSink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('persists ordered invocation events and replays idempotently after adapter recreation', async () => {
    const conn = createDb()
    const first = new SqliteAgentHistory(conn, 1, () => 123)
    const events = [event('e1', 1), event('e2', 2)]
    await expect(first.appendBatch(events, 0)).resolves.toEqual({ version: 2, duplicate: false })

    const reopened = new SqliteAgentHistory(conn)
    await expect(reopened.read('inv-1')).resolves.toEqual({ invocationId: 'inv-1', version: 2, schemaVersion: 1, events })
    await expect(reopened.appendBatch(events, 0)).resolves.toEqual({ version: 2, duplicate: true })
    conn.close()
  })

  it('refuses new History facts after an invocation terminal event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{ ...event('history-terminal', 1), kind: 'invocation-completed', payload: { status: 'completed' } }], 0)

    await expect(history.appendBatch([{
      ...event('history-after-terminal', 2), kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'late write' } }
    }], 1)).rejects.toThrow(/terminal invocation event/)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ eventId: 'history-terminal' })] })
    conn.close()
  })

  it('treats persisted events after a terminal as History corruption', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([
      { ...event('before-terminal', 1), kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'done' } } },
      { ...event('after-terminal', 2), kind: 'approval-updated', payload: { status: 'late' } }
    ], 0)
    conn.prepare('UPDATE agent_history_events SET kind = ? WHERE invocation_id = ? AND sequence = ?').run('invocation-completed', 'inv-1', 1)

    await expect(history.read('inv-1')).rejects.toMatchObject({ code: 'history-corrupt' })
    conn.close()
  })

  it('rolls back the whole batch if any event insert fails', async () => {
    const conn = createDb()
    conn.exec(`CREATE TRIGGER reject_second_history_event BEFORE INSERT ON agent_history_events
      WHEN NEW.event_id = 'e2' BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`)
    const history = new SqliteAgentHistory(conn)
    await expect(history.appendBatch([event('e1', 1), event('e2', 2)], 0)).rejects.toThrow('injected history failure')
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })
    expect((conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events').get() as { count: number }).count).toBe(0)
    conn.close()
  })

  it('isolates versions by invocation and rejects stale writers', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('e1', 1)], 0)
    const other = { ...event('e2', 1), invocationId: 'inv-2', turnId: 'turn-2' }
    await expect(history.appendBatch([other], 0)).resolves.toEqual({ version: 1, duplicate: false })
    await expect(history.appendBatch([{ ...event('e2', 2) }], 0)).rejects.toMatchObject({ code: 'version-conflict' })
    conn.close()
  })

  it('rejects changing turn ownership within one invocation stream', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('turn-owner', 1)], 0)

    await expect(history.appendBatch([{ ...event('wrong-turn', 2), turnId: 'another-turn' }], 1))
      .rejects.toThrow(/invocation.*turn/i)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ turnId: 'turn-1' })] })
    conn.close()
  })

  it('reports a persisted stream with multiple turn owners as History corruption', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('turn-one', 1), event('turn-two', 2)], 0)
    conn.prepare('UPDATE agent_history_events SET turn_id = ? WHERE invocation_id = ? AND sequence = ?').run('another-turn', 'inv-1', 2)

    await expect(history.read('inv-1')).rejects.toMatchObject({ code: 'history-corrupt' })
    conn.close()
  })

  it('refuses completed tool reconstruction when terminal and result success facts conflict', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-tool-result-conflict')
    await history.appendBatch([
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 1, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] } } },
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 2, schemaVersion: 1, eventId: 'started', idempotencyKey: 'started', kind: 'tool-call-started', payload: { toolCallId: 'call-1', toolName: 'read_file', inputHash: 'a'.repeat(64) } },
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 3, schemaVersion: 1, eventId: 'finished', idempotencyKey: 'finished', kind: 'tool-call-finished', payload: { toolCallId: 'call-1', success: true, result: { success: false, error: 'contradictory result' } } },
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 4, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'done' } }
    ], 0)

    expect(history.readCompletedToolCallsForSession('tool-result-conflict', 'session-tool-result-conflict', 'turn-conflict')).toBeUndefined()
    conn.close()
  })

  it('rejects a repeated event id with a new idempotency key', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('same-id', 1)], 0)
    await expect(history.appendBatch([{ ...event('same-id', 2), idempotencyKey: 'other-key' }], 1)).rejects.toMatchObject({ code: 'idempotency-conflict' })
    conn.close()
  })

  it('refuses to rebuild when persisted version metadata no longer matches canonical events', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('e1', 1), event('e2', 2)], 0)
    conn.prepare('DELETE FROM agent_history_events WHERE invocation_id = ? AND sequence = ?').run('inv-1', 1)
    await expect(history.read('inv-1')).rejects.toMatchObject({ code: 'history-corrupt' })
    conn.close()
  })

  it('blocks recovery when a tool result is bound to a different model-response step', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-cross-step', createdAt: 1000 }
    const proposalStepId = 'inv-1:model:1'
    const repairToolCallLedger = vi.fn(async () => undefined)
    const repairToolLedger = vi.fn(async () => undefined)
    const repairError = vi.fn()
    await history.appendBatch([
      {
        ...event('cross-step-response', 1), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: 'step-call', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: { location, stepId: proposalStepId, toolCalls: [{ toolUseId: 'step-call', name: 'read_file', args: { path: 'a.txt' } }] } }
      },
      { ...event('cross-step-start', 2), kind: 'tool-call-started', payload: { toolCallId: 'step-call', toolName: 'read_file' } },
      { ...event('cross-step-finish', 3), kind: 'tool-call-finished', payload: {
        toolCallId: 'step-call', success: true,
        sessionLedger: { location, stepId: 'another-invocation-step', result: { success: true, data: 'contents' } }
      } }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolCallLedger, repairToolLedger, onToolLedgerRepairError: repairError })

    expect(repairToolCallLedger).toHaveBeenCalledOnce()
    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(repairError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/step identity/i) }), 'inv-1', 'step-call')
    conn.close()
  })

  it('closes pending dispatches as interrupted on restart and does not append twice', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{ ...event('e1', 1), payload: { toolCallId: 'tc-1' } }], 0)

    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
      { invocationId: 'inv-1', state: 'interrupted' }
    ])
    const snapshot = await history.read('inv-1')
    expect(snapshot.events.at(-1)).toMatchObject({
      kind: 'invocation-interrupted',
      payload: { status: 'interrupted', reason: 'process-restart' }
    })
    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
      { invocationId: 'inv-1', state: 'interrupted' }
    ])
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 2 })
    conn.close()
  })

  it('keeps a restarted dispatched invocation fenced from provider replay', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-dispatch-restart-'))
    const dbPath = path.join(root, 'history.db')
    let conn = createDb(dbPath)
    try {
      const history = new SqliteAgentHistory(conn)
      await history.appendBatch([{
        ...event('restart-dispatched-tool', 1),
        kind: 'tool-call-started',
        payload: { toolCallId: 'already-dispatched', toolName: 'write_file' }
      }], 0)
      await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
        { invocationId: 'inv-1', state: 'interrupted' }
      ])
      conn.close()

      conn = createDb(dbPath)
      const reopenedHistory = new SqliteAgentHistory(conn)
      const registry = new ModelProviderRegistry()
      const providerStream = vi.fn(async function* () {
        yield { type: 'text-delta' as const, text: 'must not replay' }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' as const }
      })
      registry.register({ routeId: 'restart-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
        providerId: 'restart-provider', stream: providerStream
      })
      const permits = new InMemorySafetyPermitStore()
      const capabilities = new CapabilityRegistry()
      await expect(runAgentTurn({
        registry, routeId: 'restart-route', invocationId: 'inv-1', turnId: 'turn-1',
        request: { messages: [{ role: 'user', content: 'resume' }], maxTokens: 20 },
        safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
        prepareTool: vi.fn(),
        toolExecution: createPermitBoundToolExecutionPort({
          permits, admission: new InMemoryExecutionAdmissionCoordinator(),
          resolveExpected: async () => { throw new Error('provider replay must not reach tool execution') },
          execute: async () => ({ output: null })
        }),
        maxModelTurns: 1, history: reopenedHistory
      })).rejects.toThrow('History invocation is already terminal')
      expect(providerStream).not.toHaveBeenCalled()
      const recovered = await reopenedHistory.read('inv-1')
      expect(recovered.version).toBe(2)
      expect(recovered.events[0]).toMatchObject({ kind: 'tool-call-started', payload: { toolCallId: 'already-dispatched' } })
      expect(recovered.events[1]).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })
    } finally {
      conn.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a restarted committed tool proposal fenced before approval or dispatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-proposal-restart-'))
    const dbPath = path.join(root, 'history.db')
    let conn = createDb(dbPath)
    try {
      const history = new SqliteAgentHistory(conn)
      await history.appendBatch([{
        ...event('restart-proposed-tool', 1),
        kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'not-yet-approved', name: 'write_file', input: { path: 'draft.txt' } }] } }
      }], 0)
      await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
        { invocationId: 'inv-1', state: 'interrupted' }
      ])
      conn.close()

      conn = createDb(dbPath)
      const reopenedHistory = new SqliteAgentHistory(conn)
      const registry = new ModelProviderRegistry()
      const providerStream = vi.fn(async function* () {
        yield { type: 'text-delta' as const, text: 'must not replay' }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' as const }
      })
      registry.register({ routeId: 'proposal-restart-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
        providerId: 'proposal-restart-provider', stream: providerStream
      })
      const permits = new InMemorySafetyPermitStore()
      await expect(runAgentTurn({
        registry, routeId: 'proposal-restart-route', invocationId: 'inv-1', turnId: 'turn-1',
        request: { messages: [{ role: 'user', content: 'resume' }], maxTokens: 20 },
        safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
        prepareTool: vi.fn(),
        toolExecution: createPermitBoundToolExecutionPort({
          permits, admission: new InMemoryExecutionAdmissionCoordinator(),
          resolveExpected: async () => { throw new Error('provider replay must not reach tool execution') },
          execute: async () => ({ output: null })
        }),
        maxModelTurns: 1, history: reopenedHistory
      })).rejects.toThrow('History invocation is already terminal')
      expect(providerStream).not.toHaveBeenCalled()
      const recovered = await reopenedHistory.read('inv-1')
      expect(recovered.version).toBe(2)
      expect(recovered.events[0]).toMatchObject({ kind: 'model-response-committed', payload: { message: { toolCalls: [{ id: 'not-yet-approved' }] } } })
      expect(recovered.events[1]).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })
    } finally {
      conn.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('projects a restart interruption to turn_end from its canonical request ledger', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-restart-terminal', createdAt: 1000 }
    await history.appendBatch([{
      ...event('restart-request', 1), kind: 'model-request-started',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1,
        sessionLedger: { location, requestHeader: { requestId: 'inv-1:round:1', attempt: 1 }, requestContext: { requestId: 'inv-1:round:1', attempt: 1 } } }
    }], 0)
    let failTerminalRepair = true
    const repairInvocationTerminal = vi.fn(async () => {
      if (failTerminalRepair) {
        failTerminalRepair = false
        throw new Error('injected restart turn_end write failure')
      }
    })
    const onInvocationTerminalRepairError = vi.fn()

    const recoveryOptions = { repairInvocationTerminal, onInvocationTerminalRepairError }
    await expect(history.recoverInterruptedInvocations(recoveryOptions)).resolves.toMatchObject([{ state: 'interrupted' }])

    expect(repairInvocationTerminal).toHaveBeenNthCalledWith(1, location, {
      status: 'interrupted', turnId: 'turn-1', reason: 'interrupted'
    })
    expect(onInvocationTerminalRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'turn-1')
    await expect(history.recoverInterruptedInvocations(recoveryOptions)).resolves.toMatchObject([{ state: 'interrupted' }])
    expect(repairInvocationTerminal).toHaveBeenCalledTimes(2)
    await expect(history.read('inv-1')).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'invocation-interrupted', payload: {
        status: 'interrupted', reason: 'process-restart', sessionLedger: { location, turnId: 'turn-1', reason: 'interrupted' }
      } })])
    })
    conn.close()
  })

  it('resolves a restart terminal owner from the atomic accepted-input marker before invocation context exists', async () => {
    const conn = createDb()
    const sessionId = 'session-accepted-before-context'
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const location = { workDir: '/workspace', sessionId, createdAt: 1000 }
    await history.appendBatch([{
      ...event('accepted-input-only', 1),
      kind: 'session-input-committed',
      payload: { sessionId, messageId: 'user-accepted', role: 'user', inputFingerprint: 'a'.repeat(64) }
    }], 0)
    const resolveSessionLedgerLocation = vi.fn(async (ownerSessionId: string) => ownerSessionId === sessionId ? location : undefined)
    let failRepair = true
    const repairInvocationTerminal = vi.fn(async () => {
      if (failRepair) { failRepair = false; throw new Error('injected accepted-input terminal repair failure') }
    })
    const onInvocationTerminalRepairError = vi.fn()

    const recoveryOptions = { resolveSessionLedgerLocation, repairInvocationTerminal, onInvocationTerminalRepairError }
    await history.recoverInterruptedInvocations(recoveryOptions)
    await history.recoverInterruptedInvocations(recoveryOptions)

    expect(resolveSessionLedgerLocation).toHaveBeenCalledWith(sessionId)
    expect(resolveSessionLedgerLocation).toHaveBeenCalledOnce()
    expect(repairInvocationTerminal).toHaveBeenCalledTimes(2)
    expect(onInvocationTerminalRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'turn-1')
    expect(repairInvocationTerminal).toHaveBeenCalledWith(location, { status: 'interrupted', turnId: 'turn-1', reason: 'interrupted' })
    await expect(history.read('inv-1')).resolves.toMatchObject({ events: [
      expect.objectContaining({ kind: 'session-input-committed', sequence: 1 }),
      expect.objectContaining({ kind: 'invocation-interrupted', payload: {
        status: 'interrupted', reason: 'process-restart',
        sessionLedger: { location, turnId: 'turn-1', reason: 'interrupted' }
      } })
    ] })
    conn.close()
  })

  it('does not resolve a restart owner from a malformed or cross-session accepted-input marker', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-stream-owner')
    await history.appendBatch([{
      ...event('accepted-input-invalid-owner', 1),
      kind: 'session-input-committed',
      payload: { sessionId: 'session-other', messageId: 'user-accepted', role: 'user', inputFingerprint: 'not-a-fingerprint' }
    }], 0)
    const resolveSessionLedgerLocation = vi.fn(() => ({ workDir: '/workspace', sessionId: 'session-other', createdAt: 1000 }))
    const repairInvocationTerminal = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ resolveSessionLedgerLocation, repairInvocationTerminal })

    expect(resolveSessionLedgerLocation).not.toHaveBeenCalled()
    expect(repairInvocationTerminal).not.toHaveBeenCalled()
    await expect(history.read('inv-1')).resolves.toMatchObject({ events: [
      expect.objectContaining({ kind: 'session-input-committed', sequence: 1 }),
      expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })
    ] })
    conn.close()
  })

  it('does not guess a restart terminal location when canonical sidecars disagree', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const firstLocation = { workDir: '/workspace', sessionId: 'session-a', createdAt: 1000 }
    const secondLocation = { workDir: '/workspace', sessionId: 'session-b', createdAt: 1000 }
    await history.appendBatch([
      { ...event('restart-request-a', 1), kind: 'model-request-started', payload: {
        requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1,
        sessionLedger: { location: firstLocation, requestHeader: { requestId: 'inv-1:round:1', attempt: 1 }, requestContext: { requestId: 'inv-1:round:1', attempt: 1 } }
      } },
      { ...event('restart-request-b', 2), kind: 'model-request-started', payload: {
        requestId: 'inv-1:round:2', modelTurn: 2, attempt: 1,
        sessionLedger: { location: secondLocation, requestHeader: { requestId: 'inv-1:round:2', attempt: 1 }, requestContext: { requestId: 'inv-1:round:2', attempt: 1 } }
      } }
    ], 0)
    const repairInvocationTerminal = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).not.toHaveBeenCalled()
    await expect(history.read('inv-1')).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })])
    })
    conn.close()
  })

  it('closes a committed model request as interrupted on restart instead of resuming it', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('request-started-restart', 1), kind: 'model-request-started',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1', requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } } }
    }], 0)

    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([{ invocationId: 'inv-1', state: 'interrupted' }])
    const snapshot = await history.read('inv-1')
    expect(snapshot.events.map(({ kind }) => kind)).toEqual(['model-request-started', 'invocation-interrupted'])
    conn.close()
  })

  it('repairs missing request header and context session events from canonical request History', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-request-repair-'))
    const location = { workDir: root, sessionId: 'session-request-repair', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const requestHeader = { route: 'anthropic.messages.stream', requestId: 'inv-1:round:1', attempt: 1, system: 'safe system', messages: [] }
    const requestContext = { requestId: 'inv-1:round:1', attempt: 1, provider: 'anthropic', model: 'test-model' }
    const repairModelRequestLedger = vi.fn(async (repairLocation, ledger) => {
      expect(repairLocation).toEqual(location)
      await ensureRequestProjectionEvents(sink, ledger as never)
    })
    await history.appendBatch([{
      ...event('request-started-sidecars', 1), kind: 'model-request-started',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1',
        requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
        sessionLedger: { location, requestHeader, requestContext } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger })
    await history.recoverInterruptedInvocations({ repairModelRequestLedger })

    expect(repairModelRequestLedger).toHaveBeenCalledTimes(2)
    expect(repairModelRequestLedger).toHaveBeenCalledWith(location, { requestHeader, requestContext })
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'request_header', payload: requestHeader }, { type: 'request_context', payload: requestContext }
    ])
    expect(await readSessionEvents(sink.eventsPath)).toHaveLength(2)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs final usage-anchored request context from the committed model response outbox', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context', createdAt: 1000 }
    const requestContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 55 } }
    await history.appendBatch([{
      ...event('response-final-context', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] },
        sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } }, requestContext } }
    }], 0)
    const repairUsageLedger = vi.fn(async () => undefined)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairUsageLedger, repairFinalRequestContextLedger })

    expect(repairFinalRequestContextLedger).toHaveBeenCalledOnce()
    expect(repairFinalRequestContextLedger).toHaveBeenCalledWith(location, requestContext)
    conn.close()
  })

  it('repairs final response context even when its usage ledger is absent', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context-without-usage', createdAt: 1000 }
    const requestContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 55 } }
    await history.appendBatch([{
      ...event('response-final-context-without-usage', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: { location, requestContext } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairFinalRequestContextLedger })

    expect(repairFinalRequestContextLedger).toHaveBeenCalledWith(location, requestContext)
    conn.close()
  })

  it('repairs output truncation tool result and retry projections from canonical History sidecars', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-output-recovery-'))
    const location = { workDir: root, sessionId: 'session-output-recovery', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const toolCallId = 'partial-call'
    const requestRetry = { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'model_output_token_limit' }
    const toolResult = { success: false, error: 'model_output_token_limit', userMessage: 'tool proposal truncated', notExecuted: true, notExecutedReason: 'model_output_truncated' }
    await history.appendBatch([
      { ...event('output-response', 1), kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: toolCallId, name: 'write_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'inv-1', toolCalls: [{ toolUseId: toolCallId, name: 'write_file', args: { path: 'a.txt' } }] }
      } },
      { ...event('output-not-dispatched', 2), kind: 'tool-call-not-dispatched', payload: {
        toolCallId, reason: 'MODEL_OUTPUT_TRUNCATED', replayContent: 'tool proposal truncated', isError: true,
        sessionLedger: { location, stepId: 'inv-1', result: toolResult }
      } },
      { ...event('output-retry-scheduled', 3), kind: 'provider-retry-scheduled', payload: {
        requestId: requestRetry.requestId, modelTurn: 1, routeId: 'route-1', retryAttempt: 1, code: requestRetry.code, backoffMs: 0,
        sessionLedger: { location, requestRetry }
      } }
    ], 0)
    const repairToolLedger = vi.fn(async (_location, result) => { await ensureToolResultEvent(sink, result as never) })
    const repairProviderRetryLedger = vi.fn(async (_location, retry) => { await ensureRequestRetryEvent(sink, retry) })

    await history.recoverInterruptedInvocations({ repairToolLedger, repairProviderRetryLedger })
    await history.recoverInterruptedInvocations({ repairToolLedger, repairProviderRetryLedger })

    expect(repairToolLedger).toHaveBeenCalledWith(location, { toolUseId: toolCallId, turnId: 'turn-1', stepId: 'inv-1', result: toolResult })
    expect(repairProviderRetryLedger).toHaveBeenCalledWith(location, requestRetry)
    const projected = await readSessionEvents(sink.eventsPath)
    expect(projected.map(({ type }) => type)).toEqual(['tool_result', 'request_retry'])
    expect(projected[0]?.payload).toMatchObject({ toolUseId: toolCallId, turnId: 'turn-1', stepId: 'inv-1', result: toolResult })
    expect(projected[1]?.payload).toEqual(requestRetry)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs revoked not-dispatched tool result projection from canonical History sidecars', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-revoked-recovery-'))
    const location = { workDir: root, sessionId: 'session-revoked-recovery', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const toolCallId = 'revoked-call'
    const result = { success: false, data: 'Tool call was not dispatched (REVOKED).' }
    await history.appendBatch([
      { ...event('revoked-response', 1), kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: toolCallId, name: 'read_file', input: { path: 'note.txt' } }] },
        sessionLedger: { location, stepId: 'invocation-revoked', toolCalls: [{ toolUseId: toolCallId, name: 'read_file', args: { path: 'note.txt' } }] }
      } },
      { ...event('revoked-not-dispatched', 2), kind: 'tool-call-not-dispatched', payload: {
        toolCallId, reason: 'REVOKED', replayContent: result.data, isError: true,
        sessionLedger: { location, stepId: 'invocation-revoked', result }
      } }
    ], 0)
    const repairToolCallLedger = vi.fn(async (_location, proposal) => { await ensureToolCallEvent(sink, proposal as never) })
    const repairToolLedger = vi.fn(async (_location, projected) => { await ensureToolResultEvent(sink, projected as never) })

    await history.recoverInterruptedInvocations({ repairToolCallLedger, repairToolLedger })
    await history.recoverInterruptedInvocations({ repairToolCallLedger, repairToolLedger })

    expect(repairToolLedger).toHaveBeenCalledWith(location, { toolUseId: toolCallId, turnId: 'turn-1', stepId: 'invocation-revoked', result })
    const projected = await readSessionEvents(sink.eventsPath)
    expect(projected.map(({ type }) => type)).toEqual(['tool_call', 'tool_result'])
    expect(projected[1]?.payload).toMatchObject({ toolUseId: toolCallId, turnId: 'turn-1', stepId: 'invocation-revoked', result })
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('blocks output recovery sidecars when the truncated tool ID is absent from canonical proposals', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-output-recovery-forged', createdAt: 1000 }
    await history.appendBatch([
      { ...event('output-forged-response', 1), kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: 'canonical-call', name: 'write_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'inv-1', toolCalls: [{ toolUseId: 'canonical-call', name: 'write_file', args: { path: 'a.txt' } }] }
      } },
      { ...event('output-forged-not-dispatched', 2), kind: 'tool-call-not-dispatched', payload: {
        toolCallId: 'forged-call', reason: 'MODEL_OUTPUT_TRUNCATED', replayContent: 'not executed', isError: true,
        sessionLedger: { location, stepId: 'inv-1', result: { success: false, notExecuted: true, notExecutedReason: 'model_output_truncated' } }
      } },
      { ...event('output-forged-retry', 3), kind: 'provider-retry-scheduled', payload: {
        requestId: 'inv-1:round:1', modelTurn: 1, routeId: 'route-1', retryAttempt: 1, code: 'model_output_token_limit', backoffMs: 0,
        sessionLedger: { location, requestRetry: { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'model_output_token_limit' } }
      } }
    ], 0)
    const repairToolLedger = vi.fn(async () => undefined)
    const repairProviderRetryLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()
    const onModelRequestLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolLedger, repairProviderRetryLedger, onToolLedgerRepairError, onModelRequestLedgerRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(repairProviderRetryLedger).not.toHaveBeenCalled()
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'forged-call')
    expect(onModelRequestLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('does not repair final response context when its usage ledger repair fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context-usage-failed', createdAt: 1000 }
    const requestContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 55 } }
    await history.appendBatch([{
      ...event('response-final-context-usage-failed', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: {
        location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } }, requestContext
      } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({
      repairUsageLedger: async () => { throw new Error('usage projection failed') },
      repairFinalRequestContextLedger
    })

    expect(repairFinalRequestContextLedger).not.toHaveBeenCalled()
    expect(conn.prepare('SELECT status, attempts FROM canonical_projection_repairs WHERE repair_id=?').get('inv-1:invocation-projections:response-final-context-usage-failed')).toEqual({ status: 'pending', attempts: 1 })
    conn.close()
  })

  it('rejects final request-context sidecars with a nonpositive attempt or array usage', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-invalid-final-context', createdAt: 1000 }
    await history.appendBatch([{
      ...event('response-invalid-final-context', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: {
        location, requestContext: { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 0, contextUsage: [] }
      } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)
    const onModelRequestLedgerRepairError = vi.fn()
    const onFinalRequestContextLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairFinalRequestContextLedger, onFinalRequestContextLedgerRepairError })

    expect(repairFinalRequestContextLedger).not.toHaveBeenCalled()
    expect(onFinalRequestContextLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'inv-1:round:1')
    expect(onModelRequestLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('diagnoses a non-object final context sidecar', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context-missing-usage', createdAt: 1000 }
    await history.appendBatch([{
      ...event('response-final-context-missing-usage', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: {
        location, requestContext: null
      } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)
    const onModelRequestLedgerRepairError = vi.fn()
    const onFinalRequestContextLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairFinalRequestContextLedger, onFinalRequestContextLedgerRepairError })

    expect(repairFinalRequestContextLedger).not.toHaveBeenCalled()
    expect(onFinalRequestContextLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'inv-1:round:1')
    expect(onModelRequestLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('diagnoses malformed tool proposal sidecars and blocks later repair for that session only', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const badLocation = { workDir: '/workspace', sessionId: 'bad-proposal-sidecar', createdAt: 1000 }
    const goodLocation = { workDir: '/workspace', sessionId: 'good-proposal-sidecar', createdAt: 1000 }
    const response = (id: string, location: typeof badLocation, args: unknown) => ({
      ...event(id, 1), kind: 'model-response-committed' as const,
      payload: { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: `${id}-tool`, name: 'read_file', input: Array.isArray(args) ? {} : args }] }, sessionLedger: {
        location, stepId: id, toolCalls: [{ toolUseId: `${id}-tool`, name: 'read_file', args }]
      } }
    })
    await history.appendBatch([response('bad-sidecar-response', badLocation, [])], 0)
    await history.appendBatch([{ ...response('good-sidecar-response', goodLocation, { path: '/ok' }), sequence: 2 }], 1)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).toHaveBeenCalledTimes(1)
    expect(repairToolCallLedger).toHaveBeenCalledWith(goodLocation, expect.objectContaining({ toolUseId: 'good-sidecar-response-tool' }))
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'bad-sidecar-response-tool')
    conn.close()
  })

  it('diagnoses malformed tool result sidecars and blocks later repair for that session only', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const badLocation = { workDir: '/workspace', sessionId: 'bad-result-sidecar', createdAt: 1000 }
    const goodLocation = { workDir: '/workspace', sessionId: 'good-result-sidecar', createdAt: 1000 }
    const proposal = (id: string, location: typeof badLocation) => ({
      ...event(`${id}-response`, 1), kind: 'model-response-committed' as const,
      payload: { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: `${id}-tool`, name: 'read_file', input: { path: '/ok' } }] }, sessionLedger: {
        location, stepId: id, toolCalls: [{ toolUseId: `${id}-tool`, name: 'read_file', args: { path: '/ok' } }]
      } }
    })
    const result = (id: string, location: typeof badLocation, sidecarResult: unknown, sequence: number) => ({
      ...event(`${id}-result`, sequence), kind: 'tool-call-finished' as const,
      payload: { toolCallId: `${id}-tool`, result: sidecarResult, sessionLedger: { location, stepId: id, result: sidecarResult } }
    })
    await history.appendBatch([proposal('bad', badLocation)], 0)
    await history.appendBatch([result('bad', badLocation, [], 2)], 1)
    await history.appendBatch([{ ...proposal('good', goodLocation), sequence: 3 }], 2)
    await history.appendBatch([result('good', goodLocation, { success: true }, 4)], 3)
    const repairToolLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError })

    expect(repairToolLedger).toHaveBeenCalledTimes(1)
    expect(repairToolLedger).toHaveBeenCalledWith(goodLocation, { toolUseId: 'good-tool', turnId: 'turn-1', stepId: 'good', result: { success: true } })
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'bad-tool')
    conn.close()
  })

  it('fails closed when a canonical session identity would escape the configured workspace during recovery', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-escaped-session-'))
    const escapedSessionId = `../../${path.basename(root)}-escape`
    const location = { workDir: root, sessionId: escapedSessionId, createdAt: 1000 }
    const outsideDirectory = path.resolve(root, 'sessions', `${escapedSessionId}-19700101`)
    await history.appendBatch([{
      ...event('escaped-session-proposal', 1), kind: 'model-response-committed',
      payload: {
        modelTurn: 1,
        message: { role: 'assistant', toolCalls: [{ id: 'escaped-tool', name: 'read_file', input: { path: 'note.txt' } }] },
        sessionLedger: { location, stepId: 'inv-1:model:1', toolCalls: [{ toolUseId: 'escaped-tool', name: 'read_file', args: { path: 'note.txt' } }] }
      }
    }], 0)
    const repairErrors: unknown[] = []

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: async (repairLocation, proposal) => {
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureToolCallEvent(sink, proposal as never) }
        finally { await sink.close() }
      },
      onToolLedgerRepairError: (error) => repairErrors.push(error)
    })

    expect(repairErrors).toHaveLength(1)
    expect(repairErrors[0]).toMatchObject({ message: expect.stringMatching(/escapes sessions root/i) })
    await expect(fs.access(outsideDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('blocks a tool-call recovery sidecar whose name or args differ from the canonical model proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-proposal-binding', sessionId: 'session-proposal-binding', createdAt: 1000 }
    await history.appendBatch([{
      ...event('proposal-binding-response', 1), kind: 'model-response-committed', payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'proposal-binding-call', name: 'read_file', input: { path: 'canonical.txt' } }] },
        sessionLedger: { location, stepId: 'proposal-binding-step', toolCalls: [{ toolUseId: 'proposal-binding-call', name: 'read_file', args: { path: 'forged.txt' } }] }
      }
    }], 0)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).not.toHaveBeenCalled()
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'proposal-binding-call')
    conn.close()
  })

  it('accepts the canonical redacted toolkit.call proposal projection during recovery', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-toolkit-binding', sessionId: 'session-toolkit-binding', createdAt: 1000 }
    await history.appendBatch([{
      ...event('toolkit-binding-response', 1), kind: 'model-response-committed', payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'toolkit-binding-call', name: 'toolkit.call', input: { capabilityId: 'auth.set', params: { apiKey: 'private-value', region: 'test' } } }] },
        sessionLedger: { location, stepId: 'toolkit-binding-step', toolCalls: [{ toolUseId: 'toolkit-binding-call', name: 'toolkit_call', args: { capabilityId: 'auth.set', params: { apiKey: true, region: 'test' } } }] }
      }
    }], 0)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).toHaveBeenCalledWith(location, expect.objectContaining({ toolUseId: 'toolkit-binding-call', name: 'toolkit_call' }))
    expect(onToolLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('blocks a tool-call recovery sidecar whose name differs from the canonical proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-name-binding', sessionId: 'session-name-binding', createdAt: 1000 }
    await history.appendBatch([{
      ...event('name-binding-response', 1), kind: 'model-response-committed', payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'name-binding-call', name: 'read_file', input: { path: 'note.txt' } }] },
        sessionLedger: { location, stepId: 'name-binding-step', toolCalls: [{ toolUseId: 'name-binding-call', name: 'write_file', args: { path: 'note.txt' } }] }
      }
    }], 0)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).not.toHaveBeenCalled()
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'name-binding-call')
    conn.close()
  })

  it('repairs a missing final request context projection idempotently after restart', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-final-context-repair-'))
    const location = { workDir: root, sessionId: 'session-final-context-repair', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const initialContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, provider: 'anthropic', model: 'test' }
    const finalContext = { ...initialContext, contextUsage: { pressureTokens: 55 }, projectionStage: 'final' as const }
    await sink.appendCritical({ type: 'request_context', payload: initialContext })
    await sink.close()
    await history.appendBatch([{
      ...event('response-final-context-repair', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] },
        sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } }, requestContext: finalContext } }
    }], 0)
    const repairUsageLedger = vi.fn(async () => undefined)
    const repairFinalRequestContextLedger = async (repairLocation: typeof location, payload: Record<string, unknown>) => {
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureFinalRequestContextEvent(repairSink, payload) }
      finally { await repairSink.close() }
    }

    await history.recoverInterruptedInvocations({ repairUsageLedger, repairFinalRequestContextLedger })
    await history.recoverInterruptedInvocations({ repairUsageLedger, repairFinalRequestContextLedger })

    const recoveredEvents = await readSessionEvents(path.join(root, 'sessions', 'session-final-context-repair-19700101', 'events.jsonl'))
    expect(recoveredEvents).toMatchObject([
      { type: 'request_context', payload: initialContext }, { type: 'request_context', payload: finalContext }
    ])
    expect(recoveredEvents).toHaveLength(2)
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs canonical provider retry projections idempotently after restart', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-retry-repair-'))
    const location = { workDir: root, sessionId: 'session-retry-repair', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const retryPayload = { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'provider_context_overflow' }
    const repairProviderRetryLedger = vi.fn(async (repairLocation, payload) => {
      expect(repairLocation).toEqual(location)
      await ensureRequestRetryEvent(sink, payload as Record<string, unknown>)
    })
    await history.appendBatch([{
      ...event('provider-retry-scheduled', 1), kind: 'provider-retry-scheduled',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
        sessionLedger: { location, requestRetry: retryPayload } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })
    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })

    expect(repairProviderRetryLedger).toHaveBeenCalledTimes(2)
    expect(await readSessionEvents(sink.eventsPath)).toMatchObject([{ type: 'request_retry', payload: retryPayload }])
    expect(await readSessionEvents(sink.eventsPath)).toHaveLength(1)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('reports provider retry projection repair failure through its dedicated diagnostic', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const repairLocation = { workDir: '/workspace', sessionId: 'session-retry-repair-failure', createdAt: 1000 }
    await history.appendBatch([{
      ...event('provider-retry-repair-failed', 1), kind: 'provider-retry-scheduled',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
        sessionLedger: { location: repairLocation, requestRetry: { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'provider_context_overflow' } } }
    }], 0)
    const repairFailure = new Error('retry projection unavailable')
    const onProviderRetryLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({
      repairProviderRetryLedger: async () => { throw repairFailure },
      onProviderRetryLedgerRepairError
    })

    expect(onProviderRetryLedgerRepairError).toHaveBeenCalledWith(repairFailure, 'inv-1', 'inv-1:round:1')
    expect(conn.prepare('SELECT status, attempts FROM canonical_projection_repairs WHERE repair_id=?').get('inv-1:invocation-projections:provider-retry-repair-failed')).toEqual({ status: 'pending', attempts: 1 })
    conn.close()
  })

  it('repairs the actual SDK provider retry outbox after a simulated crash before JSONL projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-live-retry-repair-'))
    const databasePath = path.join(root, 'history.sqlite')
    let conn = createDb(databasePath)
    let history = new SqliteAgentHistory(conn)
    const location = { workDir: root, sessionId: 'session-live-retry', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register({ routeId: 'retry-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'fake', stream: () => {
        providerCalls += 1
        return providerCalls === 1
          ? (async function* () { throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' }) })()
          : (async function* () { throw new Error('simulated process stop after retry projection') })()
      }
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('retry-invocation', [])
    const permits = new InMemorySafetyPermitStore()
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    await expect(runAgentTurn({
      registry, routeId: 'retry-route', invocationId: 'retry-invocation', turnId: 'retry-turn', history,
      request: { messages: [{ role: 'user', content: 'recover' }], maxTokens: 9 }, maxModelTurns: 1,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') }, toolExecution: createPermitBoundToolExecutionPort(permits, new InMemoryExecutionAdmissionCoordinator(), async () => ({ output: 'unused' })),
      recoverProviderAttempt: async ({ messages, error, attempt }) => error && attempt === 1
        ? { reasonCode: 'CONTEXT_OVERFLOW', messages, retryEvent: { attempt: 1, code: 'provider_context_overflow' } }
        : undefined,
      observer: {
        criticalModelRequestProjection: true,
        onModelRequest: async () => undefined,
        prepareProviderRetry: (retry) => ({ location, requestRetry: { turnId: 'retry-turn', stepId: 'retry-invocation', requestId: retry.requestId, attempt: retry.attempt, backoffMs: 0, code: retry.code } }),
        onProviderRetry: async (retry) => { events.push({ type: 'request_retry', payload: { turnId: 'retry-turn', stepId: 'retry-invocation', requestId: retry.requestId, attempt: retry.attempt, backoffMs: 0, code: retry.code } }) }
      }
    })).rejects.toThrow(/simulated process stop/)
    const retryEvent = events[0]!
    const canonicalBeforeRestart = await history.read('retry-invocation')
    await sink.close()
    await fs.rm(path.join(root, 'sessions'), { recursive: true, force: true })
    conn.close()

    conn = createDb(databasePath)
    history = new SqliteAgentHistory(conn)
    await expect(history.read('retry-invocation')).resolves.toEqual(canonicalBeforeRestart)

    const repairProviderRetryLedger = async (repairLocation: typeof location, payload: Record<string, unknown>) => {
      const recoverySink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureRequestRetryEvent(recoverySink, payload) }
      finally { await recoverySink.close() }
    }
    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })
    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })

    const recoveredEvents = await readSessionEvents(path.join(root, 'sessions', 'session-live-retry-19700101', 'events.jsonl'))
    expect(recoveredEvents).toHaveLength(1)
    expect(recoveredEvents[0]).toMatchObject(retryEvent)
    const recoveredHistory = await history.read('retry-invocation')
    expect(recoveredHistory).toEqual(canonicalBeforeRestart)
    expect(recoveredHistory.events.some((event) => event.kind === 'provider-retry-scheduled')).toBe(true)
    expect(recoveredHistory.events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('blocks request usage repair after a provider retry repair fails for the same session ledger', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-blocked-retry', createdAt: 1000 }
    await history.appendBatch([
      {
        ...event('retry-repair-fails', 1), kind: 'provider-retry-scheduled',
        payload: { requestId: 'inv-1:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
          sessionLedger: { location, requestRetry: { requestId: 'inv-1:round:1', attempt: 1, code: 'provider_context_overflow', backoffMs: 0 } } }
      },
      {
        ...event('response-after-retry', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', text: 'done', toolCalls: [] },
          sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)
    const repairProviderRetryLedger = vi.fn(async () => { throw new Error('retry ledger unavailable') })
    const repairUsageLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairProviderRetryLedger, repairUsageLedger })

    expect(repairProviderRetryLedger).toHaveBeenCalledTimes(1)
    expect(repairUsageLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('does not continue repairing a session ledger after request projection repair fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-request-failure', createdAt: 1000 }
    const requestHeader = { route: 'anthropic.messages.stream', requestId: 'inv-1:round:1', attempt: 1 }
    const requestContext = { requestId: 'inv-1:round:1', attempt: 1, provider: 'anthropic' }
    const repairModelRequestLedger = vi.fn(async () => { throw new Error('request ledger unavailable') })
    const repairUsageLedger = vi.fn(async () => undefined)
    await history.appendBatch([
      {
        ...event('request-started-failure', 1), kind: 'model-request-started',
        payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1',
          requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
          sessionLedger: { location, requestHeader, requestContext } }
      },
      {
        ...event('response-after-request-failure', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', text: 'done', toolCalls: [] },
          sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger, repairUsageLedger })

    expect(repairModelRequestLedger).toHaveBeenCalledTimes(1)
    expect(repairUsageLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('blocks later sidecar repair when a canonical request projection has invalid identity', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-invalid-request', createdAt: 1000 }
    const sensitiveSystemPrompt = 'PRIVATE_SYSTEM_PROMPT_SHOULD_NOT_ENTER_RECOVERY_DIAGNOSTICS'
    const repairModelRequestLedger = vi.fn(async () => undefined)
    const repairUsageLedger = vi.fn(async () => undefined)
    const requestRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('request-started-invalid', 1), kind: 'model-request-started',
        payload: { requestId: 'wrong-request-id', modelTurn: 1, attempt: 1, routeId: 'route-1',
          requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
          sessionLedger: { location, requestHeader: { requestId: 'wrong-request-id', attempt: 1, system: sensitiveSystemPrompt, tools: [{ name: 'private-tool-definition' }] }, requestContext: { requestId: 'wrong-request-id', attempt: 1, system: sensitiveSystemPrompt } } }
      },
      {
        ...event('response-after-invalid-request', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', text: 'done', toolCalls: [] },
          sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger, repairUsageLedger, onModelRequestLedgerRepairError: requestRepairError })

    expect(requestRepairError).toHaveBeenCalledTimes(1)
    expect(String(requestRepairError.mock.calls[0]?.[0])).not.toContain(sensitiveSystemPrompt)
    expect(repairModelRequestLedger).not.toHaveBeenCalled()
    expect(repairUsageLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('rejects request and retry projections bound to a different canonical turn', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const requestLocation = { workDir: '/workspace', sessionId: 'session-cross-turn-request', createdAt: 1000 }
    const retryLocation = { workDir: '/workspace', sessionId: 'session-cross-turn-retry', createdAt: 1000 }
    const repairModelRequestLedger = vi.fn(async () => undefined)
    const repairProviderRetryLedger = vi.fn(async () => undefined)
    const repairUsageLedger = vi.fn(async () => undefined)
    const requestRepairError = vi.fn()
    const retryRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('cross-turn-request', 1), kind: 'model-request-started',
        payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1',
          requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
          sessionLedger: { location: requestLocation,
            requestHeader: { requestId: 'inv-1:round:1', attempt: 1, turnId: 'other-turn' },
            requestContext: { requestId: 'inv-1:round:1', attempt: 1, turnId: 'other-turn' } } }
      },
      {
        ...event('cross-turn-request-response', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] },
          sessionLedger: { location: requestLocation, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)
    const retryEvent: HistoryEvent = {
      ...event('cross-turn-retry', 1), invocationId: 'inv-retry', turnId: 'canonical-retry-turn', kind: 'provider-retry-scheduled',
      payload: { requestId: 'inv-retry:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
        sessionLedger: { location: retryLocation, requestRetry: { requestId: 'inv-retry:round:1', attempt: 1, turnId: 'other-turn', code: 'provider_context_overflow', backoffMs: 0 } } }
    }
    await history.appendBatch([retryEvent], 0)

    await history.recoverInterruptedInvocations({
      repairModelRequestLedger, repairProviderRetryLedger, repairUsageLedger,
      onModelRequestLedgerRepairError: requestRepairError,
      onProviderRetryLedgerRepairError: retryRepairError
    })

    expect(repairModelRequestLedger).not.toHaveBeenCalled()
    expect(repairProviderRetryLedger).not.toHaveBeenCalled()
    expect(repairUsageLedger).not.toHaveBeenCalled()
    expect(requestRepairError).toHaveBeenCalledTimes(1)
    expect(retryRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-retry', 'inv-retry:round:1')
    conn.close()
  })

  it('recovers a committed model tool declaration if the process stops before approval or dispatch starts', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('model-response', 1),
      kind: 'model-response-committed',
      payload: { message: { role: 'assistant', toolCalls: [{ id: 'tc-proposed', name: 'write_file', input: { path: 'a.txt' } }] } }
    }], 0)

    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
      { invocationId: 'inv-1', state: 'interrupted' }
    ])
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 2,
      events: [expect.objectContaining({ kind: 'model-response-committed' }), expect.objectContaining({
        kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' }
      })]
    })
    conn.close()
  })

  it('recovers a committed compacted transcript if projection to the session ledger has not finished', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const repairCompaction = vi.fn(async () => undefined)
    await history.appendBatch([{
      ...event('compacted', 1),
      kind: 'transcript-compacted',
      payload: {
        messages: [{ role: 'user', content: 'current request' }],
        sessionLedger: {
          location: { workDir: '/workspace', sessionId: 'session-1', createdAt: 1000 },
          start: { compactionId: 'compact-1' }, summary: { compactionId: 'compact-1' }
        }
      }
    }], 0)
    await expect(history.recoverInterruptedInvocations({ repairCompaction })).resolves.toMatchObject([{ state: 'interrupted' }])
    expect(repairCompaction).toHaveBeenCalledWith(
      { workDir: '/workspace', sessionId: 'session-1', createdAt: 1000 },
      { compactionId: 'compact-1' }, { compactionId: 'compact-1' }
    )
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 2,
      events: [expect.objectContaining({ kind: 'transcript-compacted' }), expect.objectContaining({
        kind: 'invocation-interrupted', payload: {
          status: 'interrupted', reason: 'process-restart',
          sessionLedger: { location: { workDir: '/workspace', sessionId: 'session-1', createdAt: 1000 }, turnId: 'turn-1', reason: 'interrupted' }
        }
      })]
    })
    conn.close()
  })

  it('keeps failed compaction repair retryable even if its diagnostic callback fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('compacted-retry', 1),
      kind: 'transcript-compacted',
      payload: {
        messages: [{ role: 'user', content: 'current request' }],
        sessionLedger: {
          location: { workDir: '/workspace', sessionId: 'session-retry', createdAt: 2000 },
          start: { compactionId: 'compact-retry' }, summary: { compactionId: 'compact-retry' }
        }
      }
    }], 0)
    const firstError = new Error('ledger unavailable')
    const failedRepair = vi.fn(async () => { throw firstError })

    await expect(history.recoverInterruptedInvocations({
      repairCompaction: failedRepair,
      onCompactionRepairError: () => { throw new Error('diagnostic sink unavailable') }
    })).resolves.toMatchObject([{ state: 'interrupted' }])

    const retryRepair = vi.fn(async () => undefined)
    await expect(history.recoverInterruptedInvocations({ repairCompaction: retryRepair })).resolves.toMatchObject([{ state: 'interrupted' }])
    expect(failedRepair).toHaveBeenCalledTimes(1)
    expect(retryRepair).toHaveBeenCalledTimes(1)
    expect(conn.prepare('SELECT status, attempts FROM canonical_projection_repairs WHERE repair_id=?').get('inv-1:invocation-projections:compacted-retry')).toEqual({ status: 'completed', attempts: 2 })
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 2 })
    conn.close()
  })

  it('repairs a partial JSONL compaction from SQLite during restart recovery and closes the repair sink', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-compaction-recovery-'))
    const sessionId = 'session-recovery'
    const createdAt = 3000
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const ledgerStart = { compactionId: 'compact-recovery', windowId: 'w1', inputSurfaceFingerprint: 'input', targetTokens: 10 }
    const ledgerSummary = {
      compactionId: 'compact-recovery', windowId: 'w1', outputWindowId: 'w2', summaryHash: 'hash',
      outputSurfaceFingerprint: 'output', candidate: {}
    }
    const initialSink = getSessionEventSink(workDir, sessionId, createdAt)
    await initialSink.appendCritical({ type: 'compaction_start', payload: ledgerStart })
    await initialSink.close()
    await history.appendBatch([{
      ...event('compacted-recovery', 1), kind: 'transcript-compacted',
      payload: {
        messages: [{ role: 'user', content: 'current request' }],
        sessionLedger: { location: { workDir, sessionId, createdAt }, start: ledgerStart, summary: ledgerSummary }
      }
    }], 0)

    await expect(history.recoverInterruptedInvocations({
      repairCompaction: async (location, start, summary) => {
        const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        try { await ensureCompactionTransaction(sink, start, summary) }
        finally { await sink.close() }
      }
    })).resolves.toMatchObject([{ invocationId: 'inv-1', state: 'interrupted' }])

    const eventsPath = path.join(workDir, 'sessions', `${sessionId}-19700101`, 'events.jsonl')
    const ledgerEvents = await readSessionEvents(eventsPath)
    expect(ledgerEvents.map((entry) => entry.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect(ledgerEvents.at(-1)?.payload).toMatchObject({ status: 'committed', compactionId: 'compact-recovery' })
    expect((await history.read('inv-1')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted' })
    conn.close()
  })

  it('recovers the actual Hosted turn-boundary outbox after its JSONL commit fails', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-boundary-outbox-recovery-'))
    const sessionId = 'hosted-boundary-recovery'
    const createdAt = 4000
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const registry = new ModelProviderRegistry()
    registry.register({ routeId: 'hosted-boundary-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'fake', stream: async function* () {
        yield { type: 'text-delta', text: 'answer' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('hosted-boundary-invocation', [])
    const permits = new InMemorySafetyPermitStore()
    const start = { compactionId: 'hosted-boundary-compaction', windowId: 'w1', inputSurfaceFingerprint: 'input', targetTokens: 10 }
    const summary = { compactionId: 'hosted-boundary-compaction', windowId: 'w1', outputWindowId: 'w2', summaryHash: 'hash', outputSurfaceFingerprint: 'output', candidate: {} }

    await expect(runAgentTurn({
      registry, routeId: 'hosted-boundary-route', invocationId: 'hosted-boundary-invocation', turnId: 'hosted-boundary-turn',
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: createPermitBoundToolExecutionPort({
        permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
        resolveExpected: async (call) => ({ requestId: call.invocationId, turnId: 'hosted-boundary-turn', invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'v1', phase: 'recheck' }),
        execute: async () => ({ output: undefined })
      }),
      maxModelTurns: 1, history,
      contextProjectionCommitter: async () => { throw new Error('simulated JSONL outage') },
      planContextReplacement: async ({ messages }) => ({
        messages,
        historyPayload: { sessionLedger: { location: { workDir, sessionId, createdAt }, start, summary } }
      })
    })).rejects.toThrow('turn boundary ledger projection failed: simulated JSONL outage')

    const beforeRecovery = await history.read('hosted-boundary-invocation')
    expect(beforeRecovery.events.find((entry) => entry.kind === 'transcript-compacted')?.payload).toMatchObject({ sessionLedger: { location: { workDir, sessionId, createdAt }, start, summary } })
    await expect(history.recoverInterruptedInvocations({
      repairCompaction: async (location, repairStart, repairSummary) => {
        const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        try { await ensureCompactionTransaction(sink, repairStart, repairSummary) }
        finally { await sink.close() }
      }
    })).resolves.toMatchObject([{ invocationId: 'hosted-boundary-invocation', state: 'interrupted' }])

    const eventsPath = path.join(workDir, 'sessions', `${sessionId}-19700101`, 'events.jsonl')
    expect((await readSessionEvents(eventsPath)).map((entry) => entry.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect((await history.read('hosted-boundary-invocation')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'turn-boundary-ledger-projection-failed' } })
    conn.close()
  })

  it('marks a finished tool stream interrupted if the process stopped before invocation completion', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([
      { ...event('e1', 1), payload: { toolCallId: 'tc-1' } },
      { ...event('e2', 2), payload: { toolCallId: 'tc-1' } }
    ], 0)
    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([{ state: 'interrupted' }])
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 3,
      events: expect.arrayContaining([
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
        expect.objectContaining({ sequence: 3, kind: 'invocation-interrupted' })
      ])
    })
    conn.close()
  })

  it('does not recover terminal completed or failed invocations', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{ ...event('done', 1), kind: 'invocation-completed', payload: { status: 'completed' } }], 0)
    await expect(history.recoverInterruptedInvocations()).resolves.toEqual([])
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1 })
    conn.close()
  })

  it('repairs the missing turn_end projection from a canonical completed terminal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-repair-'))
    const location = { workDir: root, sessionId: 'session-terminal', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-completed', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal', reason: 'completed' }
      }
    }], 0)

    const repairs: Array<{ location: unknown; terminal: unknown }> = []
    await history.recoverInterruptedInvocations({
      repairInvocationTerminal: async (repairLocation, terminal) => {
        repairs.push({ location: repairLocation, terminal })
        const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
        finally { await repairSink.close() }
      }
    })

    expect(repairs).toEqual([{ location, terminal: { status: 'completed', turnId: 'turn-terminal', reason: 'completed' } }])
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-19700101', 'events.jsonl'))).resolves.toMatchObject([
      { type: 'turn_start', payload: { turnId: 'turn-terminal' } },
      { type: 'turn_end', payload: { turnId: 'turn-terminal', reason: 'completed' } }
    ])
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs a canonical turn terminal even when an unrelated request projection is malformed', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-terminal-independent-repair', createdAt: 1000 }
    const repairModelRequestLedger = vi.fn(async () => undefined)
    const repairInvocationTerminal = vi.fn(async () => undefined)
    await history.appendBatch([
      { ...event('invalid-request-projection', 1), kind: 'model-request-started', payload: {
        requestId: 'wrong-request', modelTurn: 1, attempt: 1,
        sessionLedger: { location, requestHeader: { requestId: 'wrong-request', attempt: 1 }, requestContext: { requestId: 'wrong-request', attempt: 1 } }
      } },
      { ...event('terminal-after-invalid-request', 2), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-independent-repair', reason: 'completed' }
      } }
    ], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger, repairInvocationTerminal })

    expect(repairModelRequestLedger).not.toHaveBeenCalled()
    expect(repairInvocationTerminal).toHaveBeenCalledWith(location, {
      status: 'completed', turnId: 'turn-independent-repair', reason: 'completed'
    })
    conn.close()
  })

  it('does not project a terminal sidecar whose state does not match the canonical event kind', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/terminal-state-mismatch', sessionId: 'session-terminal-mismatch', createdAt: 1000 }
    const repairInvocationTerminal = vi.fn(async () => undefined)
    await history.appendBatch([{
      ...event('terminal-state-mismatch', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal-mismatch', reason: 'interrupted' }
      }
    }], 0)

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).not.toHaveBeenCalled()
    conn.close()
  })

  it('does not report a terminal repair failure when the turn already has its end event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-idempotent-'))
    const location = { workDir: root, sessionId: 'session-terminal-idempotent', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal-idempotent' } })
    await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'turn-terminal-idempotent', reason: 'completed' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-existing-end', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal-idempotent', reason: 'completed' }
      }
    }], 0)
    const repairInvocationTerminal = vi.fn(async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
      finally { await repairSink.close() }
    })

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).toHaveBeenCalledOnce()
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-idempotent-19700101', 'events.jsonl'))).resolves.toHaveLength(2)
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('keeps a completed terminal retryable after SessionEvent projection fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-retry-'))
    const location = { workDir: root, sessionId: 'session-terminal-retry', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal-retry' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-retry', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal-retry', reason: 'completed' }
      }
    }], 0)
    const before = await history.read('inv-1')
    const onRepairError = vi.fn()
    let fail = true
    const repairInvocationTerminal = async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
      if (fail) { fail = false; throw new Error('injected terminal JSONL failure') }
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
      finally { await repairSink.close() }
    }

    await history.recoverInterruptedInvocations({ repairInvocationTerminal, onInvocationTerminalRepairError: onRepairError })
    await expect(history.read('inv-1')).resolves.toEqual(before)
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'turn-terminal-retry')
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-retry-19700101', 'events.jsonl'))).resolves.toHaveLength(1)

    await history.recoverInterruptedInvocations({ repairInvocationTerminal, onInvocationTerminalRepairError: onRepairError })

    await expect(history.read('inv-1')).resolves.toEqual(before)
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-retry-19700101', 'events.jsonl'))).resolves.toMatchObject([
      { type: 'turn_start', payload: { turnId: 'turn-terminal-retry' } },
      { type: 'turn_end', payload: { turnId: 'turn-terminal-retry', reason: 'completed' } }
    ])
    expect(onRepairError).toHaveBeenCalledOnce()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('preserves the cancelled SessionEvent reason from canonical terminal sidecar', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-cancelled-'))
    const location = { workDir: root, sessionId: 'session-terminal-cancelled', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal-cancelled' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-cancelled', 1), kind: 'invocation-interrupted', payload: {
        status: 'cancelled', sessionLedger: { location, turnId: 'turn-terminal-cancelled', reason: 'cancelled' }
      }
    }], 0)
    const repairInvocationTerminal = vi.fn(async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
      finally { await repairSink.close() }
    })

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).toHaveBeenCalledWith(location, { status: 'cancelled', turnId: 'turn-terminal-cancelled', reason: 'cancelled' })
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-cancelled-19700101', 'events.jsonl'))).resolves.toMatchObject([
      { type: 'turn_start', payload: { turnId: 'turn-terminal-cancelled' } },
      { type: 'turn_end', payload: { turnId: 'turn-terminal-cancelled', reason: 'cancelled' } }
    ])
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('does not rewrite denied or cancelled terminal invocation states during restart recovery', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const denied: HistoryEvent = {
      ...event('denied', 1), invocationId: 'inv-denied', turnId: 'turn-denied',
      kind: 'invocation-failed', payload: { status: 'denied', reason: 'POLICY_DENY' }
    }
    const cancelled: HistoryEvent = {
      ...event('cancelled', 1), invocationId: 'inv-cancelled', turnId: 'turn-cancelled',
      kind: 'invocation-interrupted', payload: { status: 'cancelled' }
    }
    await history.appendBatch([denied], 0)
    await history.appendBatch([cancelled], 0)
    await expect(history.recoverInterruptedInvocations()).resolves.toEqual([])
    await expect(history.read('inv-denied')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ kind: 'invocation-failed', payload: { status: 'denied', reason: 'POLICY_DENY' } })] })
    await expect(history.read('inv-cancelled')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })] })
    conn.close()
  })

  it('projects a post-approval fact change as a denied, unexecuted action', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-facts-changed')
    const makeEvent = (sequence: number, kind: HistoryEvent['kind'], payload: unknown): HistoryEvent => ({
      invocationId: 'inv-facts-changed', turnId: 'turn-facts-changed', sequence, schemaVersion: 1,
      eventId: `facts-changed-${sequence}`, idempotencyKey: `facts-changed-${sequence}`, kind, payload
    })
    await history.appendBatch([
      makeEvent(1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'changed-write', name: 'run_script', input: { code: 'secret script' } }] } }),
      makeEvent(2, 'approval-waiting', { toolCallId: 'changed-write', approvalId: 'approval-changed-write', answerer: 'user', reasonCode: 'script-path-unknown-confirm', requestedAt: 10 }),
      makeEvent(3, 'approval-resolved', { toolCallId: 'changed-write', approvalId: 'approval-changed-write', approved: true, outcome: 'approved', answerer: 'user', settledAt: 11 }),
      makeEvent(4, 'tool-call-not-dispatched', { toolCallId: 'changed-write', reason: 'FACTS_CHANGED', replayContent: '目标变化，未执行', isError: true }),
      makeEvent(5, 'invocation-completed', { status: 'completed' })
    ], 0)
    const projected = history.readCompletedToolCallsForSession('inv-facts-changed', 'session-facts-changed', 'turn-facts-changed')?.[0]
    expect(projected?.approval).toMatchObject({ status: 'denied', cause: 'facts-changed', reason: { summary: 'facts-changed' } })
    expect(projected?.result).toMatchObject({ success: false, notExecuted: true })
    conn.close()
  })

  it('rebuilds approval answerer and cause from the terminal decision after agent fallback', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-agent-fallback')
    const makeEvent = (sequence: number, kind: HistoryEvent['kind'], payload: unknown): HistoryEvent => ({
      invocationId: 'inv-agent-fallback', turnId: 'turn-agent-fallback', sequence, schemaVersion: 1,
      eventId: `agent-fallback-${sequence}`, idempotencyKey: `agent-fallback-${sequence}`, kind, payload
    })
    await history.appendBatch([
      makeEvent(1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'fallback-write', name: 'write_file', input: { path: 'out.txt' } }] } }),
      makeEvent(2, 'approval-waiting', { toolCallId: 'fallback-write', approvalId: 'inv-agent-fallback:approval:fallback-write', answerer: 'agent', reasonCode: 'agent-approval', requestedAt: 10 }),
      makeEvent(3, 'approval-resolved', { toolCallId: 'fallback-write', approvalId: 'inv-agent-fallback:approval:fallback-write', approved: true, outcome: 'approved', answerer: 'user', cause: 'user-approved', settledAt: 11 }),
      makeEvent(4, 'tool-call-started', { toolCallId: 'fallback-write' }),
      makeEvent(5, 'tool-call-finished', { toolCallId: 'fallback-write', success: true, result: { success: true, data: 'written' } }),
      makeEvent(6, 'invocation-completed', { status: 'completed' })
    ], 0)

    expect(history.readCompletedToolCallsForSession('inv-agent-fallback', 'session-agent-fallback', 'turn-agent-fallback')?.[0]?.approval)
      .toMatchObject({ answerer: 'user', status: 'approved', cause: 'user-approved', requestedAt: 10, settledAt: 11 })
    conn.close()
  })
})
