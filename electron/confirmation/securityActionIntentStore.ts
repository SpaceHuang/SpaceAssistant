import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

export type SecurityActionIntentState = 'prepared' | 'todo_linked' | 'checkpoint_committed' | 'notified'

export type SecurityActionIntent = {
  invocationId: string
  sessionId: string
  workflowId: string
  taskId: string
  stepId: string
  planRevision: number
  envelopeInvocationId: string
  todoId: string | null
  checkpointId: string | null
  checkpointWorkflowRevision: number | null
  state: SecurityActionIntentState
  createdAt: number
  updatedAt: number
}

type IntentRow = {
  invocation_id: string; session_id: string; workflow_id: string; task_id: string; step_id: string
  plan_revision: number; envelope_invocation_id: string; todo_id: string | null; checkpoint_id: string | null
  checkpoint_workflow_revision: number | null; state: SecurityActionIntentState; created_at: number; updated_at: number
}

function rowToIntent(row: IntentRow): SecurityActionIntent {
  return {
    invocationId: row.invocation_id, sessionId: row.session_id, workflowId: row.workflow_id, taskId: row.task_id,
    stepId: row.step_id, planRevision: row.plan_revision, envelopeInvocationId: row.envelope_invocation_id,
    todoId: row.todo_id, checkpointId: row.checkpoint_id,
    checkpointWorkflowRevision: row.checkpoint_workflow_revision, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

const INTENT_COLUMNS = `invocation_id,session_id,workflow_id,task_id,step_id,plan_revision,envelope_invocation_id,
  todo_id,checkpoint_id,checkpoint_workflow_revision,state,created_at,updated_at`

export function createSecurityActionIntentStore(db: AppDatabase) {
  const conn = getDbConnection(db)
  const get = (invocationId: string): SecurityActionIntent | null => {
    const row = conn.prepare(`SELECT ${INTENT_COLUMNS} FROM security_action_intents WHERE invocation_id=?`)
      .get(invocationId) as IntentRow | undefined
    return row ? rowToIntent(row) : null
  }

  return {
    prepare(input: {
      invocationId: string; sessionId: string; workflowId: string; taskId: string; stepId: string
      planRevision: number; envelopeInvocationId: string; now?: number
    }): SecurityActionIntent {
      if (![input.invocationId, input.sessionId, input.workflowId, input.taskId, input.stepId, input.envelopeInvocationId].every((v) => v.trim())) {
        throw new TypeError('SECURITY_ACTION_INTENT_IDENTITY_REQUIRED')
      }
      if (input.invocationId !== input.envelopeInvocationId) throw new Error('SECURITY_ACTION_ENVELOPE_BINDING_MISMATCH')
      if (!Number.isInteger(input.planRevision) || input.planRevision <= 0) throw new TypeError('SECURITY_ACTION_PLAN_REVISION_INVALID')
      const now = input.now ?? Date.now()
      return runInTransaction(conn, () => {
        const existing = get(input.invocationId)
        if (existing) {
          const matches = existing.sessionId === input.sessionId && existing.workflowId === input.workflowId
            && existing.taskId === input.taskId && existing.stepId === input.stepId
            && existing.planRevision === input.planRevision && existing.envelopeInvocationId === input.envelopeInvocationId
          if (!matches) throw new Error('SECURITY_ACTION_INVOCATION_BINDING_CONFLICT')
          return existing
        }
        conn.prepare(`INSERT INTO security_action_intents(${INTENT_COLUMNS})
          VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,'prepared',?,?)`).run(
          input.invocationId, input.sessionId, input.workflowId, input.taskId, input.stepId,
          input.planRevision, input.envelopeInvocationId, now, now
        )
        conn.prepare(`INSERT OR IGNORE INTO security_action_intent_outbox(outbox_id,invocation_id,action,state,created_at,updated_at)
          VALUES(?,?,?,'pending',?,?)`).run(`${input.invocationId}:link_todo`, input.invocationId, 'link_todo', now, now)
        db.save()
        return get(input.invocationId)!
      })
    },

    linkTodo(invocationId: string, todoId: string, now = Date.now()): SecurityActionIntent {
      if (!todoId.trim()) throw new TypeError('SECURITY_ACTION_TODO_ID_REQUIRED')
      return runInTransaction(conn, () => {
        const current = get(invocationId)
        if (!current) throw new Error('SECURITY_ACTION_INTENT_NOT_FOUND')
        if (current.state === 'todo_linked' && current.todoId === todoId) return current
        if (current.state !== 'prepared') throw new Error('SECURITY_ACTION_INTENT_STATE_CONFLICT')
        conn.prepare("UPDATE security_action_intents SET todo_id=?,state='todo_linked',updated_at=? WHERE invocation_id=? AND state='prepared'")
          .run(todoId, now, invocationId)
        conn.prepare("UPDATE security_action_intent_outbox SET state='applied',updated_at=? WHERE invocation_id=? AND action='link_todo' AND state='pending'")
          .run(now, invocationId)
        conn.prepare(`INSERT OR IGNORE INTO security_action_intent_outbox(outbox_id,invocation_id,action,state,created_at,updated_at)
          VALUES(?,?,?,'pending',?,?)`).run(`${invocationId}:commit_checkpoint`, invocationId, 'commit_checkpoint', now, now)
        db.save()
        return get(invocationId)!
      })
    },

    commitCheckpoint(invocationId: string, checkpoint: { checkpointId: string; workflowRevision: number }, now = Date.now()): SecurityActionIntent {
      if (!checkpoint.checkpointId.trim() || !Number.isInteger(checkpoint.workflowRevision) || checkpoint.workflowRevision <= 0) {
        throw new TypeError('SECURITY_ACTION_CHECKPOINT_INVALID')
      }
      return runInTransaction(conn, () => {
        const current = get(invocationId)
        if (!current) throw new Error('SECURITY_ACTION_INTENT_NOT_FOUND')
        if (current.state === 'checkpoint_committed' && current.checkpointId === checkpoint.checkpointId
          && current.checkpointWorkflowRevision === checkpoint.workflowRevision) return current
        if (current.state !== 'todo_linked' || !current.todoId) throw new Error('SECURITY_ACTION_TODO_NOT_LINKED')
        conn.prepare(`UPDATE security_action_intents SET checkpoint_id=?,checkpoint_workflow_revision=?,state='checkpoint_committed',updated_at=?
          WHERE invocation_id=? AND state='todo_linked'`).run(checkpoint.checkpointId, checkpoint.workflowRevision, now, invocationId)
        conn.prepare("UPDATE security_action_intent_outbox SET state='applied',updated_at=? WHERE invocation_id=? AND action='commit_checkpoint' AND state='pending'")
          .run(now, invocationId)
        db.save()
        return get(invocationId)!
      })
    },

    markNotified(invocationId: string, now = Date.now()): { ok: true; intent: SecurityActionIntent } | { ok: false; reason: 'checkpoint_not_committed' } {
      return runInTransaction(conn, () => {
        const current = get(invocationId)
        if (!current || (current.state !== 'checkpoint_committed' && current.state !== 'notified')) {
          return { ok: false, reason: 'checkpoint_not_committed' }
        }
        if (current.state === 'checkpoint_committed') {
          conn.prepare("UPDATE security_action_intents SET state='notified',updated_at=? WHERE invocation_id=? AND state='checkpoint_committed'")
            .run(now, invocationId)
          db.save()
        }
        return { ok: true, intent: get(invocationId)! }
      })
    },

    authorizeResume(invocationId: string): boolean {
      const intent = get(invocationId)
      return Boolean(intent?.todoId && intent.checkpointId
        && (intent.state === 'checkpoint_committed' || intent.state === 'notified'))
    },

    authorizeDispatch(invocationId: string): boolean {
      return this.authorizeResume(invocationId)
    },

    listRecoverable(): SecurityActionIntent[] {
      return (conn.prepare(`SELECT ${INTENT_COLUMNS} FROM security_action_intents
        WHERE state IN ('prepared','todo_linked') AND EXISTS (
          SELECT 1 FROM security_action_intent_outbox o WHERE o.invocation_id=security_action_intents.invocation_id AND o.state='pending'
        ) ORDER BY created_at,invocation_id`).all() as IntentRow[]).map(rowToIntent)
    },

    discardPendingOutbox(invocationId: string, now = Date.now()): void {
      conn.prepare("UPDATE security_action_intent_outbox SET state='discarded',updated_at=? WHERE invocation_id=? AND state='pending'")
        .run(now, invocationId)
      db.save()
    },

    listOutbox(invocationId: string): Array<{ action: 'link_todo' | 'commit_checkpoint'; state: 'pending' | 'applied' | 'discarded' }> {
      return conn.prepare('SELECT action,state FROM security_action_intent_outbox WHERE invocation_id=? ORDER BY action')
        .all(invocationId) as Array<{ action: 'link_todo' | 'commit_checkpoint'; state: 'pending' | 'applied' | 'discarded' }>
    },

    get
  }
}
