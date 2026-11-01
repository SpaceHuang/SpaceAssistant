import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import { createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createRuntimeTriggerStartAuthorizer } from './authorization'

function seedTrigger(conn: ReturnType<typeof getDbConnection>, receiver: string): void {
  conn.prepare(`INSERT INTO runtime_triggers(id,owner_session_id,receiver_session_id,client_key,definition_json,state,created_at,expires_at,event_json,attempts,revision,updated_at)
    VALUES('trigger-1','owner',?,'key','{"version":1,"condition":{"type":"time","at":"2026-01-01T00:00:00Z","taskPrompt":"do"},"sourceBaseline":{}}','matched',1,9999999999999,'{}',0,1,1)`).run(receiver)
  conn.prepare("UPDATE runtime_triggers SET result_json=? WHERE id='trigger-1'").run(JSON.stringify({ authorization: {
    bindingVersion: 1, requestId: 'runtime-trigger:trigger-1', ownerSessionId: 'owner', receiverSessionId: receiver,
    queueScope: { kind: 'desktop' }, sourceIdentity: { type: 'time' }, payloadDigest: 'payload-digest', policyRevision: '3',
    authorizationGeneration: '2', runtimeGeneration: '1'
  } }))
}

function contextEvent(receiver: string): HistoryEvent {
  return { invocationId: 'inv-1', turnId: 'turn-1', sequence: 1, schemaVersion: 1, eventId: 'inv-1:history:1',
    idempotencyKey: 'inv-1:invocation-context-committed:1', kind: 'invocation-context-committed',
    payload: { contextProtocol: 2, baseVersion: 0, inputMode: 'full', inputMessages: [{ role: 'user', content: 'approved source' }],
      failureInputMessages: [], scope: { kind: 'session', sessionId: receiver }, messages: [{ role: 'user', content: 'approved source' }], requestSnapshot: { model: 'test' } } }
}

describe('runtime trigger authorization final-check', () => {
  it('atomically rejects source context when authorization changed before the first history commit', async () => {
    const temp = createTempDatabase('runtime-trigger-auth-revoked-')
    try {
      const session = createSession(temp.db, { name: 'receiver' })
      const conn = getDbConnection(temp.db)
      seedTrigger(conn, session.id)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id, undefined, {
        triggerId: 'trigger-1', requestId: 'runtime-trigger:trigger-1', receiverSessionId: session.id, turnId: 'turn-1',
        invocationId: 'inv-1', contextEventId: 'inv-1:history:1', payloadDigest: 'payload-digest',
        authorizationGeneration: '2', policyRevision: '3', runtimeGeneration: '1', finalCheck: () => false
      })
      await expect(history.appendBatch([contextEvent(session.id)], 0)).rejects.toThrow('authorization final-check rejected')
      await expect(history.appendBatch([{ ...contextEvent(session.id), sequence: 1, eventId: 'inv-1:failed', idempotencyKey: 'inv-1:failed',
        kind: 'invocation-failed', payload: { status: 'failed' } }], 0,
      { sessionId: session.id, baseVersion: 0, outcome: 'failed', protocol: 1, messages: [{ role: 'user', content: 'unapproved raw source' }] }))
        .rejects.toThrow('runtime trigger history cannot advance before admission')
      expect(await history.read('inv-1')).toMatchObject({ version: 0, events: [] })
      expect(JSON.parse((conn.prepare("SELECT result_json FROM runtime_triggers WHERE id='trigger-1'").get() as { result_json: string }).result_json)).not.toHaveProperty('admission')
    } finally { temp.cleanup() }
  })

  it('commits first invocation context and admission receipt in the same SQLite transaction', async () => {
    const temp = createTempDatabase('runtime-trigger-auth-admitted-')
    try {
      const session = createSession(temp.db, { name: 'receiver' })
      const conn = getDbConnection(temp.db)
      seedTrigger(conn, session.id)
      let authorized = true
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id, undefined, {
        triggerId: 'trigger-1', requestId: 'runtime-trigger:trigger-1', receiverSessionId: session.id, turnId: 'turn-1',
        invocationId: 'inv-1', contextEventId: 'inv-1:history:1', payloadDigest: 'payload-digest',
        authorizationGeneration: '2', policyRevision: '3', runtimeGeneration: '1', finalCheck: () => authorized
      })
      await history.appendBatch([contextEvent(session.id)], 0)
      const persisted = JSON.parse((conn.prepare("SELECT result_json FROM runtime_triggers WHERE id='trigger-1'").get() as { result_json: string }).result_json).admission
      expect((await history.read('inv-1')).events).toHaveLength(1)
      expect(persisted).toMatchObject({ version: 1, triggerId: 'trigger-1', requestId: 'runtime-trigger:trigger-1',
        receiverSessionId: session.id, turnId: 'turn-1', invocationId: 'inv-1', contextEventId: 'inv-1:history:1',
        payloadDigest: 'payload-digest', authorizationGeneration: '2', policyRevision: '3' })
      await expect(history.appendBatch([contextEvent(session.id)], 0)).resolves.toMatchObject({ duplicate: true })
      authorized = false
      await history.appendBatch([{ ...contextEvent(session.id), sequence: 2, eventId: 'inv-1:completed', idempotencyKey: 'inv-1:completed',
        kind: 'invocation-completed', payload: { status: 'completed' } }], 1)
      expect((await history.read('inv-1')).events.at(-1)?.kind).toBe('invocation-completed')
    } finally { temp.cleanup() }
  })

  it('rolls back committed context when writing the admission receipt fails', async () => {
    const temp = createTempDatabase('runtime-trigger-admission-rollback-')
    try {
      const session = createSession(temp.db, { name: 'receiver' })
      const conn = getDbConnection(temp.db)
      seedTrigger(conn, session.id)
      conn.exec(`CREATE TRIGGER reject_runtime_admission BEFORE UPDATE OF result_json ON runtime_triggers
        BEGIN SELECT RAISE(ABORT, 'injected admission write failure'); END`)
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id, undefined, {
        triggerId: 'trigger-1', requestId: 'runtime-trigger:trigger-1', receiverSessionId: session.id, turnId: 'turn-1',
        invocationId: 'inv-1', contextEventId: 'inv-1:history:1', payloadDigest: 'payload-digest',
        authorizationGeneration: '2', policyRevision: '3', runtimeGeneration: '1', finalCheck: () => true
      })
      await expect(history.appendBatch([contextEvent(session.id)], 0)).rejects.toThrow('injected admission write failure')
      expect(await history.read('inv-1')).toMatchObject({ version: 0, events: [] })
      expect(JSON.parse((conn.prepare("SELECT result_json FROM runtime_triggers WHERE id='trigger-1'").get() as { result_json: string }).result_json)).not.toHaveProperty('admission')
    } finally { temp.cleanup() }
  })
})

describe('runtime trigger shared start authorization', () => {
  const scope = { kind: 'desktop' } as const
  const binding = { bindingVersion: 1 as const, requestId: 'runtime-trigger:trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver',
    queueScope: scope, sourceIdentity: { type: 'time' }, payloadDigest: 'digest', policyRevision: 'p1', authorizationGeneration: 'a1', runtimeGeneration: 'r1' }
  const trigger = { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', result: { authorization: binding }, revision: 1 } as never
  const turn = { requestId: binding.requestId, sessionId: 'receiver', turnId: 'turn-1' }

  it('re-enters policy and replaces the trusted binding when revisions changed', () => {
    const updated = { ...trigger, revision: 2, result: { authorization: { ...binding, policyRevision: 'p2', authorizationGeneration: 'a2' } } }
    const update = vi.fn(() => updated)
    const reauthorize = vi.fn(() => updated.result.authorization)
    const gate = createRuntimeTriggerStartAuthorizer({ read: () => trigger, update, resolveQueueScope: () => scope,
      readReceipt: () => ({ queuedMessageId: 'marker', turnId: 'turn-1', state: 'claimed' }), classify: () => 'runtime-trigger',
      verifyAdmission: () => false, readCurrentAuthorization: () => ({ policyRevision: 'p2', authorizationGeneration: 'a2', runtimeGeneration: 'r1' }),
      reauthorize, cancel: vi.fn(), fail: vi.fn(), now: () => 10 })
    expect(gate(turn)).toBe(true)
    expect(reauthorize).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith('trigger-1', 1, expect.objectContaining({ updatedAt: 10 }))
  })

  it('cancels an unstarted request when policy reapproval denies it', () => {
    const cancel = vi.fn()
    const fail = vi.fn()
    const gate = createRuntimeTriggerStartAuthorizer({ read: () => trigger, update: vi.fn(), resolveQueueScope: () => scope,
      readReceipt: () => ({ queuedMessageId: 'marker', turnId: 'turn-1', state: 'claimed' }), classify: () => 'runtime-trigger',
      verifyAdmission: () => false, readCurrentAuthorization: () => ({ policyRevision: 'p2', authorizationGeneration: 'a2', runtimeGeneration: 'r1' }),
      reauthorize: () => null, cancel, fail })
    expect(gate(turn)).toBe(false)
    expect(fail).toHaveBeenCalledWith(trigger, 'authorization-revoked')
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'receiver', requestId: turn.requestId, queueScope: scope, turnId: 'turn-1' })
  })

  it('does not reauthorize or cancel history whose atomic admission is already verified', () => {
    const accepted = { ...trigger, result: { ...trigger.result, admission: { version: 1 } } }
    const reauthorize = vi.fn()
    const gate = createRuntimeTriggerStartAuthorizer({ read: () => accepted, update: vi.fn(), resolveQueueScope: () => scope,
      readReceipt: () => ({ queuedMessageId: 'marker', turnId: 'turn-1', state: 'claimed' }), classify: () => 'runtime-trigger',
      verifyAdmission: () => true, readCurrentAuthorization: () => undefined, reauthorize, cancel: vi.fn(), fail: vi.fn() })
    expect(gate(turn)).toBe(true)
    expect(reauthorize).not.toHaveBeenCalled()
  })
})
