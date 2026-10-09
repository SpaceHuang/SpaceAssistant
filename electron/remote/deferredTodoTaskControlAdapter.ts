import type { ImTaskSafetyPort } from './imTaskControlCoordinator'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'

type DeferredTodoStore = ReturnType<typeof createDeferredTodoStore>

/** Task-control outbox adapter backed by the durable deferred todo store. */
export function createDeferredTodoTaskControlSafetyPort(input: {
  todoStore: DeferredTodoStore
  dispatchDeferred: ImTaskSafetyPort['dispatchDeferred']
}): ImTaskSafetyPort {
  return {
    async invalidateTask(request) {
      const result = input.todoStore.invalidateByInvocations(request.invocationIds)
      if (result.dispatchingTodoIds.length) throw new Error('DEFERRED_TODO_DISPATCH_ALREADY_STARTED')
      return { invalidated: result.invalidatedInvocationIds }
    },
    dispatchDeferred: input.dispatchDeferred
  }
}

export function createDeferredTodoTaskInvalidator(todoStore: DeferredTodoStore): Pick<ImTaskSafetyPort, 'invalidateTask'> {
  return {
    async invalidateTask(request) {
      const result = todoStore.invalidateByInvocations(request.invocationIds)
      if (result.dispatchingTodoIds.length) throw new Error('DEFERRED_TODO_DISPATCH_ALREADY_STARTED')
      return { invalidated: result.invalidatedInvocationIds }
    }
  }
}
