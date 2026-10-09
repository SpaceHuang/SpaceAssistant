import { randomUUID } from 'node:crypto'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { buildDeferredApprovalAuditEvent } from './deferredApprovalAudit'
import { appendWakeEvent } from '../database/wakeEvents'

export type DeferredExecutionState = 'dispatching' | 'completion_outboxed' | 'delivered' | 'outcome_unknown'
export type DeferredExecutionResult = {
  todoId: string
  invocationId: string
  dispatchKey: string
  state: DeferredExecutionState
  result: Record<string, unknown> | null
  dispatchStartedAt: number
  updatedAt: number
}

type ResultRow = {
  todo_id: string; invocation_id: string; dispatch_key: string; state: DeferredExecutionState
  result_json: string | null; dispatch_started_at: number; updated_at: number
}
type OutboxRow = {
  outbox_id: string; todo_id: string; invocation_id: string; dispatch_key: string; result_json: string
  state: 'pending' | 'delivered'; created_at: number; updated_at: number
}

function rowToResult(row: ResultRow): DeferredExecutionResult {
  return {
    todoId: row.todo_id, invocationId: row.invocation_id, dispatchKey: row.dispatch_key, state: row.state,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as Record<string, unknown>,
    dispatchStartedAt: row.dispatch_started_at, updatedAt: row.updated_at
  }
}

export function createDeferredExecutionResultStore(db: AppDatabase, options: { audit?: (event: SecurityAuditEvent) => void } = {}) {
  const conn = getDbConnection(db)

  function getByTodo(todoId: string): DeferredExecutionResult | null {
    const row = conn.prepare(`SELECT todo_id,invocation_id,dispatch_key,state,result_json,dispatch_started_at,updated_at
      FROM deferred_execution_results WHERE todo_id=?`).get(todoId) as ResultRow | undefined
    return row ? rowToResult(row) : null
  }

  function outboxForTodo(todoId: string): OutboxRow[] {
    return conn.prepare(`SELECT outbox_id,todo_id,invocation_id,dispatch_key,result_json,state,created_at,updated_at
      FROM deferred_completion_outbox WHERE todo_id=? ORDER BY created_at,outbox_id`).all(todoId) as OutboxRow[]
  }

  function persistResult(todoId: string, result: Record<string, unknown>, now: number): { result: DeferredExecutionResult; duplicate: boolean } {
    const persisted = runInTransaction(conn, () => {
      const current = getByTodo(todoId)
      if (!current) throw new Error('DEFERRED_EXECUTION_NOT_FOUND')
      if (current.state === 'outcome_unknown') throw new Error('DEFERRED_EXECUTION_OUTCOME_UNKNOWN')
      if (current.state === 'completion_outboxed' || current.state === 'delivered') {
        return { result: current, duplicate: true }
      }
      const resultJson = JSON.stringify(result)
      conn.prepare(`UPDATE deferred_execution_results SET state='completion_outboxed',result_json=?,updated_at=?
        WHERE todo_id=? AND state='dispatching'`).run(resultJson, now, todoId)
      conn.prepare(`INSERT OR IGNORE INTO deferred_completion_outbox(
        outbox_id,todo_id,invocation_id,dispatch_key,result_json,state,created_at,updated_at
      ) SELECT ?,todo_id,invocation_id,dispatch_key,?,'pending',?,? FROM deferred_execution_results WHERE todo_id=?`)
        .run(randomUUID(), resultJson, now, now, todoId)
      const todo = conn.prepare('SELECT origin_session_id FROM deferred_todos WHERE todo_id=?').get(todoId) as { origin_session_id: string } | undefined
      if (todo?.origin_session_id) appendWakeEvent(db, { sessionId: todo.origin_session_id, type: 'safety-recovery',
        reasonKey: `deferred-completion:${current.dispatchKey}`, payloadRef: { kind: 'safety-approval', approvalId: todoId } })
      db.save()
      return { result: getByTodo(todoId)!, duplicate: false }
    })
    if (!persisted.duplicate) {
      const context = conn.prepare(`SELECT channel,origin_session_id FROM deferred_todos WHERE todo_id=?`)
        .get(todoId) as { channel: 'feishu' | 'wechat'; origin_session_id: string } | undefined
      if (context) options.audit?.(buildDeferredApprovalAuditEvent({
        kind: 'result', lane: context.channel, sessionId: context.origin_session_id, todoId,
        invocationId: persisted.result.invocationId,
        executionState: result.kind === 'completed' ? 'completed' : result.kind === 'failed' ? 'failed' : 'outcome_unknown', ts: now
      }))
    }
    return persisted
  }

  return {
    beginDispatch(input: { todoId: string; invocationId: string; dispatchKey: string; now?: number }):
      { ok: true; state: 'dispatching' } | { ok: false; reason: 'already_started' | 'outcome_unknown' | 'binding_conflict' } {
      if (![input.todoId, input.invocationId, input.dispatchKey].every((value) => value.trim())) {
        throw new TypeError('DEFERRED_EXECUTION_IDENTITY_REQUIRED')
      }
      const now = input.now ?? Date.now()
      return runInTransaction(conn, () => {
        const existing = conn.prepare(`SELECT todo_id,invocation_id,dispatch_key,state FROM deferred_execution_results
          WHERE todo_id=? OR invocation_id=? OR dispatch_key=?`).get(input.todoId, input.invocationId, input.dispatchKey) as
          { todo_id: string; invocation_id: string; dispatch_key: string; state: DeferredExecutionState } | undefined
        if (existing) {
          if (existing.todo_id !== input.todoId || existing.invocation_id !== input.invocationId || existing.dispatch_key !== input.dispatchKey) {
            return { ok: false, reason: 'binding_conflict' }
          }
          return existing.state === 'outcome_unknown'
            ? { ok: false, reason: 'outcome_unknown' }
            : { ok: false, reason: 'already_started' }
        }
        conn.prepare(`INSERT INTO deferred_execution_results(todo_id,invocation_id,dispatch_key,state,result_json,dispatch_started_at,updated_at)
          VALUES(?,?,?,'dispatching',NULL,?,?)`).run(input.todoId, input.invocationId, input.dispatchKey, now, now)
        db.save()
        return { ok: true, state: 'dispatching' }
      })
    },

    commitResult(todoId: string, result: Record<string, unknown>, now = Date.now()): DeferredExecutionResult {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('DEFERRED_EXECUTION_RESULT_INVALID')
      return persistResult(todoId, structuredClone(result), now).result
    },

    async recover(dispatchKey: string, queryResult: (key: string) => Promise<
      { status: 'found'; dispatchKey: string; result: Record<string, unknown> } | { status: 'unknown' }
    >): Promise<{ state: DeferredExecutionState; duplicate?: boolean; replayAllowed?: boolean }> {
      const row = conn.prepare(`SELECT todo_id,invocation_id,dispatch_key,state,result_json,dispatch_started_at,updated_at
        FROM deferred_execution_results WHERE dispatch_key=?`).get(dispatchKey) as ResultRow | undefined
      if (!row) return { state: 'outcome_unknown', replayAllowed: false }
      const current = rowToResult(row)
      if (current.state === 'outcome_unknown') return { state: current.state, replayAllowed: false }
      if (current.state === 'completion_outboxed' || current.state === 'delivered') {
        return { state: current.state, duplicate: true }
      }
      const queried = await queryResult(dispatchKey)
      if (queried.status === 'found' && queried.dispatchKey === dispatchKey) {
        const committed = persistResult(current.todoId, queried.result, Date.now())
        return { state: committed.result.state, ...(committed.duplicate ? { duplicate: true } : {}) }
      }
      conn.prepare("UPDATE deferred_execution_results SET state='outcome_unknown',updated_at=? WHERE todo_id=? AND state='dispatching'")
        .run(Date.now(), current.todoId)
      db.save()
      return { state: 'outcome_unknown', replayAllowed: false }
    },

    markCompletionDelivered(todoId: string, now = Date.now()): boolean {
      return runInTransaction(conn, () => {
        const outbox = outboxForTodo(todoId).find((item) => item.state === 'pending')
        if (!outbox) return outboxForTodo(todoId).some((item) => item.state === 'delivered')
        const changed = conn.prepare("UPDATE deferred_completion_outbox SET state='delivered',updated_at=? WHERE outbox_id=? AND state='pending'")
          .run(now, outbox.outbox_id)
        if (Number(changed.changes) !== 1) return false
        conn.prepare("UPDATE deferred_execution_results SET state='delivered',updated_at=? WHERE todo_id=? AND state='completion_outboxed'")
          .run(now, todoId)
        db.save()
        return true
      })
    },

    markOutcomeUnknown(todoId: string, now = Date.now()): boolean {
      const changed = conn.prepare("UPDATE deferred_execution_results SET state='outcome_unknown',updated_at=? WHERE todo_id=? AND state='dispatching'")
        .run(now, todoId)
      if (Number(changed.changes) === 1) db.save()
      return Number(changed.changes) === 1
    },

    getByTodo,

    listCompletionOutbox(todoId: string): Array<{ state: 'pending' | 'delivered'; result: Record<string, unknown>; dispatchKey: string }> {
      return outboxForTodo(todoId).map((row) => ({
        state: row.state, result: JSON.parse(row.result_json) as Record<string, unknown>, dispatchKey: row.dispatch_key
      }))
    },
    listRecoverableSessionIds(channel: 'feishu' | 'wechat'): string[] {
      return (conn.prepare(`SELECT DISTINCT t.origin_session_id AS session_id FROM deferred_todos t
        JOIN deferred_execution_results r ON r.todo_id=t.todo_id JOIN deferred_completion_outbox o ON o.todo_id=t.todo_id
        WHERE t.channel=? AND r.state IN ('completion_outboxed','delivered') AND o.state IN ('pending','delivered')
        ORDER BY t.origin_session_id`).all(channel) as Array<{ session_id: string }>).map(({ session_id }) => session_id)
    },
  }
}
