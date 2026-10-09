import { randomUUID } from 'node:crypto'
import type { DeferredTodo, DeferredTodoStatus } from '../../src/shared/confirmation/deferredTodo'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import type { DeferredTodoCapacityLifecycle } from './deferredTodoCapacity'

export const DEFAULT_DEFERRED_TODO_TTL_MS = 24 * 60 * 60_000

export type DeferredTodoRecord = DeferredTodo & {
  channel: 'feishu' | 'wechat'
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rule: { ruleId: string; factsHash: string }
  createdAt: number
  expiresAt: number
  updatedAt: number
}

export type DeferredTodoAuthorization = {
  channel: 'feishu' | 'wechat'
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rule: { ruleId: string; factsHash: string }
}

export type CreateDeferredTodoInput = Omit<DeferredTodoRecord, 'todoId' | 'status' | 'expiresAt' | 'updatedAt'> & {
  todoId?: string
  status?: 'pending'
  expiresAt?: number
  ttlMs?: number
  updatedAt?: number
}

type TodoRow = {
  todo_id: string; invocation_id: string; channel: 'feishu' | 'wechat'; identity_key: string; owner_id: string
  authorization_epoch: number; rule_id: string; facts_hash: string; workflow_id: string; task_id: string; step_id: string
  plan_revision: number; origin_session_id: string; state: DeferredTodoStatus; created_at: number; expires_at: number; updated_at: number
}

function rowToTodo(row: TodoRow): DeferredTodoRecord {
  return {
    todoId: row.todo_id, invocationId: row.invocation_id, channel: row.channel, identityKey: row.identity_key,
    ownerId: row.owner_id, authorizationEpoch: row.authorization_epoch, rule: { ruleId: row.rule_id, factsHash: row.facts_hash },
    workflowId: row.workflow_id, taskId: row.task_id, stepId: row.step_id, planRevision: row.plan_revision,
    originSessionId: row.origin_session_id, status: row.state, createdAt: row.created_at, expiresAt: row.expires_at,
    updatedAt: row.updated_at
  }
}

const TODO_COLUMNS = `todo_id,invocation_id,channel,identity_key,owner_id,authorization_epoch,rule_id,facts_hash,
  workflow_id,task_id,step_id,plan_revision,origin_session_id,state,created_at,expires_at,updated_at`

function isAuthorized(todo: DeferredTodoRecord, context: DeferredTodoAuthorization): boolean {
  return todo.channel === context.channel && todo.identityKey === context.identityKey && todo.ownerId === context.ownerId
    && todo.authorizationEpoch === context.authorizationEpoch && todo.rule.ruleId === context.rule.ruleId
    && todo.rule.factsHash === context.rule.factsHash
}

function validateCreate(input: CreateDeferredTodoInput, expiresAt: number): void {
  const required = [input.todoId, input.invocationId, input.identityKey, input.ownerId, input.rule.ruleId, input.rule.factsHash,
    input.workflowId, input.taskId, input.stepId, input.originSessionId]
  if (required.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new TypeError('DEFERRED_TODO_IDENTITY_REQUIRED')
  }
  if (!Number.isInteger(input.authorizationEpoch) || input.authorizationEpoch <= 0) {
    throw new TypeError('DEFERRED_TODO_AUTHORIZATION_EPOCH_REQUIRED')
  }
  if (!Number.isInteger(input.planRevision) || input.planRevision <= 0) throw new TypeError('DEFERRED_TODO_PLAN_REVISION_REQUIRED')
  if (input.status !== undefined && input.status !== 'pending') throw new TypeError('DEFERRED_TODO_MUST_START_PENDING')
  if (!Number.isFinite(input.createdAt) || !Number.isFinite(expiresAt) || expiresAt <= input.createdAt) {
    throw new TypeError('DEFERRED_TODO_TTL_INVALID')
  }
}

export function createDeferredTodoStore(db: AppDatabase, options: { capacity?: DeferredTodoCapacityLifecycle } = {}) {
  const conn = getDbConnection(db)

  function find(todoId: string): DeferredTodoRecord | null {
    const row = conn.prepare(`SELECT ${TODO_COLUMNS} FROM deferred_todos WHERE todo_id=?`).get(todoId) as TodoRow | undefined
    return row ? rowToTodo(row) : null
  }

  function findByInvocation(invocationId: string): DeferredTodoRecord | null {
    const row = conn.prepare(`SELECT ${TODO_COLUMNS} FROM deferred_todos WHERE invocation_id=?`).get(invocationId) as TodoRow | undefined
    return row ? rowToTodo(row) : null
  }

  function isTaskControlRecoveryPending(todo: DeferredTodoRecord): boolean {
    const row = conn.prepare(`SELECT 1 FROM im_task_control_operations WHERE session_id=? AND owner_id=? AND workflow_id=? AND task_id=?
      AND state IN ('requested','reconciliation_required') LIMIT 1`)
      .get(todo.originSessionId, todo.ownerId, todo.workflowId, todo.taskId)
    return row !== undefined
  }

  function transition(todoId: string, from: DeferredTodoStatus, to: DeferredTodoStatus, now: number): boolean {
    const changed = conn.prepare('UPDATE deferred_todos SET state=?,updated_at=? WHERE todo_id=? AND state=?')
      .run(to, now, todoId, from)
    if (Number(changed.changes) === 1) {
      db.save()
      if (to === 'consumed' || to === 'invalidated' || to === 'expired') {
        const todo = find(todoId)
        if (todo) options.capacity?.releaseByInvocation(todo.invocationId, now)
      }
    }
    return Number(changed.changes) === 1
  }

  return {
    create(input: CreateDeferredTodoInput): { ok: true; todo: DeferredTodoRecord; duplicate: boolean } {
      const expiresAt = input.expiresAt ?? input.createdAt + (input.ttlMs ?? DEFAULT_DEFERRED_TODO_TTL_MS)
      validateCreate(input, expiresAt)
      const prior = findByInvocation(input.invocationId)
      if (prior) {
        const sameBinding = prior.channel === input.channel && prior.identityKey === input.identityKey && prior.ownerId === input.ownerId
          && prior.authorizationEpoch === input.authorizationEpoch && prior.rule.ruleId === input.rule.ruleId
          && prior.rule.factsHash === input.rule.factsHash && prior.workflowId === input.workflowId && prior.taskId === input.taskId
          && prior.stepId === input.stepId && prior.planRevision === input.planRevision && prior.originSessionId === input.originSessionId
        if (!sameBinding) throw new Error('DEFERRED_TODO_INVOCATION_BINDING_CONFLICT')
        return { ok: true, todo: prior, duplicate: true }
      }
      const todoId = input.todoId || randomUUID()
      const now = input.updatedAt ?? input.createdAt
      conn.prepare(`INSERT INTO deferred_todos(${TODO_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        todoId, input.invocationId, input.channel, input.identityKey, input.ownerId, input.authorizationEpoch,
        input.rule.ruleId, input.rule.factsHash, input.workflowId, input.taskId, input.stepId, input.planRevision,
        input.originSessionId, 'pending', input.createdAt, expiresAt, now
      )
      db.save()
      return { ok: true, todo: find(todoId)!, duplicate: false }
    },

    get(todoId: string, context: DeferredTodoAuthorization, now = Date.now()): DeferredTodoRecord | null {
      const todo = find(todoId)
      if (!todo || !isAuthorized(todo, context)) return null
      if (todo.status === 'pending' && todo.expiresAt <= now) transition(todoId, 'pending', 'expired', now)
      return find(todoId)
    },

    getByInvocation(invocationId: string, context: DeferredTodoAuthorization, now = Date.now()): DeferredTodoRecord | null {
      const todo = findByInvocation(invocationId)
      return todo ? this.get(todo.todoId, context, now) : null
    },

    claimForDispatch(todoId: string, context: DeferredTodoAuthorization, now = Date.now()): DeferredTodoRecord | null {
      return runInTransaction(conn, () => {
        const todo = this.get(todoId, context, now)
        if (!todo || todo.status !== 'pending') return null
        if (isTaskControlRecoveryPending(todo)) return null
        if (!transition(todoId, 'pending', 'dispatching', now)) return null
        return find(todoId)
      })
    },

    markConsumed(todoId: string, context: DeferredTodoAuthorization, now = Date.now()): boolean {
      const todo = this.get(todoId, context, now)
      if (!todo || todo.status !== 'dispatching') return false
      return transition(todoId, 'dispatching', 'consumed', now)
    },

    invalidate(todoId: string, now = Date.now()): boolean {
      return transition(todoId, 'pending', 'invalidated', now)
    },

    invalidateByScope(scope: { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; originSessionId: string }, now = Date.now()): { invalidatedTodoIds: string[]; dispatchingTodoIds: string[] } {
      return runInTransaction(conn, () => {
        const rows = conn.prepare(`SELECT todo_id,state FROM deferred_todos WHERE channel=? AND identity_key=? AND owner_id=?
          AND origin_session_id=? AND state IN ('pending','dispatching') ORDER BY created_at,todo_id`)
          .all(scope.channel, scope.identityKey, scope.ownerId, scope.originSessionId) as Array<{ todo_id: string; state: 'pending' | 'dispatching' }>
        const invalidatedTodoIds: string[] = []
        const dispatchingTodoIds: string[] = []
        for (const row of rows) {
          if (row.state === 'dispatching') dispatchingTodoIds.push(row.todo_id)
          else if (transition(row.todo_id, 'pending', 'invalidated', now)) invalidatedTodoIds.push(row.todo_id)
        }
        return { invalidatedTodoIds, dispatchingTodoIds }
      })
    },

    invalidateAssociated(input: {
      originSessionId: string; workflowId: string; taskId: string; throughPlanRevision: number; now?: number
    }): { invalidatedTodoIds: string[]; dispatchingTodoIds: string[] } {
      const now = input.now ?? Date.now()
      return runInTransaction(conn, () => {
        const rows = conn.prepare(`SELECT ${TODO_COLUMNS} FROM deferred_todos WHERE origin_session_id=? AND workflow_id=? AND task_id=?
          AND plan_revision<=? AND state IN ('pending','dispatching') ORDER BY created_at,todo_id`)
          .all(input.originSessionId, input.workflowId, input.taskId, input.throughPlanRevision) as TodoRow[]
        const invalidatedTodoIds: string[] = []
        const dispatchingTodoIds: string[] = []
        for (const row of rows) {
          if (row.state === 'dispatching') {
            dispatchingTodoIds.push(row.todo_id)
          } else if (transition(row.todo_id, 'pending', 'invalidated', now)) {
            invalidatedTodoIds.push(row.todo_id)
          }
        }
        return { invalidatedTodoIds, dispatchingTodoIds }
      })
    },

    invalidateOlderAuthorizationEpochs(channel: 'feishu' | 'wechat', currentEpoch: number, now = Date.now()): { invalidatedTodoIds: string[]; dispatchingTodoIds: string[] } {
      if (!Number.isSafeInteger(currentEpoch) || currentEpoch <= 0) throw new TypeError('REMOTE_AUTHORIZATION_EPOCH_INVALID')
      return runInTransaction(conn, () => {
        const rows = conn.prepare(`SELECT ${TODO_COLUMNS} FROM deferred_todos WHERE channel=? AND authorization_epoch<?
          AND state IN ('pending','dispatching') ORDER BY created_at,todo_id`).all(channel, currentEpoch) as TodoRow[]
        const invalidatedTodoIds: string[] = []
        const dispatchingTodoIds: string[] = []
        for (const row of rows) {
          if (row.state === 'dispatching') dispatchingTodoIds.push(row.todo_id)
          else if (transition(row.todo_id, 'pending', 'invalidated', now)) invalidatedTodoIds.push(row.todo_id)
        }
        return { invalidatedTodoIds, dispatchingTodoIds }
      })
    },

    invalidateByOriginSession(originSessionId: string, now = Date.now()): { invalidatedTodoIds: string[]; dispatchingTodoIds: string[] } {
      if (!originSessionId.trim()) throw new TypeError('DEFERRED_TODO_SESSION_REQUIRED')
      return runInTransaction(conn, () => {
        const rows = conn.prepare(`SELECT ${TODO_COLUMNS} FROM deferred_todos WHERE origin_session_id=? AND state IN ('pending','dispatching') ORDER BY created_at,todo_id`)
          .all(originSessionId) as TodoRow[]
        const invalidatedTodoIds: string[] = []
        const dispatchingTodoIds: string[] = []
        for (const row of rows) {
          if (row.state === 'dispatching') dispatchingTodoIds.push(row.todo_id)
          else if (transition(row.todo_id, 'pending', 'invalidated', now)) invalidatedTodoIds.push(row.todo_id)
        }
        return { invalidatedTodoIds, dispatchingTodoIds }
      })
    },

    invalidateByInvocations(invocationIds: readonly string[], now = Date.now()): { invalidatedInvocationIds: string[]; dispatchingTodoIds: string[] } {
      const uniqueIds = [...new Set(invocationIds.filter((id) => typeof id === 'string' && id.trim()))]
      if (uniqueIds.length === 0) return { invalidatedInvocationIds: [], dispatchingTodoIds: [] }
      return runInTransaction(conn, () => {
        const placeholders = uniqueIds.map(() => '?').join(',')
        const rows = conn.prepare(`SELECT ${TODO_COLUMNS} FROM deferred_todos WHERE invocation_id IN (${placeholders}) AND state IN ('pending','dispatching') ORDER BY created_at,todo_id`)
          .all(...uniqueIds) as TodoRow[]
        const invalidatedInvocationIds: string[] = []
        const dispatchingTodoIds: string[] = []
        for (const row of rows) {
          if (row.state === 'dispatching') dispatchingTodoIds.push(row.todo_id)
          else if (transition(row.todo_id, 'pending', 'invalidated', now)) invalidatedInvocationIds.push(row.invocation_id)
        }
        return { invalidatedInvocationIds, dispatchingTodoIds }
      })
    },

    expireDue(now = Date.now()): number {
      const rows = conn.prepare(`SELECT todo_id FROM deferred_todos WHERE state='pending' AND expires_at<=?`).all(now) as Array<{ todo_id: string }>
      let expired = 0
      for (const row of rows) if (transition(row.todo_id, 'pending', 'expired', now)) expired += 1
      return expired
    },

    defaultExpiresAt(createdAt: number, ttlMs = DEFAULT_DEFERRED_TODO_TTL_MS): number {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('DEFERRED_TODO_TTL_INVALID')
      return createdAt + ttlMs
    }
  }
}
