import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'

export function readDeferredCompletionWake(db: AppDatabase, todoId: string) {
  const conn = getDbConnection(db)
  const todo = conn.prepare(`SELECT t.todo_id,t.invocation_id,t.channel,t.identity_key,t.owner_id,t.origin_session_id,t.workflow_id,t.task_id,t.step_id,t.plan_revision,t.state,
      i.checkpoint_id FROM deferred_todos t LEFT JOIN security_action_intents i ON i.invocation_id=t.invocation_id WHERE t.todo_id=?`).get(todoId) as {
    todo_id: string; invocation_id: string; channel: 'feishu' | 'wechat'; identity_key: string; owner_id: string
    origin_session_id: string; workflow_id: string; task_id: string; step_id: string; plan_revision: number; state: string; checkpoint_id: string | null
  } | undefined
  if (!todo) return null
  const execution = createDeferredExecutionResultStore(db).getByTodo(todoId)
  const completion = createDeferredExecutionResultStore(db).listCompletionOutbox(todoId).find(({ state }) => state === 'pending' || state === 'delivered')
  const envelope = createDeferredEnvelopeStore(db).get(todo.invocation_id)
  if (!execution || !completion || !envelope || execution.invocationId !== todo.invocation_id ||
    execution.dispatchKey !== completion.dispatchKey || execution.state === 'outcome_unknown' || execution.state === 'dispatching') return null
  return { todo, execution, completion, envelope }
}

export function markDeferredCompletionWakeDelivered(db: AppDatabase, todoId: string): boolean {
  return createDeferredExecutionResultStore(db).markCompletionDelivered(todoId)
}
