import type { SecurityActionIntent, SecurityActionIntentState } from './securityActionIntentStore'

type RecoverableIntentStore = {
  listRecoverable(): SecurityActionIntent[]
  linkTodo(invocationId: string, todoId: string): SecurityActionIntent
  commitCheckpoint(invocationId: string, checkpoint: { checkpointId: string; workflowRevision: number }): SecurityActionIntent
  discardPendingOutbox(invocationId: string): void
}

type RecoveredTodo = {
  todoId: string
  invocationId: string
  sessionId: string
  workflowId: string
  taskId: string
  stepId: string
  planRevision: number
}

function matchesIntent(todo: RecoveredTodo, intent: SecurityActionIntent): boolean {
  return todo.invocationId === intent.invocationId && todo.sessionId === intent.sessionId
    && todo.workflowId === intent.workflowId && todo.taskId === intent.taskId
    && todo.stepId === intent.stepId && todo.planRevision === intent.planRevision
}

export async function recoverSecurityActionIntents(input: {
  intentStore: RecoverableIntentStore
  todos: {
    findByInvocation(invocationId: string): Promise<RecoveredTodo | null>
    invalidate(todoId: string): void | Promise<void>
  }
  checkpoints: {
    findByInvocation(invocationId: string): Promise<{
      checkpointId: string; workflowRevision: number; sessionId?: string; workflowId?: string; taskId?: string; stepId?: string; planRevision?: number
    } | null>
  }
}): Promise<{ scanned: number; linked: number; checkpointCommitted: number; invalidated: number }> {
  const intents = input.intentStore.listRecoverable()
  let linked = 0
  let checkpointCommitted = 0
  let invalidated = 0
  for (const initial of intents) {
    let intent: SecurityActionIntent = initial
    const todo = await input.todos.findByInvocation(intent.invocationId)
    if (!todo || !matchesIntent(todo, intent) || (intent.todoId !== null && intent.todoId !== todo.todoId)) {
      if (todo) await input.todos.invalidate(todo.todoId)
      input.intentStore.discardPendingOutbox(intent.invocationId)
      invalidated += 1
      continue
    }
    if (intent.state === 'prepared') {
      intent = input.intentStore.linkTodo(intent.invocationId, todo.todoId)
      linked += 1
    }
    const checkpoint = await input.checkpoints.findByInvocation(intent.invocationId)
    const checkpointMatches = Boolean(checkpoint
      && (checkpoint.sessionId === undefined || checkpoint.sessionId === intent.sessionId)
      && (checkpoint.workflowId === undefined || checkpoint.workflowId === intent.workflowId)
      && (checkpoint.taskId === undefined || checkpoint.taskId === intent.taskId)
      && (checkpoint.stepId === undefined || checkpoint.stepId === intent.stepId)
      && (checkpoint.planRevision === undefined || checkpoint.planRevision === intent.planRevision))
    if (!checkpoint || !checkpointMatches) {
      await input.todos.invalidate(todo.todoId)
      input.intentStore.discardPendingOutbox(intent.invocationId)
      invalidated += 1
      continue
    }
    if (intent.state === 'todo_linked') {
      input.intentStore.commitCheckpoint(intent.invocationId, checkpoint)
      checkpointCommitted += 1
    }
  }
  return { scanned: intents.length, linked, checkpointCommitted, invalidated }
}

export type SecurityActionIntentRecoveryState = SecurityActionIntentState
