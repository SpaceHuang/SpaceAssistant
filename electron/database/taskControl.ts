import { getDbConnection, type AppDatabase } from './sqliteStore'
import { runInTransaction } from './transaction'

export type TaskControlRecord = {
  sessionId: string
  ownerId: string
  workflowId: string
  taskId: string
  version: number
  planRevision: number
  revision: number
  controlState: 'active' | 'cancel_pending' | 'cancelled' | 'revise_pending'
  data: Record<string, unknown>
  updatedAt: number
}

export type PutTaskControlRecordResult =
  | { ok: true; record: TaskControlRecord }
  | { ok: false; error: 'revision_conflict'; current: TaskControlRecord | null }

export function mapTaskPlanRevision(input: {
  oldRevision: number
  newRevision: number
  oldSteps: Array<{ stepId: string; instruction: string }>
  newSteps: Array<{ stepId: string; instruction: string }>
  explicitStepMapping: Array<{ fromStepId: string; toStepId: string }>
  outstandingInvocations: Array<{ invocationId: string; stepId: string }>
}): {
  retained: Array<{ fromStepId: string; toStepId: string }>
  invalidatedInvocationIds: string[]
  oldRevision: number
  newRevision: number
} {
  const oldSteps = new Map(input.oldSteps.map((step) => [step.stepId, step]))
  const newSteps = new Map(input.newSteps.map((step) => [step.stepId, step]))
  const retained = input.explicitStepMapping.filter(({ fromStepId, toStepId }) => {
    const oldStep = oldSteps.get(fromStepId)
    const newStep = newSteps.get(toStepId)
    return Boolean(oldStep && newStep && oldStep.instruction === newStep.instruction)
  })
  const retainedOldIds = new Set(retained.map(({ fromStepId }) => fromStepId))
  return {
    retained,
    invalidatedInvocationIds: input.outstandingInvocations
      .filter(({ stepId }) => !retainedOldIds.has(stepId))
      .map(({ invocationId }) => invocationId),
    oldRevision: input.oldRevision,
    newRevision: input.newRevision
  }
}

type TaskControlRow = {
  session_id: string
  owner_id: string
  workflow_id: string
  task_id: string
  version: number
  plan_revision: number
  revision: number
  control_state: TaskControlRecord['controlState']
  data_json: string
  updated_at: number
}

function rowToRecord(row: TaskControlRow): TaskControlRecord {
  return {
    sessionId: row.session_id,
    ownerId: row.owner_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    version: row.version,
    planRevision: row.plan_revision,
    revision: row.revision,
    controlState: row.control_state,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    updatedAt: row.updated_at
  }
}

export function getTaskControlRecord(
  db: AppDatabase,
  input: { sessionId: string; ownerId: string; workflowId: string; taskId: string; version?: number }
): TaskControlRecord | null {
  const row = getDbConnection(db).prepare(`SELECT session_id,owner_id,workflow_id,task_id,version,plan_revision,revision,control_state,data_json,updated_at
    FROM im_task_control WHERE session_id=? AND owner_id=? AND workflow_id=? AND task_id=? AND version=?`)
    .get(input.sessionId, input.ownerId, input.workflowId, input.taskId, input.version ?? 1) as TaskControlRow | undefined
  return row ? rowToRecord(row) : null
}

export function putTaskControlRecord(
  db: AppDatabase,
  input: {
    sessionId: string
    ownerId: string
    workflowId: string
    taskId: string
    version?: number
    planRevision: number
    expectedRevision: number | null
    data: Record<string, unknown>
    now?: number
  }
): PutTaskControlRecordResult {
  if (!input.sessionId.trim() || !input.ownerId.trim() || !input.workflowId.trim() || !input.taskId.trim()) {
    throw new TypeError('Task control scope is required')
  }
  const version = input.version ?? 1
  if (!Number.isInteger(version) || version <= 0) throw new TypeError('Task control version must be a positive integer')
  if (!Number.isInteger(input.planRevision) || input.planRevision <= 0) throw new TypeError('Plan revision must be a positive integer')
  if (!Number.isInteger(input.expectedRevision) && input.expectedRevision !== null) {
    throw new TypeError('expectedRevision must be an integer or null')
  }
  const now = input.now ?? Date.now()
  const dataJson = JSON.stringify(input.data)
  const scope = { ...input, version }

  return runInTransaction(getDbConnection(db), () => {
    const current = getTaskControlRecord(db, scope)
    if ((current?.revision ?? null) !== input.expectedRevision) {
      return { ok: false, error: 'revision_conflict', current }
    }
    const revision = (current?.revision ?? 0) + 1
    getDbConnection(db).prepare(`INSERT INTO im_task_control(session_id,owner_id,workflow_id,task_id,version,plan_revision,revision,control_state,data_json,updated_at)
      VALUES(?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(session_id,owner_id,workflow_id,task_id,version) DO UPDATE SET
        plan_revision=excluded.plan_revision,revision=excluded.revision,control_state='active',data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(input.sessionId, input.ownerId, input.workflowId, input.taskId, version, input.planRevision, revision, dataJson, now)
    db.save()
    return {
      ok: true,
      record: {
        sessionId: input.sessionId, ownerId: input.ownerId, workflowId: input.workflowId, taskId: input.taskId,
        version, planRevision: input.planRevision, revision, controlState: 'active', data: input.data, updatedAt: now
      }
    }
  })
}

export function ensureImTurnTaskControl(db: AppDatabase, input: {
  sessionId: string; ownerId: string; requestId: string; userMessageId: string; now?: number
}): { ok: true; duplicate: boolean; taskBinding: { workflowId: string; taskId: string; stepId: string; planRevision: number; revision: number } }
  | { ok: false; error: 'identity_conflict' } {
  if (![input.sessionId, input.ownerId, input.requestId, input.userMessageId].every((value) => value.trim())) {
    throw new TypeError('IM_TURN_TASK_IDENTITY_REQUIRED')
  }
  const workflowId = `im:${input.requestId}`
  const taskId = `turn:${input.requestId}`
  const stepId = 'request'
  const current = getTaskControlRecord(db, { sessionId: input.sessionId, ownerId: input.ownerId, workflowId, taskId })
  if (current) {
    if (current.planRevision !== 1 || current.data.sourceUserMessageId !== input.userMessageId ||
      !Array.isArray(current.data.steps) || !(current.data.steps as Array<{ stepId?: unknown }>).some((step) => step.stepId === stepId)) {
      return { ok: false, error: 'identity_conflict' }
    }
    return { ok: true, duplicate: true, taskBinding: { workflowId, taskId, stepId, planRevision: current.planRevision, revision: current.revision } }
  }
  const created = putTaskControlRecord(db, {
    sessionId: input.sessionId, ownerId: input.ownerId, workflowId, taskId, planRevision: 1, expectedRevision: null,
    data: { status: 'active', sourceUserMessageId: input.userMessageId,
      steps: [{ stepId, instruction: 'Execute the authenticated inbound request' }], outstandingInvocations: [] }, now: input.now
  })
  if (!created.ok) {
    const raced = getTaskControlRecord(db, { sessionId: input.sessionId, ownerId: input.ownerId, workflowId, taskId })
    if (raced?.data.sourceUserMessageId === input.userMessageId && raced.planRevision === 1) {
      return { ok: true, duplicate: true, taskBinding: { workflowId, taskId, stepId, planRevision: raced.planRevision, revision: raced.revision } }
    }
    return { ok: false, error: 'identity_conflict' }
  }
  return { ok: true, duplicate: false, taskBinding: { workflowId, taskId, stepId, planRevision: 1, revision: created.record.revision } }
}

export type CommitDeferredTaskCheckpointResult =
  | { ok: true; record: TaskControlRecord; checkpoint: { checkpointId: string; workflowRevision: number }; duplicate: boolean }
  | { ok: false; error: 'not_found' | 'revision_conflict' | 'task_not_active' | 'step_not_found' | 'invocation_conflict' }

/** Atomically binds a deferred todo to the active task and persists its resumable checkpoint. */
export function commitDeferredTaskCheckpoint(db: AppDatabase, input: {
  sessionId: string; ownerId: string; workflowId: string; taskId: string; planRevision: number; expectedRevision: number
  invocationId: string; todoId: string; stepId: string; now?: number
}): CommitDeferredTaskCheckpointResult {
  if (![input.sessionId, input.ownerId, input.workflowId, input.taskId, input.invocationId, input.todoId, input.stepId]
    .every((value) => typeof value === 'string' && value.trim())) throw new TypeError('DEFERRED_TASK_CHECKPOINT_IDENTITY_REQUIRED')
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const current = getTaskControlRecord(db, input)
    if (!current) return { ok: false, error: 'not_found' }
    const invocations = Array.isArray(current.data.outstandingInvocations)
      ? current.data.outstandingInvocations as Array<{ invocationId?: unknown; todoId?: unknown; stepId?: unknown }> : []
    const existing = invocations.find((entry) => entry.invocationId === input.invocationId)
    const checkpoints = current.data.deferredCheckpoints && typeof current.data.deferredCheckpoints === 'object'
      ? current.data.deferredCheckpoints as Record<string, { todoId?: unknown; stepId?: unknown; checkpointId?: unknown; workflowRevision?: unknown }> : {}
    if (existing) {
      const checkpoint = checkpoints[input.invocationId]
      if (existing.todoId !== input.todoId || existing.stepId !== input.stepId || checkpoint?.todoId !== input.todoId ||
        typeof checkpoint.checkpointId !== 'string' || !Number.isInteger(checkpoint.workflowRevision)) {
        return { ok: false, error: 'invocation_conflict' }
      }
      return { ok: true, record: current, checkpoint: { checkpointId: checkpoint.checkpointId, workflowRevision: checkpoint.workflowRevision as number }, duplicate: true }
    }
    if (current.revision !== input.expectedRevision || current.planRevision !== input.planRevision) return { ok: false, error: 'revision_conflict' }
    if (current.controlState !== 'active' || current.data.status !== 'active') return { ok: false, error: 'task_not_active' }
    const steps = Array.isArray(current.data.steps) ? current.data.steps as Array<{ stepId?: unknown }> : []
    if (!steps.some((step) => step.stepId === input.stepId)) return { ok: false, error: 'step_not_found' }
    const revision = current.revision + 1
    const checkpoint = { checkpointId: `deferred:${input.invocationId}`, workflowRevision: revision }
    const data = {
      ...current.data,
      outstandingInvocations: [...invocations, { invocationId: input.invocationId, todoId: input.todoId, stepId: input.stepId }],
      deferredCheckpoints: { ...checkpoints, [input.invocationId]: { todoId: input.todoId, stepId: input.stepId, ...checkpoint } }
    }
    const changed = conn.prepare(`UPDATE im_task_control SET revision=?,data_json=?,updated_at=?
      WHERE session_id=? AND owner_id=? AND workflow_id=? AND task_id=? AND version=? AND revision=? AND plan_revision=? AND control_state='active'`)
      .run(revision, JSON.stringify(data), input.now ?? Date.now(), input.sessionId, input.ownerId, input.workflowId, input.taskId, current.version,
        current.revision, input.planRevision)
    if (Number(changed.changes) !== 1) return { ok: false, error: 'revision_conflict' }
    db.save()
    return { ok: true, record: { ...current, revision, data, updatedAt: input.now ?? Date.now() }, checkpoint, duplicate: false }
  })
}
