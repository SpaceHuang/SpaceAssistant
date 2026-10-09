import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSecurityActionIntentStore } from './securityActionIntentStore'
import { recoverSecurityActionIntents } from './securityActionIntentRecovery'

describe('security action intent crash recovery', () => {
  it('links one persisted todo, commits its checkpoint once, and safely invalidates orphaned work', async () => {
    const db = createMemoryAppDb()
    const intentStore = createSecurityActionIntentStore(db)
    const binding = {
      invocationId: 'recovery-invocation-1', sessionId: 'origin-session', workflowId: 'workflow-1',
      taskId: 'task-1', stepId: 'step-1', planRevision: 3, envelopeInvocationId: 'recovery-invocation-1'
    }
    intentStore.prepare(binding)
    const todos = new Map([['recovery-invocation-1', {
      todoId: 'recovery-todo-1', invocationId: 'recovery-invocation-1', sessionId: 'origin-session',
      workflowId: 'workflow-1', taskId: 'task-1', stepId: 'step-1', planRevision: 3
    }]])
    const checkpoints = new Map([['recovery-invocation-1', {
      checkpointId: 'checkpoint-1', workflowRevision: 4, sessionId: 'origin-session', workflowId: 'workflow-1',
      taskId: 'task-1', stepId: 'step-1', planRevision: 3
    }]])
    const invalidated: string[] = []
    const dependencies = {
      intentStore,
      todos: {
        findByInvocation: async (invocationId: string) => todos.get(invocationId) ?? null,
        invalidate: async (todoId: string) => { invalidated.push(todoId) }
      },
      checkpoints: { findByInvocation: async (invocationId: string) => checkpoints.get(invocationId) ?? null }
    }

    expect(await recoverSecurityActionIntents(dependencies)).toMatchObject({ linked: 1, checkpointCommitted: 1, invalidated: 0 })
    expect(await recoverSecurityActionIntents(dependencies)).toMatchObject({ linked: 0, checkpointCommitted: 0, invalidated: 0 })
    expect(intentStore.get(binding.invocationId)).toMatchObject({ state: 'checkpoint_committed', todoId: 'recovery-todo-1' })
    expect(intentStore.listOutbox(binding.invocationId)).toEqual([
      { action: 'commit_checkpoint', state: 'applied' }, { action: 'link_todo', state: 'applied' }
    ])
    expect(invalidated).toEqual([])

    intentStore.prepare({ ...binding, invocationId: 'orphan-invocation', envelopeInvocationId: 'orphan-invocation' })
    intentStore.linkTodo('orphan-invocation', 'orphan-todo')
    todos.set('orphan-invocation', {
      todoId: 'orphan-todo', invocationId: 'orphan-invocation', sessionId: 'origin-session',
      workflowId: 'workflow-1', taskId: 'task-1', stepId: 'step-1', planRevision: 3
    })
    expect(await recoverSecurityActionIntents(dependencies)).toMatchObject({ invalidated: 1 })
    expect(invalidated).toEqual(['orphan-todo'])
    expect(intentStore.authorizeDispatch('orphan-invocation')).toBe(false)
    expect(intentStore.listOutbox('orphan-invocation')).toEqual([
      { action: 'commit_checkpoint', state: 'discarded' }, { action: 'link_todo', state: 'applied' }
    ])
    expect(await recoverSecurityActionIntents(dependencies)).toMatchObject({ scanned: 0 })
    db.close()
  })
})
