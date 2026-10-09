import { describe, expect, it, vi } from 'vitest'
import { evaluateRemoteAsyncApprovalGate, isRemoteAsyncApprovalGateEnabled, type RemoteAsyncApprovalGateEvidence } from './remoteAsyncApprovalGate'
import { createRemoteAsyncApprovalGate } from './remoteAsyncApprovalGate'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createDeferredTodoStore } from './deferredTodoStore'
import { createDeferredResumeCoordinator } from '../remote/deferredResumeCoordinator'
import { createDeferredEnvelopeStore } from './deferredEnvelopeStore'
import { selectConfirmationAnswerer } from './channels'

const p1Ids = ['P1-1', 'P1-2', 'P1-3', 'P1-4', 'P1-5', 'P1-6', 'P1-7'] as const
const oqIds = ['OQ-1', 'OQ-2', 'OQ-3', 'OQ-4', 'OQ-5', 'OQ-6', 'OQ-7', 'OQ-8'] as const

function evidence(): RemoteAsyncApprovalGateEvidence {
  return {
    safetyReview: { status: 'approved', reviewId: 'security-review-2026-10' },
    controls: Object.fromEntries(p1Ids.map((id) => [id, { passed: true, evidenceId: `test-${id}` }])) as RemoteAsyncApprovalGateEvidence['controls'],
    integrationRuns: Object.fromEntries(['6.5.16', '6.5.17', '6.5.18', '6.5.19'].map((taskId) => [taskId, {
      passed: true, realStores: true, realDispatcher: true, onlyFinalExecutorFake: true, runId: `run-${taskId}`
    }])) as RemoteAsyncApprovalGateEvidence['integrationRuns'],
    decisions: Object.fromEntries(oqIds.map((id) => [id, 'resolved'])) as RemoteAsyncApprovalGateEvidence['decisions'],
    groupChatPolicy: 'reject'
  }
}

describe('remote asynchronous approval release gate', () => {
  it('opens only with an approved safety review, evidence for every P1 control and real integration runs', () => {
    expect(evaluateRemoteAsyncApprovalGate(evidence())).toMatchObject({ allowed: true, reasons: [] })
  })

  it('fails closed when the safety review is incomplete or any P1 control lacks evidence', () => {
    expect(evaluateRemoteAsyncApprovalGate({ ...evidence(), safetyReview: { status: 'pending', reviewId: 'review' } }).allowed).toBe(false)
    const missingControl = evidence()
    delete (missingControl.controls as Record<string, unknown>)['P1-4']
    expect(evaluateRemoteAsyncApprovalGate(missingControl)).toMatchObject({ allowed: false, reasons: expect.arrayContaining(['missing-control-evidence:P1-4']) })
  })

  it('rejects fake-port substitutes for the 6.5.16–6.5.19 integration evidence', () => {
    const input = evidence()
    input.integrationRuns['6.5.17'] = { passed: true, realStores: false, realDispatcher: false, onlyFinalExecutorFake: false, runId: 'fake-only' }
    expect(evaluateRemoteAsyncApprovalGate(input)).toMatchObject({ allowed: false, reasons: expect.arrayContaining(['invalid-integration-evidence:6.5.17']) })
  })

  it('requires all recorded OQ decisions resolved and keeps current group chats rejected', () => {
    const unresolved = evidence()
    unresolved.decisions['OQ-3'] = 'pending'
    expect(evaluateRemoteAsyncApprovalGate(unresolved).allowed).toBe(false)
    expect(evaluateRemoteAsyncApprovalGate({ ...evidence(), groupChatPolicy: 'allow' })).toMatchObject({ allowed: false,
      reasons: expect.arrayContaining(['group-chat-policy-must-reject']) })
  })

  it('persists disabled by default and refuses to enable without complete evidence', async () => {
    const db = createMemoryAppDb()
    const gate = createRemoteAsyncApprovalGate({ db, getEvidence: () => ({ ...evidence(), safetyReview: { status: 'pending', reviewId: 'pending' } }), closeAll: async () => ({ status: 'closed' }) })
    expect(gate.getState()).toMatchObject({ state: 'disabled' })
    expect(gate.isEnabled()).toBe(false)
    await expect(gate.setEnabled(true)).resolves.toMatchObject({ state: 'disabled', enabled: false })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_async_approval_gate_state WHERE singleton=1').get()).toEqual({ state: 'disabled' })
    db.close()
  })

  it('durably fences dispatch before closing and can reconcile a failed close after restart', async () => {
    const db = createMemoryAppDb()
    let closeResult: { status: 'closed' | 'reconciliation_required' } = { status: 'closed' }
    const input = { db, getEvidence: evidence, closeAll: async () => closeResult }
    const gate = createRemoteAsyncApprovalGate(input)
    await expect(gate.setEnabled(true)).resolves.toMatchObject({ state: 'enabled', enabled: true })
    closeResult = { status: 'reconciliation_required' }
    await expect(gate.setEnabled(false)).resolves.toMatchObject({ state: 'closing', enabled: false })
    expect(gate.isEnabled()).toBe(false)
    expect(gate.getState().closeRequired).toBe(true)

    closeResult = { status: 'closed' }
    const restarted = createRemoteAsyncApprovalGate(input)
    await expect(restarted.reconcilePendingClose()).resolves.toMatchObject({ state: 'disabled', enabled: false })
    expect(restarted.getState().closeRequired).toBe(false)
    db.close()
  })

  it('prevents old pending resume work from reaching dispatch once the durable gate is closing', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const gate = createRemoteAsyncApprovalGate({ db, getEvidence: evidence, closeAll: async () => ({ status: 'closed' }) })
    await gate.setEnabled(true)
    const now = Date.now()
    conn.prepare(`INSERT INTO deferred_todos(todo_id,invocation_id,channel,identity_key,owner_id,authorization_epoch,rule_id,facts_hash,
      workflow_id,task_id,step_id,plan_revision,origin_session_id,state,created_at,expires_at,updated_at)
      VALUES('old-todo','old-invocation','feishu','identity','owner',1,'rule','facts','workflow','task','step',1,'old-session','pending',?,?,?)`)
      .run(now, now + 60_000, now)
    conn.prepare(`INSERT INTO deferred_resume_requests(request_id,reason_key,todo_id,invocation_id,session_id,channel,identity_key,owner_id,
      authorization_epoch,rule_id,facts_hash,notification_version,message_id,state,created_at,updated_at)
      VALUES('old-request','old-reason','old-todo','old-invocation','old-session','feishu','identity','owner',1,'rule','facts',1,'message','pending',?,?)`)
      .run(now, now)
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const coordinator = createDeferredResumeCoordinator({ db, todoStore: createDeferredTodoStore(db),
      envelopeStore: createDeferredEnvelopeStore(db), dispatch, maxParallel: 1, recheck: async () => ({ allowed: true }) })
    await gate.setEnabled(false)
    expect(await coordinator.dispatchPending('old-session')).toEqual([{ requestId: 'old-request', status: 'invalidated' }])
    expect(dispatch).not.toHaveBeenCalled()
    expect(conn.prepare("SELECT state FROM deferred_resume_requests WHERE request_id='old-request'").get()).toEqual({ state: 'invalidated' })
    db.close()
  })

  it('exposes only durable enabled state to the production confirmation selector', async () => {
    const db = createMemoryAppDb()
    expect(isRemoteAsyncApprovalGateEnabled(db)).toBe(false)
    const answerer = () => selectConfirmationAnswerer({ lane: 'feishu', remoteAsyncApprovalEnabled: isRemoteAsyncApprovalGateEnabled(db) })
    expect(answerer()).toEqual({ kind: 'user' })
    const gate = createRemoteAsyncApprovalGate({ db, getEvidence: evidence, closeAll: async () => ({ status: 'closed' }) })
    await gate.setEnabled(true)
    expect(isRemoteAsyncApprovalGateEnabled(db)).toBe(true)
    expect(answerer()).toEqual({ kind: 'agent' })
    await gate.setEnabled(false)
    expect(isRemoteAsyncApprovalGateEnabled(db)).toBe(false)
    expect(answerer()).toEqual({ kind: 'user' })
    db.close()
  })
})
