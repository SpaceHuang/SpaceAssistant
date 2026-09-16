import { randomUUID } from 'crypto'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'

/**
 * 管家任务存储（P4）：automation_tasks / automation_task_runs 两表的对外 API。
 * 表结构见 schema.ts MIGRATION_V15_BUTLER_TABLES_SQL。
 */

export type { AutomationTask, AutomationTaskInput, AutomationTaskSchedule, AutomationDeliveryPref, AutomationTaskRun, AutomationTaskRunStatus, AutomationTaskRunTrigger } from '../../src/shared/automationTaskTypes'
import type { AutomationTask, AutomationTaskInput, AutomationTaskSchedule, AutomationDeliveryPref, AutomationTaskRun, AutomationTaskRunStatus, AutomationTaskRunTrigger } from '../../src/shared/automationTaskTypes'

type TaskRow = {
  id: string
  name: string
  schedule_json: string
  prompt: string
  delivery_pref: string
  delivery_target: string | null
  model_override: string | null
  enabled: number
  created_at: number
  updated_at: number
  last_run_at: number | null
  next_run_at: number | null
}

type RunRow = {
  id: string
  task_id: string
  client_id: string
  trigger: string
  scheduled_for: number
  status: string
  error: string | null
  session_id: string | null
  result_summary: string | null
  usage_json: string | null
  delivery_status: string | null
  delivered_at: number | null
  created_at: number
  updated_at: number
}

function parseSchedule(raw: string): AutomationTaskSchedule {
  try {
    const parsed = JSON.parse(raw) as AutomationTaskSchedule
    if (parsed?.kind === 'interval' && typeof parsed.intervalMinutes === 'number') return parsed
    if (parsed?.kind === 'daily' && typeof parsed.time === 'string') return parsed
  } catch { /* fallthrough */ }
  return { kind: 'interval', intervalMinutes: 60 }
}

function normalizeDeliveryPref(value: string): AutomationDeliveryPref {
  return value === 'feishu' || value === 'wechat' || value === 'none' ? value : 'desktop'
}

function rowToTask(row: TaskRow): AutomationTask {
  return {
    id: row.id,
    name: row.name,
    schedule: parseSchedule(row.schedule_json),
    prompt: row.prompt,
    deliveryPref: normalizeDeliveryPref(row.delivery_pref),
    ...(row.delivery_target ? { deliveryTarget: row.delivery_target } : {}),
    ...(row.model_override ? { modelOverride: row.model_override } : {}),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_run_at != null ? { lastRunAt: row.last_run_at } : {}),
    ...(row.next_run_at != null ? { nextRunAt: row.next_run_at } : {})
  }
}

function rowToRun(row: RunRow): AutomationTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    clientId: row.client_id,
    trigger: row.trigger === 'manual' ? 'manual' : 'schedule',
    scheduledFor: row.scheduled_for,
    status: (['queued', 'running', 'completed', 'failed', 'skipped', 'interrupted'] as const).includes(row.status as AutomationTaskRunStatus)
      ? (row.status as AutomationTaskRunStatus)
      : 'failed',
    ...(row.error ? { error: row.error } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    ...(row.usage_json ? { usageJson: row.usage_json } : {}),
    deliveryStatus: row.delivery_status === 'delivered' || row.delivery_status === 'failed-degraded' || row.delivery_status === 'none'
      ? row.delivery_status
      : 'pending',
    ...(row.delivered_at != null ? { deliveredAt: row.delivered_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createAutomationTask(db: AppDatabase, input: AutomationTaskInput): AutomationTask {
  const now = Date.now()
  const id = randomUUID()
  const conn = getDbConnection(db)
  conn
    .prepare(
      `INSERT INTO automation_tasks (
        id, name, schedule_json, prompt, delivery_pref, delivery_target, model_override,
        enabled, created_at, updated_at, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      JSON.stringify(input.schedule),
      input.prompt,
      input.deliveryPref,
      input.deliveryTarget ?? null,
      input.modelOverride ?? null,
      input.enabled === false ? 0 : 1,
      now,
      now,
      input.nextRunAt ?? null
    )
  db.save()
  return getAutomationTask(db, id)!
}

export function getAutomationTask(db: AppDatabase, taskId: string): AutomationTask | undefined {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  return row ? rowToTask(row) : undefined
}

export function listAutomationTasks(db: AppDatabase): AutomationTask[] {
  const conn = getDbConnection(db)
  const rows = conn.prepare('SELECT * FROM automation_tasks ORDER BY created_at DESC').all() as TaskRow[]
  return rows.map(rowToTask)
}

/** 调度器扫描：enabled=1 且 next_run_at <= now（next_run_at 为空视为未排程，不触发）。 */
export function listEnabledAutomationTasksDue(db: AppDatabase, now: number): AutomationTask[] {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      'SELECT * FROM automation_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC'
    )
    .all(now) as TaskRow[]
  return rows.map(rowToTask)
}

export function updateAutomationTask(
  db: AppDatabase,
  taskId: string,
  patch: Partial<Pick<AutomationTask, 'name' | 'prompt' | 'schedule' | 'deliveryPref' | 'deliveryTarget' | 'modelOverride' | 'enabled' | 'lastRunAt' | 'nextRunAt'>>
): AutomationTask | undefined {
  const cur = getAutomationTask(db, taskId)
  if (!cur) return undefined
  const next: AutomationTask = {
    ...cur,
    ...patch,
    updatedAt: Date.now()
  }
  const conn = getDbConnection(db)
  conn
    .prepare(
      `UPDATE automation_tasks SET
        name = ?, schedule_json = ?, prompt = ?, delivery_pref = ?, delivery_target = ?,
        model_override = ?, enabled = ?, updated_at = ?, last_run_at = ?, next_run_at = ?
      WHERE id = ?`
    )
    .run(
      next.name,
      JSON.stringify(next.schedule),
      next.prompt,
      next.deliveryPref,
      next.deliveryTarget ?? null,
      next.modelOverride ?? null,
      next.enabled ? 1 : 0,
      next.updatedAt,
      next.lastRunAt ?? null,
      next.nextRunAt ?? null,
      taskId
    )
  db.save()
  return next
}

export function deleteAutomationTask(db: AppDatabase, taskId: string): boolean {
  const conn = getDbConnection(db)
  const result = conn.prepare('DELETE FROM automation_tasks WHERE id = ?').run(taskId)
  db.save()
  return Number(result.changes) > 0
}

export type InsertAutomationTaskRunInput = {
  taskId: string
  clientId: string
  trigger: AutomationTaskRunTrigger
  scheduledFor: number
  /** 触发前已知会话的场景预留；常规流程由执行链创建后回填。 */
  sessionId?: string
}

/** 幂等抢占 run 行（client_id 唯一约束 + INSERT OR IGNORE）。返回 inserted=false 时不产生新行。 */
export function insertAutomationTaskRun(
  db: AppDatabase,
  input: InsertAutomationTaskRunInput
): { inserted: boolean; runId?: string } {
  const conn = getDbConnection(db)
  const id = randomUUID()
  const now = Date.now()
  const result = conn
    .prepare(
      `INSERT OR IGNORE INTO automation_task_runs (
        id, task_id, client_id, trigger, scheduled_for, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
    )
    .run(id, input.taskId, input.clientId, input.trigger, input.scheduledFor, now, now)
  db.save()
  if (Number(result.changes) === 0) {
    const existing = conn
      .prepare('SELECT id FROM automation_task_runs WHERE client_id = ?')
      .get(input.clientId) as { id: string } | undefined
    return { inserted: false, ...(existing ? { runId: existing.id } : {}) }
  }
  return { inserted: true, runId: id }
}

export function updateAutomationTaskRun(
  db: AppDatabase,
  runId: string,
  patch: Partial<Pick<AutomationTaskRun, 'status' | 'error' | 'sessionId' | 'resultSummary' | 'usageJson' | 'deliveryStatus' | 'deliveredAt'>>
): void {
  const conn = getDbConnection(db)
  const sets: string[] = []
  const params: Record<string, string | number> = { id: runId, updatedAt: Date.now() }
  if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status }
  if (patch.error !== undefined) { sets.push('error = @error'); params.error = patch.error }
  if (patch.sessionId !== undefined) { sets.push('session_id = @sessionId'); params.sessionId = patch.sessionId }
  if (patch.resultSummary !== undefined) { sets.push('result_summary = @resultSummary'); params.resultSummary = patch.resultSummary }
  if (patch.usageJson !== undefined) { sets.push('usage_json = @usageJson'); params.usageJson = patch.usageJson }
  if (patch.deliveryStatus !== undefined) { sets.push('delivery_status = @deliveryStatus'); params.deliveryStatus = patch.deliveryStatus }
  if (patch.deliveredAt !== undefined) { sets.push('delivered_at = @deliveredAt'); params.deliveredAt = patch.deliveredAt }
  sets.push('updated_at = @updatedAt')
  conn
    .prepare(`UPDATE automation_task_runs SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
  db.save()
}

export function getLatestRunForTask(db: AppDatabase, taskId: string): AutomationTaskRun | undefined {
  const conn = getDbConnection(db)
  const row = conn
    .prepare('SELECT * FROM automation_task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(taskId) as RunRow | undefined
  return row ? rowToRun(row) : undefined
}

export function getRunById(db: AppDatabase, runId: string): AutomationTaskRun | undefined {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM automation_task_runs WHERE id = ?').get(runId) as RunRow | undefined
  return row ? rowToRun(row) : undefined
}

export function listAutomationTaskRuns(db: AppDatabase, taskId: string): AutomationTaskRun[] {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare('SELECT * FROM automation_task_runs WHERE task_id = ? ORDER BY scheduled_for ASC')
    .all(taskId) as RunRow[]
  return rows.map(rowToRun)
}

/** 启动恢复 / 退出停机：活跃（queued/running）run 标记 interrupted（崩溃或显式退出导致）。 */
export function markActiveRunsInterrupted(db: AppDatabase, error = 'interrupted'): number {
  const conn = getDbConnection(db)
  const result = conn
    .prepare(
      "UPDATE automation_task_runs SET status = 'interrupted', error = ?, updated_at = ? WHERE status IN ('queued', 'running')"
    )
    .run(error, Date.now())
  db.save()
  return Number(result.changes)
}
