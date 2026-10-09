import { describe, expect, it, vi } from 'vitest'
import type { ApprovalInvocationResult, ConfirmRequest } from '../../src/shared/confirmation/types'
import { createMemoryAppDb } from '../database/testHelpers'
import { AgentChannel } from './agentChannel'
import { resolveConfirmChannel } from './channels'
import { createPersistentDeferredTodoAdmission } from './deferredTodoAdmission'
import { createDeferredApprovalAdapter } from './deferredApprovalAdapter'
import { ImChannel } from './imChannel'

const request: ConfirmRequest = {
  facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write a file' } },
  riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000
}
const direct = { kind: 'direct' as const, restrictionsComplete: true }
const material = { kind: 'material' as const, restrictionsComplete: false }

describe('IM async approval outcome integration', () => {
  it.each(['wechat', 'feishu'] as const)('%s uses the real channel/AgentChannel path and persists only eligible approve', async (lane) => {
    const db = createMemoryAppDb()
    const approval: ApprovalInvocationResult = { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } }
    const invokeApproval = vi.fn(async () => approval)
    const resolved = resolveConfirmChannel({
      lane, requestId: `integration-${lane}`, sessionId: `session-${lane}`, toolName: 'write_file',
      remoteAsyncApprovalEnabled: true, agentChannelFactory: (deps) => new AgentChannel({ ...deps, invokeApproval })
    })
    const channelOutcome = await resolved.request(request)
    expect(channelOutcome).toMatchObject({ kind: 'approved', cause: 'agent-approved' })
    expect(invokeApproval).toHaveBeenCalledOnce()

    const dispatch = vi.fn()
    const admission = createPersistentDeferredTodoAdmission(db, { dispatch, sendReceipt: vi.fn() })
    const createdAt = Date.now()
    const todo = {
      todoId: `todo-${lane}`, invocationId: `inv-${lane}`, channel: lane,
      identityKey: `identity-${lane}`, ownerId: `owner-${lane}`, authorizationEpoch: 1,
      rule: { ruleId: 'write-rule', factsHash: 'a'.repeat(64) }, workflowId: `workflow-${lane}`,
      taskId: `task-${lane}`, stepId: `step-${lane}`, planRevision: 1, originSessionId: `session-${lane}`,
      createdAt, expiresAt: createdAt + 86_400_000, updatedAt: createdAt
    }
    const adapter = createDeferredApprovalAdapter({ admission, dispatch })
    const result = await adapter.resolve({
      approval, eligibility: { kind: 'eligible', todoId: todo.todoId }, todo: { ...todo, reservationId: `reservation-${lane}` }, ttlMs: 86_400_000,
      policy: { lane, enabled: true, actionClass: 'write', gate: 'eligible', evidence: material }
    })
    expect(result).toEqual({ kind: 'deferred', todoId: todo.todoId, cause: 'insufficient-delegation-evidence' })
    expect(admission.todoStore.get(todo.todoId, {
      channel: lane, identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 1, rule: todo.rule
    })).toMatchObject({ status: 'pending', invocationId: `inv-${lane}` })
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })

  it.each(['wechat', 'feishu'] as const)('%s remains on the existing user answerer when rollout is off', async (lane) => {
    const db = createMemoryAppDb()
    const imChannel = new ImChannel({ lane, timeoutMs: 1000, sendPrompt: vi.fn() })
    const agentFactory = vi.fn(() => new AgentChannel({ lane, requestId: 'unused', sessionId: 'unused', toolName: 'write_file',
      policy: { kind: 'agent' }, invokeApproval: async () => ({ ok: true, verdict: { kind: 'approve', reason: { summary: 'unexpected' } } }) }))
    const resolved = resolveConfirmChannel({ lane, requestId: `closed-${lane}`, sessionId: `closed-session-${lane}`, toolName: 'write_file',
      remoteAsyncApprovalEnabled: false, imChannel, buildImPending: () => ({ requestId: `closed-${lane}`, sessionId: `closed-session-${lane}`, messageId: 'origin', matchKey: 'identity' }),
      agentChannelFactory: agentFactory })
    const pending = resolved.request(request)
    await vi.waitFor(() => expect(imChannel.countPending()).toBe(1))
    resolved.cancel(`closed-${lane}`)
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', cause: 'cancelled' })
    expect(agentFactory).not.toHaveBeenCalled()
    expect(db).toBeDefined()
    db.close()
  })

  it.each([
    ['deny', { ok: true, verdict: { kind: 'deny', reason: { summary: 'denied' } } }],
    ['undetermined', { ok: true, verdict: { kind: 'undetermined', reason: { summary: 'uncertain' } } }],
    ['unavailable', { ok: false, cause: 'unavailable' }], ['timeout', { ok: false, cause: 'timeout' }],
    ['unparsable', { ok: false, cause: 'unparsable' }], ['config-error', { ok: false, cause: 'config-error' }]
  ] as const)('%s from the real channel path follows the final gate disposition', async (_label, approval, lane = 'wechat') => {
    const db = createMemoryAppDb()
    const resolved = resolveConfirmChannel({ lane, requestId: `failed-${_label}`, sessionId: `failed-session-${_label}`, toolName: 'write_file',
      remoteAsyncApprovalEnabled: true, answererPolicy: { kind: 'agent' }, agentChannelFactory: (deps) => new AgentChannel({ ...deps, invokeApproval: async () => approval }) })
    const channelOutcome = await resolved.request(request)
    expect(channelOutcome.kind).not.toBe('approved')
    const admission = createPersistentDeferredTodoAdmission(db, { dispatch: vi.fn(), sendReceipt: vi.fn() })
    const adapter = createDeferredApprovalAdapter({ admission, dispatch: vi.fn() })
    const now = Date.now()
    const todo = {
      todoId: 'never-created', invocationId: `inv-failed-${_label}`, reservationId: `res-failed-${_label}`, channel: lane, identityKey: 'id', ownerId: 'owner', originSessionId: `failed-session-${_label}`,
      authorizationEpoch: 1, rule: { ruleId: 'r', factsHash: 'b'.repeat(64) }, workflowId: 'w', taskId: 't', stepId: 's', planRevision: 1,
      createdAt: now, expiresAt: now + 60_000, updatedAt: now
    }
    const result = await adapter.resolve({ approval, eligibility: { kind: 'eligible', todoId: 'never-created' }, todo, ttlMs: 60_000,
      policy: { lane, enabled: true, actionClass: 'write', gate: 'eligible', evidence: direct, answererAvailable: true } })
    const shouldDefer = _label !== 'config-error'
    expect(result).toMatchObject({ kind: shouldDefer ? 'deferred' : 'deny' })
    expect(admission.todoStore.get('never-created', {
      channel: lane, identityKey: 'id', ownerId: 'owner', authorizationEpoch: 1, rule: { ruleId: 'r', factsHash: 'b'.repeat(64) }
    })?.status ?? null).toBe(shouldDefer ? 'pending' : null)
    db.close()
  })

  it.each(['config-error', 'locked', 'critical', 'recursion-blocked'] as const)('keeps %s outside deferred todos', async (kind) => {
    const db = createMemoryAppDb()
    const admission = createPersistentDeferredTodoAdmission(db, { dispatch: vi.fn(), sendReceipt: vi.fn() })
    const adapter = createDeferredApprovalAdapter({ admission, dispatch: vi.fn() })
    const result = await adapter.resolve({ approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } },
      eligibility: { kind }, todo: { todoId: 'blocked', invocationId: 'blocked-inv', reservationId: 'blocked-res', channel: 'feishu',
        identityKey: 'id', ownerId: 'owner', authorizationEpoch: 1, rule: { ruleId: 'r', factsHash: 'c'.repeat(64) },
        workflowId: 'w', taskId: 't', stepId: 's', planRevision: 1, originSessionId: 'origin', createdAt: 100, expiresAt: 200, updatedAt: 100 }, ttlMs: 100 })
    expect(result).not.toMatchObject({ kind: 'deferred' })
    expect(admission.todoStore.get('blocked', { channel: 'feishu', identityKey: 'id', ownerId: 'owner', authorizationEpoch: 1,
      rule: { ruleId: 'r', factsHash: 'c'.repeat(64) } })).toBeNull()
    db.close()
  })
})
