export type DeferredTodoStatus = 'pending' | 'dispatching' | 'consumed' | 'invalidated' | 'expired'

/** Trusted identity and lifecycle contract for a resumable safety approval. */
export type DeferredTodo = {
  todoId: string
  invocationId: string
  workflowId: string
  taskId: string
  stepId: string
  planRevision: number
  originSessionId: string
  status: DeferredTodoStatus
}
