import { describe, expect, it, vi } from 'vitest'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalIngress } from './deferredApprovalIngress'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'
import { runImWorkflowSkillFlow } from './imWorkflowSkillHarness'

describe('IM end-to-end recovery acceptance', () => {
  it('persists a plan, waits with new inbox work, resumes the exact deferred call, and records completion once', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'full-im-recovery' }).id
    const plan = await runImWorkflowSkillFlow({ db, sessionId, workflowId: 'workflow', message: 'prepare and publish',
      model: { decide: async () => ({ kind: 'plan', summary: 'publish update', steps: ['prepare', 'publish'], assumptions: ['approval required'] }) } })
    expect(plan.kind).toBe('waiting-confirmation')

    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'publish-rule', factsHash: 'd'.repeat(64) }
    const todo = todoStore.create({ todoId: 'publish-todo', invocationId: 'publish-invocation', channel: 'feishu',
      identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2, rule, workflowId: 'workflow', taskId: 'task',
      stepId: 'publish', planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'publish-checkpoint', workflowRevision: plan.kind === 'waiting-confirmation' ? plan.state.revision : 1 })
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, toolName: 'publish_update', canonicalArgs: { documentId: 'doc-1', revision: 3 },
      contentVersions: { document: 3 }, executionContext: { sessionId, workflowId: 'workflow', taskId: 'task', stepId: 'publish' } })

    const dispatch = vi.fn(async (_request, _todo, envelope) => ({ dispatched: envelope.invocationId === todo.invocationId }))
    const coordinator = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, dispatch, maxParallel: 1, recheck: async () => ({ allowed: true }) })
    const ingress = createDeferredApprovalIngress({ db, isEnabled: () => true,
      resolveNotification: () => [{ channel: 'feishu', identityKey: 'user', ownerId: 'owner', todoId: todo.todoId,
        notificationVersion: 1, currentNotificationVersion: 1, trustedMessageId: 'notice-1', shortCode: '07', expiresAt: todo.expiresAt }],
      getTodo: (id) => { const record = todoStore.get(id, { channel: 'feishu', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2, rule });
        return record ? { ...record, status: record.status } : null },
      requestResume: (request) => coordinator.requestResume(request) })
    await expect(ingress.handle({ channel: 'feishu', identityKey: 'user', ownerId: 'owner', messageId: 'reply-1',
      replyToMessageId: 'notice-1', text: '批准 07' })).resolves.toMatchObject({ status: 'resume_requested' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await coordinator.dispatchPending(sessionId)).toMatchObject([{ status: 'dispatched' }])
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({ invocationId: 'publish-invocation', toolName: 'publish_update', canonicalArgs: { revision: 3 } })
    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2, rule })?.status).toBe('consumed')
    db.close()
  })
})
