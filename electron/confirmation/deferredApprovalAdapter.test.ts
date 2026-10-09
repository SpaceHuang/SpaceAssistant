import { describe, expect, it, vi } from 'vitest'
import { createDeferredApprovalAdapter } from './deferredApprovalAdapter'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSecurityActionIntentStore } from './securityActionIntentStore'
import { createDeferredEnvelopeStore } from './deferredEnvelopeStore'

describe('deferred approval adapter', () => {
  it('persists the exact original tool-call identity and immutable input before admitting a deferred todo', async () => {
    const db = createMemoryAppDb()
    const envelopeStore = createDeferredEnvelopeStore(db)
    const envelope = { invocationId: 'resume-envelope-call', requestId: 'resume-envelope-request', turnId: 'resume-envelope-turn',
      toolCallId: 'resume-envelope-tool-call', toolName: 'write_file', canonicalArgs: { path: 'report.md', content: 'approved' },
      contentVersions: { file: 1 }, executionContext: { sessionId: 'origin', workDir: '/workspace' } }
    const admission = { defer: vi.fn(async () => ({ kind: 'deferred' })) }
    const adapter = createDeferredApprovalAdapter({ admission, dispatch: vi.fn(), envelopeStore })
    await expect(adapter.resolve({
      approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } },
      eligibility: { kind: 'eligible', todoId: 'resume-envelope-todo' },
      todo: { todoId: 'resume-envelope-todo', invocationId: envelope.invocationId, reservationId: 'reservation', originSessionId: 'origin', identityKey: 'identity', channel: 'feishu', ownerId: 'owner' },
      envelope, ttlMs: 10_000
    })).resolves.toMatchObject({ kind: 'deferred', todoId: 'resume-envelope-todo' })
    expect(admission.defer).toHaveBeenCalledOnce()
    expect(envelopeStore.get(envelope.invocationId)).toMatchObject({ ...envelope, schemaVersion: 2 })
    db.close()
  })

  it('requires a checkpoint-committed intent before returning a resume-capable deferred result', async () => {
    const db = createMemoryAppDb()
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: 'checkpoint-inv', sessionId: 'origin', workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, envelopeInvocationId: 'checkpoint-inv' })
    const adapter = createDeferredApprovalAdapter({ admission: { defer: async () => ({ kind: 'deferred' }) }, dispatch: vi.fn(), intentStore: intents as never })
    const input = { approval: { ok: true as const, verdict: { kind: 'approve' as const, reason: { summary: 'ok' } } },
      eligibility: { kind: 'eligible' as const, todoId: 'checkpoint-todo' },
      todo: { todoId: 'checkpoint-todo', invocationId: 'checkpoint-inv', reservationId: 'res', originSessionId: 'origin', identityKey: 'identity', channel: 'feishu', ownerId: 'owner', workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1 }, ttlMs: 10_000,
      checkpoint: { checkpointId: 'checkpoint-1', workflowRevision: 4 } }
    await expect(adapter.resolve(input)).resolves.toMatchObject({ kind: 'deferred', todoId: 'checkpoint-todo' })
    expect(intents.authorizeResume('checkpoint-inv')).toBe(true)

    const successIntent = 'checkpoint-success-inv'
    const successAdapter = createDeferredApprovalAdapter({ admission: { defer: async () => ({ kind: 'deferred' }) }, dispatch: vi.fn(), intentStore: intents as never })
    const success = await successAdapter.resolve({ ...input, todo: { ...input.todo, todoId: 'checkpoint-success-todo', invocationId: successIntent },
      eligibility: { kind: 'eligible', todoId: 'checkpoint-success-todo' },
      checkpoint: { checkpointId: 'checkpoint-success', workflowRevision: 5 } })
    expect(success).toMatchObject({ kind: 'deferred', todoId: 'checkpoint-success-todo' })
    expect(intents.get(successIntent)).toMatchObject({ state: 'checkpoint_committed', todoId: 'checkpoint-success-todo', checkpointId: 'checkpoint-success' })
    expect(intents.authorizeResume(successIntent)).toBe(true)

    const failedIntent = 'checkpoint-failed-inv'
    const failureFallback = vi.fn(async () => ({ kind: 'rejected', cause: 'unavailable' }))
    const failedAdapter = createDeferredApprovalAdapter({ admission: { defer: async () => ({ kind: 'deferred' }) }, dispatch: vi.fn(), intentStore: {
      ...intents, prepare: (args: Parameters<typeof intents.prepare>[0]) => intents.prepare(args),
      linkTodo: (id: string, todoId: string) => intents.linkTodo(id, todoId),
      commitCheckpoint: () => { throw new Error('injected checkpoint failure') },
      authorizeResume: (id: string) => intents.authorizeResume(id)
    } as never, fallback: failureFallback })
    const failed = await failedAdapter.resolve({ ...input, todo: { ...input.todo, todoId: 'checkpoint-failed-todo', invocationId: failedIntent },
      eligibility: { kind: 'eligible', todoId: 'checkpoint-failed-todo' } })
    expect(failed).toEqual({ kind: 'rejected', cause: 'unavailable' })
    expect(intents.authorizeResume(failedIntent)).toBe(false)
    expect(failureFallback).toHaveBeenCalledOnce()
    db.close()
  })

  it('commits the checkpoint returned by the persisted task-control CAS instead of fabricating one', async () => {
    const db = createMemoryAppDb()
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: 'task-checkpoint-inv', sessionId: 'origin', workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 2, envelopeInvocationId: 'task-checkpoint-inv' })
    const commitTaskCheckpoint = vi.fn(() => ({ checkpointId: 'deferred:task-checkpoint-inv', workflowRevision: 9 }))
    const adapter = createDeferredApprovalAdapter({ admission: { defer: async () => ({ kind: 'deferred' }) }, dispatch: vi.fn(),
      intentStore: intents as never, commitTaskCheckpoint })
    const result = await adapter.resolve({ approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'ok' } } },
      eligibility: { kind: 'eligible', todoId: 'task-checkpoint-todo' },
      todo: { todoId: 'task-checkpoint-todo', invocationId: 'task-checkpoint-inv', reservationId: 'reservation', originSessionId: 'origin', identityKey: 'identity', channel: 'feishu', ownerId: 'owner',
        workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 2 }, ttlMs: 60_000,
      checkpoint: { checkpointId: 'untrusted-caller-checkpoint', workflowRevision: 1 } })
    expect(result).toMatchObject({ kind: 'deferred', todoId: 'task-checkpoint-todo' })
    expect(commitTaskCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ todoId: 'task-checkpoint-todo' }), 'task-checkpoint-todo')
    expect(intents.get('task-checkpoint-inv')).toMatchObject({ state: 'checkpoint_committed', checkpointId: 'deferred:task-checkpoint-inv', checkpointWorkflowRevision: 9 })
    db.close()
  })

  it('persists only eligible approve, returns deferred after persistence, and never dispatches', async () => {
    const admission = { defer: vi.fn(async () => ({ kind: 'deferred', created: { todoId: 'todo-1' } })) }
    const dispatch = vi.fn()
    const adapter = createDeferredApprovalAdapter({ admission, dispatch })
    const result = await adapter.resolve({
      approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } },
      eligibility: { kind: 'eligible', todoId: 'todo-1' },
      todo: { todoId: 'todo-1', invocationId: 'inv-1', reservationId: 'res-1', originSessionId: 'session-1', identityKey: 'identity-1', channel: 'feishu', ownerId: 'owner' }, ttlMs: 10_000
    })
    expect(result).toEqual({ kind: 'deferred', todoId: 'todo-1' })
    expect(admission.defer).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, cause: 'timeout' }, 'timeout'],
    [{ ok: true, verdict: { kind: 'undetermined', reason: { summary: 'uncertain' } } }, 'undetermined']
  ] as const)('does not persist or report success for failed/uncertain approval %j', async (approval, kind) => {
    const admission = { defer: vi.fn() }
    const adapter = createDeferredApprovalAdapter({ admission, dispatch: vi.fn(), fallback: async () => ({ kind: 'fallback' }) })
    await expect(adapter.resolve({ approval, eligibility: { kind: 'eligible', todoId: 'todo-1' }, todo: { todoId: 'todo-1', invocationId: 'inv-1', reservationId: 'res-1', originSessionId: 'session-1', identityKey: 'identity-1', channel: 'feishu', ownerId: 'owner' }, ttlMs: 10_000 })).resolves.toMatchObject({ kind })
    expect(admission.defer).not.toHaveBeenCalled()
  })

  it('falls back fail-closed when persistence fails, with no deferred result or dispatch', async () => {
    const admission = { defer: vi.fn(async () => { throw new Error('disk unavailable') }) }
    const fallback = vi.fn(async () => ({ kind: 'rejected', cause: 'unavailable' }))
    const dispatch = vi.fn()
    const adapter = createDeferredApprovalAdapter({ admission, dispatch, fallback })
    await expect(adapter.resolve({
      approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } },
      eligibility: { kind: 'eligible', todoId: 'todo-1' }, todo: { todoId: 'todo-1', invocationId: 'inv-1', reservationId: 'res-1', originSessionId: 'session-1', identityKey: 'identity-1', channel: 'feishu', ownerId: 'owner' }, ttlMs: 10_000
    })).resolves.toEqual({ kind: 'rejected', cause: 'unavailable' })
    expect(fallback).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
