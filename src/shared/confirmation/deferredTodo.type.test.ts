import { describe, expectTypeOf, it } from 'vitest'
import type { DeferredTodo, DeferredTodoStatus } from './deferredTodo'

describe('DeferredTodo security identity type contract', () => {
  it('requires immutable workflow invocation binding and distinct lifecycle states', () => {
    expectTypeOf<DeferredTodo['invocationId']>().toEqualTypeOf<string>()
    expectTypeOf<DeferredTodo['workflowId']>().toEqualTypeOf<string>()
    expectTypeOf<DeferredTodo['taskId']>().toEqualTypeOf<string>()
    expectTypeOf<DeferredTodo['stepId']>().toEqualTypeOf<string>()
    expectTypeOf<DeferredTodo['planRevision']>().toEqualTypeOf<number>()
    expectTypeOf<DeferredTodo['originSessionId']>().toEqualTypeOf<string>()
    expectTypeOf<DeferredTodoStatus>().toEqualTypeOf<'pending' | 'dispatching' | 'consumed' | 'invalidated' | 'expired'>()

    const identity: Pick<DeferredTodo,
      'invocationId' | 'workflowId' | 'taskId' | 'stepId' | 'planRevision' | 'originSessionId'> = {
      invocationId: 'invocation-1', workflowId: 'workflow-1', taskId: 'task-1', stepId: 'step-1',
      planRevision: 2, originSessionId: 'session-origin'
    }
    const { originSessionId: _originSessionId, ...withoutOrigin } = identity
    // @ts-expect-error A deferred todo must carry the immutable origin session binding.
    const missingOrigin: DeferredTodo = { ...withoutOrigin, todoId: 'todo-1', status: 'pending' }
    // @ts-expect-error Lifecycle values are closed; arbitrary strings cannot authorize a transition.
    const invalidStatus: DeferredTodoStatus = 'approved'
    expectTypeOf<typeof missingOrigin>().toMatchTypeOf<DeferredTodo>()
    expectTypeOf<typeof invalidStatus>().toEqualTypeOf<DeferredTodoStatus>()
  })
})
