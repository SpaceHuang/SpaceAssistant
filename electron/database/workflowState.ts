import { getDbConnection, type AppDatabase } from './sqliteStore'
import { runInTransaction } from './transaction'

export type WorkflowState = {
  sessionId: string
  workflowId: string
  version: number
  revision: number
  data: Record<string, unknown>
  updatedAt: number
}

export type PutWorkflowStateResult =
  | { ok: true; state: WorkflowState }
  | { ok: false; error: 'revision_conflict'; current: WorkflowState | null }

type WorkflowStateRow = {
  session_id: string
  workflow_id: string
  version: number
  revision: number
  data_json: string
  updated_at: number
}

function rowToState(row: WorkflowStateRow): WorkflowState {
  return {
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    version: row.version,
    revision: row.revision,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    updatedAt: row.updated_at
  }
}

export function getWorkflowState(
  db: AppDatabase,
  input: { sessionId: string; workflowId: string; version?: number }
): WorkflowState | null {
  const row = getDbConnection(db).prepare(`SELECT session_id,workflow_id,version,revision,data_json,updated_at
    FROM im_workflow_state WHERE session_id=? AND workflow_id=? AND version=?`)
    .get(input.sessionId, input.workflowId, input.version ?? 1) as WorkflowStateRow | undefined
  return row ? rowToState(row) : null
}

export function putWorkflowState(
  db: AppDatabase,
  input: {
    sessionId: string
    workflowId: string
    version?: number
    expectedRevision: number | null
    data: Record<string, unknown>
    now?: number
  }
): PutWorkflowStateResult {
  if (!input.sessionId.trim() || !input.workflowId.trim()) throw new TypeError('Workflow state identity is required')
  if (!Number.isInteger(input.expectedRevision) && input.expectedRevision !== null) {
    throw new TypeError('expectedRevision must be an integer or null')
  }
  const version = input.version ?? 1
  if (!Number.isInteger(version) || version <= 0) throw new TypeError('Workflow version must be a positive integer')
  const now = input.now ?? Date.now()
  const dataJson = JSON.stringify(input.data)

  return runInTransaction(getDbConnection(db), () => {
    const current = getWorkflowState(db, { sessionId: input.sessionId, workflowId: input.workflowId, version })
    if ((current?.revision ?? null) !== input.expectedRevision) {
      return { ok: false, error: 'revision_conflict', current }
    }
    const revision = (current?.revision ?? 0) + 1
    getDbConnection(db).prepare(`INSERT INTO im_workflow_state(session_id,workflow_id,version,revision,data_json,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,workflow_id,version) DO UPDATE SET
        revision=excluded.revision,data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(input.sessionId, input.workflowId, version, revision, dataJson, now)
    db.save()
    return {
      ok: true,
      state: { sessionId: input.sessionId, workflowId: input.workflowId, version, revision, data: input.data, updatedAt: now }
    }
  })
}
