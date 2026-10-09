import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { getTaskControlRecord, mapTaskPlanRevision, putTaskControlRecord, type TaskControlRecord } from '../database/taskControl'

export interface ImTaskSafetyPort {
  invalidateTask(request: {
    operationId: string
    sessionId: string
    ownerId: string
    workflowId: string
    taskId: string
    planRevision: number
    invocationIds: string[]
  }): Promise<{ invalidated: string[] }>
  dispatchDeferred(request: {
    todoId: string
    sessionId: string
    ownerId: string
    workflowId: string
    taskId: string
    planRevision: number
  }): Promise<{ dispatched: boolean }>
}

type OperationType = 'cancel' | 'revise'
type OperationState = 'requested' | 'reconciliation_required' | 'applied'
type OperationRow = {
  operation_id: string; session_id: string; owner_id: string; workflow_id: string; task_id: string
  operation_type: OperationType; plan_revision: number; state: OperationState; payload_json: string
}
type Invocation = { invocationId: string; stepId: string; todoId?: string }
type PlanStep = { stepId: string; instruction: string }

function listInvocationIds(data: Record<string, unknown>): string[] {
  const invocations = Array.isArray(data.outstandingInvocations) ? data.outstandingInvocations as Invocation[] : []
  return invocations.map(({ invocationId }) => invocationId).filter((id) => typeof id === 'string')
}

function updateControlState(
  db: AppDatabase,
  record: TaskControlRecord,
  state: TaskControlRecord['controlState'],
  now: number
): void {
  getDbConnection(db).prepare(`UPDATE im_task_control SET control_state=?,updated_at=?
    WHERE session_id=? AND owner_id=? AND workflow_id=? AND task_id=? AND version=? AND revision=?`)
    .run(state, now, record.sessionId, record.ownerId, record.workflowId, record.taskId, record.version, record.revision)
  db.save()
}

function createOrGetOperation(db: AppDatabase, input: {
  operationId: string; record: TaskControlRecord; type: OperationType; planRevision: number; payload: Record<string, unknown>; now: number
}): OperationRow {
  const conn = getDbConnection(db)
  conn.prepare(`INSERT OR IGNORE INTO im_task_control_operations(
    operation_id,session_id,owner_id,workflow_id,task_id,operation_type,plan_revision,state,payload_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,'requested',?,?,?)`).run(
    input.operationId, input.record.sessionId, input.record.ownerId, input.record.workflowId, input.record.taskId,
    input.type, input.planRevision, JSON.stringify(input.payload), input.now, input.now
  )
  db.save()
  return conn.prepare('SELECT operation_id,session_id,owner_id,workflow_id,task_id,operation_type,plan_revision,state,payload_json FROM im_task_control_operations WHERE operation_id=?')
    .get(input.operationId) as OperationRow
}

function setOperationState(db: AppDatabase, operationId: string, state: OperationState, now: number): void {
  getDbConnection(db).prepare('UPDATE im_task_control_operations SET state=?,updated_at=? WHERE operation_id=?')
    .run(state, now, operationId)
  db.save()
}

function hasDispatchStarted(db: AppDatabase, record: TaskControlRecord): boolean {
  return getDbConnection(db).prepare(`SELECT 1 FROM im_task_control_dispatches
    WHERE session_id=? AND owner_id=? AND workflow_id=? AND task_id=? AND state IN ('dispatching','dispatched') LIMIT 1`)
    .get(record.sessionId, record.ownerId, record.workflowId, record.taskId) !== undefined
}

export function createImTaskControlCoordinator(input: { db: AppDatabase; safetyPort: ImTaskSafetyPort }) {
  const { db, safetyPort } = input

  async function applyOperation(operation: OperationRow): Promise<{ status: string; retainedStepIds?: string[] }> {
    const payload = JSON.parse(operation.payload_json) as Record<string, unknown>
    const now = Date.now()
    const record = getTaskControlRecord(db, {
      sessionId: operation.session_id, ownerId: operation.owner_id, workflowId: operation.workflow_id,
      taskId: operation.task_id, version: Number(payload.version ?? 1)
    })
    if (!record) return { status: 'not_found' }
    try {
      await safetyPort.invalidateTask({
        operationId: operation.operation_id,
        sessionId: record.sessionId,
        ownerId: record.ownerId,
        workflowId: record.workflowId,
        taskId: record.taskId,
        planRevision: operation.plan_revision,
        invocationIds: payload.invalidatedInvocationIds as string[]
      })
    } catch {
      setOperationState(db, operation.operation_id, 'reconciliation_required', now)
      return { status: 'reconciliation_required' }
    }

    if (operation.operation_type === 'cancel') {
      updateControlState(db, record, 'cancelled', now)
      setOperationState(db, operation.operation_id, 'applied', now)
      return { status: 'cancelled' }
    }

    const newRevision = Number(payload.newRevision)
    if (record.planRevision === newRevision && record.controlState === 'active') {
      setOperationState(db, operation.operation_id, 'applied', now)
      return { status: 'revised', retainedStepIds: (payload.retained as Array<{ toStepId: string }>).map(({ toStepId }) => toStepId) }
    }
    const newSteps = payload.newSteps as PlanStep[]
    const retained = payload.retained as Array<{ fromStepId: string; toStepId: string }>
    const invocations = Array.isArray(record.data.outstandingInvocations)
      ? record.data.outstandingInvocations as Invocation[] : []
    const retainedByOldId = new Map(retained.map(({ fromStepId, toStepId }) => [fromStepId, toStepId]))
    const nextInvocations = invocations
      .filter(({ invocationId }) => !(payload.invalidatedInvocationIds as string[]).includes(invocationId))
      .map((invocation) => ({ ...invocation, stepId: retainedByOldId.get(invocation.stepId) ?? invocation.stepId }))
    const updated = putTaskControlRecord(db, {
      sessionId: record.sessionId, ownerId: record.ownerId, workflowId: record.workflowId, taskId: record.taskId,
      version: record.version, planRevision: newRevision, expectedRevision: record.revision,
      data: { ...record.data, steps: newSteps, outstandingInvocations: nextInvocations }, now
    })
    if (!updated.ok) {
      setOperationState(db, operation.operation_id, 'reconciliation_required', now)
      return { status: 'reconciliation_required' }
    }
    setOperationState(db, operation.operation_id, 'applied', now)
    return { status: 'revised', retainedStepIds: retained.map(({ toStepId }) => toStepId) }
  }

  return {
    async cancel(request: {
      sessionId: string; ownerId: string; workflowId: string; taskId: string; expectedRevision: number; operationId?: string
    }) {
      const now = Date.now()
      const prepared = runInTransaction(getDbConnection(db), () => {
        const record = getTaskControlRecord(db, request)
        if (!record) return { result: { status: 'not_found' } as const }
        if (record.revision !== request.expectedRevision) return { result: { status: 'revision_conflict', current: record } as const }
        if (hasDispatchStarted(db, record)) return { result: { status: 'action_started' } as const }
        if (record.controlState === 'cancelled') return { result: { status: 'cancelled' } as const }
        const operationId = request.operationId ?? `cancel:${request.sessionId}:${request.workflowId}:${request.taskId}:${record.planRevision}`
        const operation = createOrGetOperation(db, {
          operationId, record, type: 'cancel', planRevision: record.planRevision,
          payload: { version: record.version, invalidatedInvocationIds: listInvocationIds(record.data) }, now
        })
        updateControlState(db, record, 'cancel_pending', now)
        return { operation }
      })
      if ('result' in prepared) return prepared.result
      return applyOperation(prepared.operation)
    },

    async revisePlan(request: {
      sessionId: string; ownerId: string; workflowId: string; taskId: string; expectedRevision: number; newRevision: number
      newSteps: PlanStep[]; stepMapping: Array<{ fromStepId: string; toStepId: string }>; operationId?: string
    }) {
      const now = Date.now()
      const prepared = runInTransaction(getDbConnection(db), () => {
        const record = getTaskControlRecord(db, request)
        if (!record) return { result: { status: 'not_found' } as const }
        if (record.revision !== request.expectedRevision) return { result: { status: 'revision_conflict', current: record } as const }
        if (hasDispatchStarted(db, record)) return { result: { status: 'action_started' } as const }
        if (request.newRevision <= record.planRevision) return { result: { status: 'invalid_revision' } as const }
        const oldSteps = Array.isArray(record.data.steps) ? record.data.steps as PlanStep[] : []
        const invocations = Array.isArray(record.data.outstandingInvocations) ? record.data.outstandingInvocations as Invocation[] : []
        const mapping = mapTaskPlanRevision({
          oldRevision: record.planRevision, newRevision: request.newRevision, oldSteps, newSteps: request.newSteps,
          explicitStepMapping: request.stepMapping, outstandingInvocations: invocations
        })
        const operationId = request.operationId ?? `revise:${request.sessionId}:${request.workflowId}:${request.taskId}:${request.newRevision}`
        const operation = createOrGetOperation(db, {
          operationId, record, type: 'revise', planRevision: record.planRevision,
          payload: {
            version: record.version, newRevision: request.newRevision, newSteps: request.newSteps,
            retained: mapping.retained, invalidatedInvocationIds: mapping.invalidatedInvocationIds
          }, now
        })
        updateControlState(db, record, 'revise_pending', now)
        return { operation }
      })
      if ('result' in prepared) return prepared.result
      return applyOperation(prepared.operation)
    },

    async resumeDeferred(request: {
      sessionId: string; ownerId: string; workflowId: string; taskId: string; planRevision: number; todoId: string
    }) {
      const record = getTaskControlRecord(db, request)
      if (!record) return { status: 'not_found' }
      if (record.controlState === 'cancelled' || record.planRevision !== request.planRevision) return { status: 'invalidated' }
      if (record.controlState !== 'active') return { status: 'blocked' }
      const outstanding = Array.isArray(record.data.outstandingInvocations) ? record.data.outstandingInvocations as Invocation[] : []
      const binding = outstanding.find((invocation) => invocation.todoId === request.todoId)
      if (!binding || !binding.invocationId.trim() || !binding.stepId.trim() ||
        !Array.isArray(record.data.steps) || !(record.data.steps as PlanStep[]).some((step) => step.stepId === binding.stepId)) {
        return { status: 'invalidated' }
      }
      const pending = getDbConnection(db).prepare(`SELECT 1 FROM im_task_control_operations
        WHERE session_id=? AND owner_id=? AND workflow_id=? AND task_id=? AND state<>'applied' LIMIT 1`)
        .get(record.sessionId, record.ownerId, record.workflowId, record.taskId)
      if (pending) return { status: 'blocked' }
      const conn = getDbConnection(db)
      const now = Date.now()
      const started = runInTransaction(conn, () => {
        const current = getTaskControlRecord(db, request)
        if (!current || current.controlState !== 'active' || current.planRevision !== request.planRevision) return false
        const inserted = conn.prepare(`INSERT OR IGNORE INTO im_task_control_dispatches(todo_id,session_id,owner_id,workflow_id,task_id,plan_revision,state,started_at,updated_at)
          VALUES(?,?,?,?,?,?,'dispatching',?,?)`).run(
          request.todoId, request.sessionId, request.ownerId, request.workflowId, request.taskId, request.planRevision, now, now
        )
        return Number(inserted.changes) === 1
      })
      if (!started) return { status: 'blocked' }
      const result = await safetyPort.dispatchDeferred(request)
      if (!result.dispatched) return { status: 'blocked' }
      conn.prepare("UPDATE im_task_control_dispatches SET state='dispatched',updated_at=? WHERE todo_id=? AND state='dispatching'")
        .run(Date.now(), request.todoId)
      db.save()
      return { status: 'dispatched' }
    },

    async retryOperation(operationId: string) {
      const operation = getDbConnection(db).prepare(`SELECT operation_id,session_id,owner_id,workflow_id,task_id,operation_type,plan_revision,state,payload_json
        FROM im_task_control_operations WHERE operation_id=?`).get(operationId) as OperationRow | undefined
      if (!operation) return { status: 'not_found' }
      if (operation.state === 'applied') return { status: operation.operation_type === 'cancel' ? 'cancelled' : 'revised' }
      return applyOperation(operation)
    },

    async recoverPendingOperations(): Promise<Array<{ operationId: string; status: string }>> {
      const operations = getDbConnection(db).prepare(`SELECT operation_id FROM im_task_control_operations
        WHERE state IN ('requested','reconciliation_required') ORDER BY created_at,operation_id`).all() as Array<{ operation_id: string }>
      const recovered: Array<{ operationId: string; status: string }> = []
      for (const operation of operations) {
        const result = await this.retryOperation(operation.operation_id)
        recovered.push({ operationId: operation.operation_id, status: result.status })
      }
      return recovered
    }
  }
}
