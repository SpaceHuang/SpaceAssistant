export type DeferredTodoStatus = 'pending' | 'dispatching' | 'consumed' | 'invalidated' | 'expired'

/** Trusted identity and lifecycle contract for a resumable safety approval. */
export type DeferredTodo = {
  todoId: string
  /** Optional on legacy rows; new Track-routed remote approvals persist it. */
  trackId?: string
  invocationId: string
  workflowId: string
  taskId: string
  stepId: string
  planRevision: number
  originSessionId: string
  /** Shared IM policy fence captured when the approval todo was created. Legacy rows omit it and fail closed on resume. */
  policyBehaviorVersion?: string
  policyRevision?: number
  policyEpoch?: number
  status: DeferredTodoStatus
}
