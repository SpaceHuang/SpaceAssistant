import { describe, expect, it } from 'vitest'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { putTaskControlRecord } from '../database/taskControl'
import { runImWorkflowSkillFlow } from './imWorkflowSkillHarness'
import { createImTaskControlCoordinator } from './imTaskControlCoordinator'

describe('IM workflow task cancellation recovery', () => {
  it('does not execute an old deferred action after cancellation succeeds', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'workflow-cancel-deferred-e2e' }).id
    const flow = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'publish-project', message: 'Publish the project update',
      model: { decide: async () => ({
        kind: 'plan', summary: 'Prepare and publish update',
        steps: ['Draft update', 'Publish update'], assumptions: ['The user will approve publishing']
      }) }
    })
    expect(flow.kind).toBe('waiting-confirmation')
    if (flow.kind !== 'waiting-confirmation') throw new Error('Expected a persisted plan')

    putTaskControlRecord(db, {
      sessionId, ownerId: 'workflow-owner', workflowId: 'publish-project', taskId: 'publish-update',
      planRevision: Number(flow.state.data.planRevision), expectedRevision: null,
      data: {
        status: 'active', steps: [{ stepId: 'publish', instruction: 'Publish update' }],
        outstandingInvocations: [{ invocationId: 'publish-invocation', stepId: 'publish', todoId: 'publish-todo' }]
      }
    })
    let dispatchCalls = 0
    const coordinator = createImTaskControlCoordinator({
      db,
      safetyPort: {
        invalidateTask: async ({ invocationIds }) => ({ invalidated: invocationIds }),
        dispatchDeferred: async () => { dispatchCalls += 1; return { dispatched: true } }
      }
    })
    const cancelled = await coordinator.cancel({
      sessionId, ownerId: 'workflow-owner', workflowId: 'publish-project', taskId: 'publish-update', expectedRevision: 1
    })
    const staleReply = await coordinator.resumeDeferred({
      sessionId, ownerId: 'workflow-owner', workflowId: 'publish-project', taskId: 'publish-update',
      planRevision: Number(flow.state.data.planRevision), todoId: 'publish-todo'
    })

    expect(cancelled).toMatchObject({ status: 'cancelled' })
    expect(staleReply).toMatchObject({ status: 'invalidated' })
    expect(dispatchCalls).toBe(0)
    db.close()
  })
})
