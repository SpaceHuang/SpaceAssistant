import { randomUUID } from 'crypto'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

/**
 * 管家任务存储（P4）：automation_tasks / automation_task_runs 两表的对外 API。
 * 表结构见 schema.ts MIGRATION_V15_BUTLER_TABLES_SQL。
 */

export type { AutomationTask, AutomationTaskInput, AutomationTaskSchedule, AutomationDeliveryPref, AutomationTaskRun, AutomationTaskRunStatus, AutomationTaskRunTrigger } from '../../src/shared/automationTaskTypes'
import { getAutomationTaskWorkDirs, type AutomationOutputOrganization, type AutomationTask, type AutomationTaskInput, type AutomationTaskSchedule, type AutomationDeliveryPref, type AutomationTaskRun, type AutomationTaskRunStatus, type AutomationTaskRunTrigger, type TargetBinding, type TargetSelection } from '../../src/shared/automationTaskTypes'

export type TrustedTaskPreflightCommit = { targetBindings?: TargetBinding[]; draft?: true }
export type AutomationTaskUpdateResult = { ok: true; task: AutomationTask } | { ok: false; reason: 'task-revision-conflict' | 'schedule-pending' | 'task-not-found' }

type TaskRow = {
  id: string
  name: string
  schedule_json: string
  prompt: string
  delivery_pref: string
  delivery_target: string | null
  model_override: string | null
  output_dir: string | null
  output_organization: string | null
  work_dir: string | null
  work_dirs_json: string | null
  preflight_version: number
  target_bindings_json: string | null
  task_revision: number
  schedule_generation: number
  model_id: string | null
  model_service_id: string | null
  reasoning_effort: string | null
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
  config_snapshot_json: string | null
  run_phase: string
  task_revision: number | null
  schedule_generation: number | null
  slot_at: number | null
}

function parseSchedule(raw: string): AutomationTaskSchedule {
  try {
    const parsed = JSON.parse(raw) as AutomationTaskSchedule
    if (parsed?.kind === 'interval' && typeof parsed.intervalMinutes === 'number') return parsed
    if (parsed?.kind === 'daily' && typeof parsed.time === 'string') return parsed
    if (parsed?.kind === 'once' && typeof parsed.at === 'number' && parsed.at > 0) return parsed
  } catch { /* fallthrough */ }
  return { kind: 'interval', intervalMinutes: 60 }
}

function normalizeDeliveryPref(value: string): AutomationDeliveryPref {
  return value === 'feishu' || value === 'wechat' || value === 'none' ? value : 'desktop'
}

function rowToTask(row: TaskRow): AutomationTask {
  let workDirs: string[] | undefined
  if (typeof row.work_dirs_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.work_dirs_json)
      if (Array.isArray(parsed) && parsed.every((root) => typeof root === 'string')) workDirs = parsed
    } catch { /* malformed historical value is handled as absent; callers still see legacy workDir */ }
  }
  return {
    id: row.id,
    name: row.name,
    schedule: parseSchedule(row.schedule_json),
    prompt: row.prompt,
    deliveryPref: normalizeDeliveryPref(row.delivery_pref),
    ...(row.delivery_target ? { deliveryTarget: row.delivery_target } : {}),
    ...(row.model_override ? { modelOverride: row.model_override } : {}),
    authorizedDirs: workDirs ?? (row.work_dir != null ? [row.work_dir] : []),
    workDirs: workDirs ?? (row.work_dir != null ? [row.work_dir] : []),
    outputDir: row.output_dir ?? null,
    outputOrganization: (['direct', 'daily', 'hourly'] as const).includes(row.output_organization as AutomationOutputOrganization)
      ? row.output_organization as AutomationOutputOrganization
      : null,
    preflightVersion: row.preflight_version === 1 ? 1 : 0,
    targetBindingsJson: row.target_bindings_json,
    taskRevision: row.task_revision,
    scheduleGeneration: row.schedule_generation,
    ...(row.model_id != null ? { modelId: row.model_id } : {}),
    ...(row.model_service_id != null ? { modelServiceId: row.model_service_id } : {}),
    ...(row.reasoning_effort != null ? { reasoningEffort: row.reasoning_effort as AutomationTask['reasoningEffort'] } : {}),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_run_at != null ? { lastRunAt: row.last_run_at } : {}),
    ...(row.next_run_at != null ? { nextRunAt: row.next_run_at } : {})
  }
}

function parseSnapshot(raw: string | null): AutomationTaskRun['configSnapshot'] | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    if (value && (value.resolutionStatus === 'resolved' || value.resolutionStatus === 'failed')) return value
  } catch { /* corrupted historical snapshot is ignored */ }
  return undefined
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
    ...(parseSnapshot(row.config_snapshot_json) ? { configSnapshot: parseSnapshot(row.config_snapshot_json)! } : {}),
    ...(row.run_phase ? { runPhase: row.run_phase as AutomationTaskRun['runPhase'] } : {}),
    ...(row.task_revision != null ? { taskRevision: row.task_revision } : {}),
    ...(row.schedule_generation != null ? { scheduleGeneration: row.schedule_generation } : {}),
    ...(row.slot_at != null ? { slotAt: row.slot_at } : {}),
    deliveryStatus: row.delivery_status === 'delivered' || row.delivery_status === 'failed-degraded' || row.delivery_status === 'delivery-uncertain' || row.delivery_status === 'none'
      ? row.delivery_status
      : 'pending',
    ...(row.delivered_at != null ? { deliveredAt: row.delivered_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createAutomationTask(db: AppDatabase, input: AutomationTaskInput, preflight?: TrustedTaskPreflightCommit): AutomationTask {
  const now = Date.now()
  const id = randomUUID()
  const conn = getDbConnection(db)
  // 评审 P0-1：缺省按 schedule 自动武装首次触发时刻——渲染端 / IPC 链路不传 nextRunAt，
  // 落 NULL 会使任务被 due 扫描（next_run_at IS NOT NULL）永久排除。
  const enabled = input.enabled !== false
  const nextRunAt = input.nextRunAt ?? (enabled ? computeNextRunAt(input.schedule, now) : null)
  const workDirs = Array.isArray(input.authorizedDirs) ? [...input.authorizedDirs] : getAutomationTaskWorkDirs(input)
  const legacyWorkDir = workDirs.length === 1 ? workDirs[0] : null
  runInTransaction(conn, () => {
    conn.prepare(
      `INSERT INTO automation_tasks (
        id, name, schedule_json, prompt, delivery_pref, delivery_target, model_override, output_dir, output_organization,
        work_dir, work_dirs_json, preflight_version, target_bindings_json, model_id, model_service_id, reasoning_effort,
        enabled, created_at, updated_at, next_run_at, task_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      JSON.stringify(input.schedule),
      input.prompt,
      input.deliveryPref,
      input.deliveryTarget ?? null,
      input.modelOverride ?? null,
      input.outputDir ?? null,
      input.outputOrganization ?? null,
      legacyWorkDir,
      JSON.stringify(workDirs),
      preflight ? 1 : 0,
      preflight && !preflight.draft ? JSON.stringify(preflight.targetBindings ?? []) : null,
      input.modelId ?? null,
      input.modelServiceId ?? null,
      input.reasoningEffort ?? null,
      enabled ? 1 : 0,
      now,
      now,
      nextRunAt,
      preflight ? 1 : 0
    )
    conn.prepare(`INSERT INTO automation_task_recovery_state(task_id,schedule_generation,recovery_cursor_at,updated_at)
      VALUES(?,0,?,?)`).run(id, nextRunAt, now)
  })
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

/** 下一次触发时刻（interval：from + N 分钟；daily：下一个 HH:mm 本地时刻）。
 *  定义在 taskStore 而非 taskScheduler：创建/编辑任务时就要按 schedule 武装 next_run_at
 *  （评审 P0-1——若只有调度器 rearm 一个写值点，任务永不首次触发）。 */
export function computeNextRunAt(schedule: AutomationTaskSchedule, from: number): number {
  if (schedule.kind === 'interval') {
    return from + Math.max(1, schedule.intervalMinutes) * 60_000
  }
  if (schedule.kind === 'once') {
    // 一次性：触发时刻恒为给定 at（与 from 无关）。at 已过时视为立即到期；
    // 执行后的「不再排程」由调度器 rearm 停用任务实现，不走本函数。
    return schedule.at
  }
  const [h, m] = schedule.time.split(':').map((v) => Number.parseInt(v, 10))
  const next = new Date(from)
  next.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** 调度器扫描：enabled=1 且 next_run_at <= now（next_run_at 为空视为未排程，不触发）。 */
export function listEnabledAutomationTasksDue(db: AppDatabase, now: number): AutomationTask[] {  const conn = getDbConnection(db)
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
  patch: Partial<Pick<AutomationTask, 'name' | 'prompt' | 'schedule' | 'deliveryPref' | 'deliveryTarget' | 'modelOverride' | 'authorizedDirs' | 'workDirs' | 'outputDir' | 'outputOrganization' | 'modelId' | 'modelServiceId' | 'reasoningEffort' | 'enabled' | 'lastRunAt' | 'nextRunAt'>> & { clearConfig?: readonly ('authorizedDirs' | 'workDirs' | 'outputDir' | 'outputOrganization' | 'modelId' | 'modelServiceId' | 'reasoningEffort')[]; expectedTaskRevision?: number },
  preflight?: TrustedTaskPreflightCommit
): AutomationTask | undefined {
  const result = updateAutomationTaskConditional(db, taskId, patch, preflight)
  return result.ok ? result.task : undefined
}

export function updateAutomationTaskConditional(
  db: AppDatabase,
  taskId: string,
  patch: Partial<Pick<AutomationTask, 'name' | 'prompt' | 'schedule' | 'deliveryPref' | 'deliveryTarget' | 'modelOverride' | 'authorizedDirs' | 'workDirs' | 'outputDir' | 'outputOrganization' | 'modelId' | 'modelServiceId' | 'reasoningEffort' | 'enabled' | 'lastRunAt' | 'nextRunAt'>> & { clearConfig?: readonly ('authorizedDirs' | 'workDirs' | 'outputDir' | 'outputOrganization' | 'modelId' | 'modelServiceId' | 'reasoningEffort')[]; expectedTaskRevision?: number },
  preflight?: TrustedTaskPreflightCommit
): AutomationTaskUpdateResult {
  const cur = getAutomationTask(db, taskId)
  if (!cur) return { ok: false, reason: 'task-not-found' }
  const { clearConfig, expectedTaskRevision, ...fields } = patch
  if (expectedTaskRevision !== undefined && (cur.taskRevision ?? 0) !== expectedTaskRevision) return { ok: false, reason: 'task-revision-conflict' }
  const next: AutomationTask = {
    ...cur,
    ...fields,
    updatedAt: Date.now(),
    taskRevision: (cur.taskRevision ?? 0) + (preflight || ['name', 'prompt', 'schedule', 'deliveryPref', 'deliveryTarget', 'modelOverride', 'authorizedDirs', 'workDirs', 'outputDir', 'outputOrganization', 'modelId', 'modelServiceId', 'reasoningEffort'].some((key) => Object.prototype.hasOwnProperty.call(fields, key)) ? 1 : 0),
    scheduleGeneration: (cur.scheduleGeneration ?? 0) + (patch.schedule !== undefined || patch.enabled !== undefined ? 1 : 0),
    ...(preflight ? preflight.draft === true
      ? { preflightVersion: 0 as const, targetBindingsJson: null }
      : { preflightVersion: 1 as const, targetBindingsJson: JSON.stringify(preflight.targetBindings ?? []) }
      : {})
  }
  for (const key of clearConfig ?? []) if (key !== 'workDirs' && key !== 'authorizedDirs') delete (next as unknown as Record<string, unknown>)[key]
  const workDirs = patch.authorizedDirs !== undefined
    ? [...patch.authorizedDirs]
    : patch.workDirs !== undefined
      ? [...patch.workDirs]
      : clearConfig?.includes('workDirs') || clearConfig?.includes('authorizedDirs')
        ? []
        : getAutomationTaskWorkDirs(cur)
  next.authorizedDirs = workDirs
  next.workDirs = workDirs
  const legacyWorkDir = clearConfig?.includes('workDirs') || clearConfig?.includes('authorizedDirs')
    ? null
    : patch.workDirs !== undefined
      ? (patch.workDirs.length === 1 ? patch.workDirs[0] : null)
      : workDirs.length === 1 ? workDirs[0] : null
  // 评审 P0-1：排程语义随状态推导——停用置空（未排程）；schedule 变更 / 重新启用 /
  // 启用但从未武装（历史 NULL 行）时按 schedule 重算；仅改名/提示词等不动既有排程。
  if (!next.enabled) {
    next.nextRunAt = undefined
  } else if (
    patch.schedule !== undefined ||
    patch.enabled === true ||
    next.nextRunAt === undefined
  ) {
    next.nextRunAt = computeNextRunAt(next.schedule, Date.now())
  }
  const conn = getDbConnection(db)
  const committed = runInTransaction(conn, () => {
    const scheduleMutation = patch.schedule !== undefined || patch.enabled !== undefined
    if (scheduleMutation) {
      const pending = conn.prepare(`SELECT r.run_phase FROM automation_task_recovery_state s
        JOIN automation_task_runs r ON r.id=s.pending_run_id WHERE s.task_id=?`)
        .get(taskId) as { run_phase: string } | undefined
      if (pending?.run_phase === 'queued-before-start') return { ok: false as const, reason: 'schedule-pending' as const }
    }
    const updateResult = conn
      .prepare(
      `UPDATE automation_tasks SET
        name = ?, schedule_json = ?, prompt = ?, delivery_pref = ?, delivery_target = ?,
        model_override = ?, output_dir = ?, output_organization = ?, work_dir = ?, work_dirs_json = ?, model_id = ?, model_service_id = ?, reasoning_effort = ?,
        enabled = ?, updated_at = ?, last_run_at = ?, next_run_at = ?,
        preflight_version = ?, target_bindings_json = ?,
        task_revision = ?, schedule_generation = ?
      WHERE id = ? AND (? IS NULL OR task_revision = ?)`
      )
      .run(
      next.name,
      JSON.stringify(next.schedule),
      next.prompt,
      next.deliveryPref,
      next.deliveryTarget ?? null,
      next.modelOverride ?? null,
      clearConfig?.includes('outputDir') ? null : next.outputDir ?? null,
      clearConfig?.includes('outputOrganization') ? null : next.outputOrganization ?? null,
      legacyWorkDir,
      JSON.stringify(workDirs),
      clearConfig?.includes('modelId') ? null : next.modelId ?? null,
      clearConfig?.includes('modelServiceId') ? null : next.modelServiceId ?? null,
      clearConfig?.includes('reasoningEffort') ? null : next.reasoningEffort ?? null,
      next.enabled ? 1 : 0,
      next.updatedAt,
      next.lastRunAt ?? null,
      next.nextRunAt ?? null,
      next.preflightVersion ?? 0,
      next.targetBindingsJson ?? null,
      next.taskRevision ?? 0,
      next.scheduleGeneration ?? 0,
      taskId,
      expectedTaskRevision ?? null,
      expectedTaskRevision ?? null
    )
    if (Number(updateResult.changes) !== 1) return { ok: false as const, reason: 'task-revision-conflict' as const }
    if (scheduleMutation) {
      conn.prepare(`UPDATE automation_task_recovery_state SET schedule_generation=?,recovery_cursor_at=?,updated_at=? WHERE task_id=?`)
        .run(next.scheduleGeneration ?? 0, next.nextRunAt ?? null, next.updatedAt, taskId)
    }
    return { ok: true as const, task: next }
  })
  if (!committed.ok) return committed
  db.save()
  return { ok: true, task: next }
}

export function deleteAutomationTask(db: AppDatabase, taskId: string): boolean {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const active = conn.prepare("SELECT 1 FROM automation_task_runs WHERE task_id=? AND status IN ('queued','running') LIMIT 1").get(taskId)
    if (active) return false
    return Number(conn.prepare('DELETE FROM automation_tasks WHERE id = ?').run(taskId).changes) > 0
  })
  if (!result) return false
  db.save()
  return result
}

export type InsertAutomationTaskRunInput = {
  taskId: string
  clientId: string
  trigger: AutomationTaskRunTrigger
  scheduledFor: number
  /** 触发前已知会话的场景预留；常规流程由执行链创建后回填。 */
  sessionId?: string
}

export function insertManualTaskClaim(db: AppDatabase, taskId: string, clientId: string): { inserted: boolean; runId?: string; scheduleGeneration?: number } {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const task = conn.prepare('SELECT schedule_generation FROM automation_tasks WHERE id=?').get(taskId) as { schedule_generation: number } | undefined
    if (!task) return { inserted: false as const }
    const runId = randomUUID()
    const now = Date.now()
    const inserted = conn.prepare(`INSERT OR IGNORE INTO automation_task_runs
      (id,task_id,client_id,trigger,scheduled_for,status,run_phase,task_revision,schedule_generation,slot_at,created_at,updated_at)
      SELECT ?,id,?,'manual',0,'queued','queued-before-start',task_revision,schedule_generation,0,?,? FROM automation_tasks WHERE id=?`)
      .run(runId, clientId, now, now, taskId)
    if (Number(inserted.changes) !== 1) return { inserted: false as const }
    return { inserted: true as const, runId, scheduleGeneration: task.schedule_generation }
  })
  if (result.inserted) db.save()
  return result
}

export function getQueuedClaimIdentity(db: AppDatabase, runId: string): { taskId: string; slot: number; generation: number } | undefined {
  const row = getDbConnection(db).prepare('SELECT task_id,scheduled_for,schedule_generation,status,run_phase FROM automation_task_runs WHERE id=?')
    .get(runId) as { task_id: string; scheduled_for: number; schedule_generation: number | null; status: string; run_phase: string } | undefined
  if (!row || row.status !== 'queued' || row.run_phase !== 'queued-before-start' || row.schedule_generation == null) return undefined
  return { taskId: row.task_id, slot: row.scheduled_for, generation: row.schedule_generation }
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
        id, task_id, client_id, trigger, scheduled_for, status, run_phase, task_revision, schedule_generation, slot_at, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, 'queued', 'queued-before-start', task_revision, schedule_generation, ?, ?, ?
        FROM automation_tasks WHERE id = ?`
    )
    .run(id, input.taskId, input.clientId, input.trigger, input.scheduledFor, input.scheduledFor, now, now, input.taskId)
  db.save()
  if (Number(result.changes) === 0) {
    const existing = conn
      .prepare('SELECT id FROM automation_task_runs WHERE client_id = ?')
      .get(input.clientId) as { id: string } | undefined
    return { inserted: false, ...(existing ? { runId: existing.id } : {}) }
  }
  return { inserted: true, runId: id }
}

export type ClaimDueSlotInput = { taskId: string; slot: number; nextSlot: number | null; clientId: string; allowCursorAdvance?: boolean }
export type ClaimDueSlotResult =
  | { claimed: true; runId: string }
  | { claimed: false; reason: 'task-not-found' | 'not-due' | 'pending-claim' | 'already-claimed'; runId?: string }

export function claimDueSlotAndAdvance(db: AppDatabase, input: ClaimDueSlotInput): ClaimDueSlotResult {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const task = conn.prepare(`SELECT enabled,next_run_at,task_revision,schedule_generation,schedule_json FROM automation_tasks WHERE id=?`)
      .get(input.taskId) as { enabled: number; next_run_at: number | null; task_revision: number; schedule_generation: number; schedule_json: string } | undefined
    if (!task) return { claimed: false as const, reason: 'task-not-found' as const }
    const state = conn.prepare(`SELECT schedule_generation,pending_run_id,recovery_cursor_at FROM automation_task_recovery_state WHERE task_id=?`)
      .get(input.taskId) as { schedule_generation: number; pending_run_id: string | null; recovery_cursor_at: number | null } | undefined
    const existing = conn.prepare('SELECT id,status,run_phase,schedule_generation FROM automation_task_runs WHERE client_id=?').get(input.clientId) as { id: string; status: string; run_phase: string; schedule_generation: number | null } | undefined
    if (existing?.status === 'queued' && existing.run_phase === 'queued-before-start' && state?.pending_run_id === existing.id && existing.schedule_generation === state.schedule_generation) {
      return { claimed: true as const, runId: existing.id }
    }
    if (existing) return { claimed: false as const, reason: 'already-claimed' as const, runId: existing.id }
    if (task.enabled !== 1 || (task.next_run_at !== input.slot && !(input.allowCursorAdvance && (task.next_run_at ?? 0) < input.slot && state?.recovery_cursor_at === task.next_run_at))) return { claimed: false as const, reason: 'not-due' as const }
    if (!state || state.schedule_generation !== task.schedule_generation) return { claimed: false as const, reason: 'not-due' as const }
    if (state.pending_run_id) return { claimed: false as const, reason: 'pending-claim' as const }
    const runId = randomUUID()
    const now = Date.now()
    conn.prepare(`INSERT INTO automation_task_runs(id,task_id,client_id,trigger,scheduled_for,status,run_phase,task_revision,schedule_generation,slot_at,created_at,updated_at)
      VALUES(?,?,?,'schedule',?,'queued','queued-before-start',?,?,?,?,?)`)
      .run(runId, input.taskId, input.clientId, input.slot, task.task_revision, task.schedule_generation, input.slot, now, now)
    const priorCursor = task.next_run_at
    const isOnce = parseSchedule(task.schedule_json).kind === 'once'
    const moved = conn.prepare('UPDATE automation_tasks SET next_run_at=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE id=? AND next_run_at=? AND schedule_generation=?')
      .run(isOnce ? null : input.nextSlot, isOnce ? 1 : 0, input.taskId, priorCursor, task.schedule_generation)
    if (Number(moved.changes) !== 1) throw new Error('scheduled task cursor changed during slot claim')
    conn.prepare(`UPDATE automation_task_recovery_state SET recovery_cursor_at=?,pending_run_id=?,pending_run_slot=?,pending_schedule_generation=?,updated_at=?
      WHERE task_id=? AND schedule_generation=? AND pending_run_id IS NULL`)
      .run(isOnce ? null : input.slot, runId, input.slot, task.schedule_generation, now, input.taskId, task.schedule_generation)
    return { claimed: true as const, runId }
  })
  if (result.claimed) db.save()
  return result
}

export type RecordSkippedSlotInput = { taskId: string; slot: number; nextSlot: number; clientId: string }
export type RecordSkippedSlotResult = { recorded: true; runId: string } | { recorded: false; reason: 'task-not-found' | 'generation-changed' | 'pending-claim' | 'slot-already-claimed' }

export function recordSkippedSlotAndAdvance(db: AppDatabase, input: RecordSkippedSlotInput): RecordSkippedSlotResult {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const task = conn.prepare('SELECT schedule_generation,next_run_at FROM automation_tasks WHERE id=?').get(input.taskId) as { schedule_generation: number; next_run_at: number | null } | undefined
    if (!task) return { recorded: false as const, reason: 'task-not-found' as const }
    const state = conn.prepare('SELECT schedule_generation,recovery_cursor_at,pending_run_id FROM automation_task_recovery_state WHERE task_id=?').get(input.taskId) as { schedule_generation: number; recovery_cursor_at: number | null; pending_run_id: string | null } | undefined
    const existing = conn.prepare('SELECT id,status FROM automation_task_runs WHERE client_id=?').get(input.clientId) as { id: string; status: string } | undefined
    if (existing?.status === 'skipped' && state?.schedule_generation === task.schedule_generation && task.next_run_at === input.nextSlot && state.recovery_cursor_at === input.nextSlot && !state.pending_run_id) {
      return { recorded: true as const, runId: existing.id }
    }
    if (!state || state.schedule_generation !== task.schedule_generation || task.next_run_at !== input.slot || state.recovery_cursor_at !== input.slot) {
      return { recorded: false as const, reason: 'generation-changed' as const }
    }
    if (state.pending_run_id) return { recorded: false as const, reason: 'pending-claim' as const }
    if (existing && existing.status !== 'skipped') return { recorded: false as const, reason: 'slot-already-claimed' as const }
    const runId = existing?.id ?? randomUUID()
    const now = Date.now()
    if (!existing) {
      conn.prepare(`INSERT INTO automation_task_runs(id,task_id,client_id,trigger,scheduled_for,status,error,delivery_status,run_phase,task_revision,schedule_generation,slot_at,created_at,updated_at)
        SELECT ?,id,?,'schedule',?,'skipped','missed-window','none','terminal',task_revision,schedule_generation,?,?,? FROM automation_tasks WHERE id=?`)
        .run(runId, input.clientId, input.slot, input.slot, now, now, input.taskId)
    }
    const moved = conn.prepare(`UPDATE automation_tasks SET next_run_at=? WHERE id=? AND next_run_at=? AND schedule_generation=?`)
      .run(input.nextSlot, input.taskId, input.slot, task.schedule_generation)
    if (Number(moved.changes) !== 1) throw new Error('scheduled task cursor changed during missed-slot recovery')
    const cursor = conn.prepare(`UPDATE automation_task_recovery_state SET recovery_cursor_at=?,updated_at=?
      WHERE task_id=? AND schedule_generation=? AND pending_run_id IS NULL`)
      .run(input.nextSlot, now, input.taskId, task.schedule_generation)
    if (Number(cursor.changes) !== 1) throw new Error('scheduled task recovery state changed during missed-slot recovery')
    return { recorded: true as const, runId }
  })
  if (result.recorded) db.save()
  return result
}

export function transitionClaimToRunning(
  db: AppDatabase,
  runId: string,
  taskId: string,
  slot: number,
  generation: number
): { ok: true; snapshot: AutomationTaskRun['configSnapshot'] } | { ok: false; reason: 'claim-not-queued' | 'claim-mismatch' | 'task-not-found' | 'invalid-task-config' } {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const run = conn.prepare(`SELECT status,run_phase,task_id,scheduled_for,schedule_generation,trigger
      FROM automation_task_runs WHERE id=?`).get(runId) as { status: string; run_phase: string; task_id: string; scheduled_for: number; schedule_generation: number | null; trigger: string } | undefined
    if (!run || run.status !== 'queued' || run.run_phase !== 'queued-before-start') return { ok: false as const, reason: 'claim-not-queued' as const }
    if (run.task_id !== taskId || run.scheduled_for !== slot || run.schedule_generation !== generation) return { ok: false as const, reason: 'claim-mismatch' as const }
    if (run.trigger === 'schedule') {
      const pending = conn.prepare('SELECT pending_run_id,pending_schedule_generation FROM automation_task_recovery_state WHERE task_id=?')
        .get(taskId) as { pending_run_id: string | null; pending_schedule_generation: number | null } | undefined
      if (pending?.pending_run_id !== runId || pending.pending_schedule_generation !== generation) return { ok: false as const, reason: 'claim-mismatch' as const }
    }
    const taskRow = conn.prepare('SELECT * FROM automation_tasks WHERE id=?').get(taskId) as TaskRow | undefined
    if (!taskRow) return { ok: false as const, reason: 'task-not-found' as const }
    const task = rowToTask(taskRow)
    const workDirs = getAutomationTaskWorkDirs({ workDirs: task.workDirs, workDir: taskRow.work_dir ?? undefined })
    if (workDirs.length === 0) return { ok: false as const, reason: 'invalid-task-config' as const }
    let targetSelections: TargetSelection[] = []
    if (task.preflightVersion === 1) {
      try {
        const parsed: unknown = JSON.parse(task.targetBindingsJson ?? 'null')
        if (!Array.isArray(parsed)) return { ok: false as const, reason: 'invalid-task-config' as const }
        targetSelections = parsed as typeof targetSelections
      } catch {
        return { ok: false as const, reason: 'invalid-task-config' as const }
      }
    }
    const snapshot: NonNullable<AutomationTaskRun['configSnapshot']> = {
      resolutionStatus: 'resolved',
      taskName: task.name,
      deliveryPref: task.deliveryPref,
      deliveryTarget: task.deliveryTarget,
      prompt: task.prompt,
      schedule: task.schedule,
      taskRevision: task.taskRevision,
      workDirs,
      preflightVersion: task.preflightVersion,
      targetSelections,
      modelId: task.modelId,
      providerModelName: task.modelOverride,
      serviceId: task.modelServiceId,
      requestedEffort: task.reasoningEffort,
    }
    const changed = conn.prepare(`UPDATE automation_task_runs SET status='running',run_phase='running',task_revision=?,schedule_generation=?,config_snapshot_json=?,updated_at=?
      WHERE id=? AND status='queued' AND run_phase='queued-before-start' AND task_id=? AND scheduled_for=? AND schedule_generation=?`)
      .run(task.taskRevision ?? 0, task.scheduleGeneration ?? 0, JSON.stringify(snapshot), Date.now(), runId, taskId, slot, generation)
    if (Number(changed.changes) !== 1) return { ok: false as const, reason: 'claim-not-queued' as const }
    return { ok: true as const, snapshot }
  })
  if (result.ok) db.save()
  return result
}

export function finalizeClaimAndClearPending(
  db: AppDatabase,
  runId: string,
  status: Exclude<AutomationTaskRunStatus, 'queued' | 'running'>,
  error?: string
): { updated: boolean; clearedPending: boolean } {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const run = conn.prepare(`SELECT r.task_id,r.schedule_generation,r.status,t.schedule_json
      FROM automation_task_runs r JOIN automation_tasks t ON t.id=r.task_id WHERE r.id=?`)
      .get(runId) as { task_id: string; schedule_generation: number | null; status: string; schedule_json: string } | undefined
    if (!run || !['queued', 'running'].includes(run.status)) return { updated: false, clearedPending: false }
    const updated = conn.prepare(`UPDATE automation_task_runs SET status=?,run_phase='terminal',error=?,updated_at=?
      WHERE id=? AND status IN ('queued','running')`).run(status, error ?? null, Date.now(), runId)
    if (Number(updated.changes) !== 1) return { updated: false, clearedPending: false }
    if (status === 'completed' && parseSchedule(run.schedule_json).kind === 'once') {
      conn.prepare('UPDATE automation_tasks SET enabled=0,last_run_at=?,next_run_at=NULL,updated_at=? WHERE id=?')
        .run(Date.now(), Date.now(), run.task_id)
    }
    const cleared = run.schedule_generation == null ? { changes: 0 } : conn.prepare(`UPDATE automation_task_recovery_state
      SET recovery_cursor_at=CASE WHEN schedule_generation=? THEN (SELECT next_run_at FROM automation_tasks WHERE id=?) ELSE recovery_cursor_at END,
        pending_run_id=NULL,pending_run_slot=NULL,pending_schedule_generation=NULL,updated_at=?
      WHERE task_id=? AND pending_run_id=? AND pending_schedule_generation=?`)
      .run(run.schedule_generation, run.task_id, Date.now(), run.task_id, runId, run.schedule_generation)
    return { updated: true, clearedPending: Number(cleared.changes) === 1 }
  })
  if (result.updated) db.save()
  return result
}

/** Finalize a successful once slot, persist last-run metadata, and clear its matching pending claim atomically. */
export function finalizeOnceScheduledRun(db: AppDatabase, runId: string, completedAt: number): boolean {
  const conn = getDbConnection(db)
  const finalized = runInTransaction(conn, () => {
    const run = conn.prepare(`SELECT task_id,schedule_generation,status FROM automation_task_runs WHERE id=?`)
      .get(runId) as { task_id: string; schedule_generation: number | null; status: string } | undefined
    if (!run || !['queued', 'running', 'completed'].includes(run.status)) return false
    conn.prepare(`UPDATE automation_task_runs SET status='completed',run_phase='terminal',updated_at=? WHERE id=?`)
      .run(completedAt, runId)
    conn.prepare(`UPDATE automation_tasks SET enabled=0,last_run_at=?,next_run_at=NULL,updated_at=? WHERE id=?`)
      .run(completedAt, completedAt, run.task_id)
    if (run.schedule_generation != null) conn.prepare(`UPDATE automation_task_recovery_state
      SET recovery_cursor_at=NULL,pending_run_id=NULL,pending_run_slot=NULL,pending_schedule_generation=NULL,updated_at=?
      WHERE task_id=? AND pending_run_id=? AND pending_schedule_generation=?`)
      .run(completedAt, run.task_id, runId, run.schedule_generation)
    return true
  })
  if (finalized) db.save()
  return finalized
}

export function updateAutomationTaskRun(
  db: AppDatabase,
  runId: string,
  patch: Partial<Pick<AutomationTaskRun, 'status' | 'error' | 'sessionId' | 'resultSummary' | 'usageJson' | 'configSnapshot' | 'deliveryStatus' | 'deliveredAt'>>
): void {
  const conn = getDbConnection(db)
  const sets: string[] = []
  const params: Record<string, string | number> = { id: runId, updatedAt: Date.now() }
  if (patch.status !== undefined) {
    sets.push('status = @status')
    params.status = patch.status
    sets.push('run_phase = @runPhase')
    params.runPhase = patch.status === 'queued' ? 'queued-before-start' : patch.status === 'running' ? 'running' : 'terminal'
  }
  if (patch.error !== undefined) { sets.push('error = @error'); params.error = patch.error }
  if (patch.sessionId !== undefined) { sets.push('session_id = @sessionId'); params.sessionId = patch.sessionId }
  if (patch.resultSummary !== undefined) { sets.push('result_summary = @resultSummary'); params.resultSummary = patch.resultSummary }
  if (patch.usageJson !== undefined) { sets.push('usage_json = @usageJson'); params.usageJson = patch.usageJson }
  if (patch.configSnapshot !== undefined) { sets.push('config_snapshot_json = @configSnapshot'); params.configSnapshot = JSON.stringify(patch.configSnapshot) }
  else if (Object.prototype.hasOwnProperty.call(patch, 'configSnapshot')) sets.push('config_snapshot_json = NULL')
  if (patch.deliveryStatus !== undefined) { sets.push('delivery_status = @deliveryStatus'); params.deliveryStatus = patch.deliveryStatus }
  if (patch.deliveredAt !== undefined) { sets.push('delivered_at = @deliveredAt'); params.deliveredAt = patch.deliveredAt }
  sets.push('updated_at = @updatedAt')
  runInTransaction(conn, () => {
    conn.prepare(`UPDATE automation_task_runs SET ${sets.join(', ')} WHERE id = @id`).run(params)
    if (patch.status && !['queued', 'running'].includes(patch.status)) {
      const run = conn.prepare('SELECT task_id,schedule_generation FROM automation_task_runs WHERE id=?').get(runId) as { task_id: string; schedule_generation: number | null } | undefined
      if (run?.schedule_generation != null) {
        conn.prepare(`UPDATE automation_task_recovery_state
          SET recovery_cursor_at=CASE WHEN schedule_generation=? THEN (SELECT next_run_at FROM automation_tasks WHERE id=?) ELSE recovery_cursor_at END,
            pending_run_id=NULL,pending_run_slot=NULL,pending_schedule_generation=NULL,updated_at=?
          WHERE task_id=? AND pending_run_id=? AND pending_schedule_generation=?`)
          .run(run.schedule_generation, run.task_id, Date.now(), run.task_id, runId, run.schedule_generation)
      }
    }
  })
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
  const changed = runInTransaction(conn, () => {
    const rows = conn.prepare(`SELECT r.id,r.task_id,r.schedule_generation
      FROM automation_task_runs r
      LEFT JOIN automation_task_recovery_state s ON s.task_id=r.task_id AND s.pending_run_id=r.id
        AND s.pending_schedule_generation=r.schedule_generation
      WHERE r.status='running' OR (r.status='queued' AND (r.trigger<>'schedule' OR s.pending_run_id IS NULL))`)
      .all() as Array<{ id: string; task_id: string; schedule_generation: number | null }>
    const update = conn.prepare("UPDATE automation_task_runs SET status='interrupted',run_phase='terminal',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')")
    let count = 0
    for (const row of rows) {
      count += Number(update.run(error, Date.now(), row.id).changes)
      if (row.schedule_generation != null) conn.prepare(`UPDATE automation_task_recovery_state
        SET recovery_cursor_at=CASE WHEN schedule_generation=? THEN (SELECT next_run_at FROM automation_tasks WHERE id=?) ELSE recovery_cursor_at END,
          pending_run_id=NULL,pending_run_slot=NULL,pending_schedule_generation=NULL,updated_at=?
        WHERE task_id=? AND pending_run_id=? AND pending_schedule_generation=?`)
        .run(row.schedule_generation, row.task_id, Date.now(), row.task_id, row.id, row.schedule_generation)
    }
    return count
  })
  if (changed) db.save()
  return changed
}

export function listPendingScheduledClaims(db: AppDatabase): Array<{ task: AutomationTask; runId: string; slot: number; generation: number }> {
  const conn = getDbConnection(db)
  const rows = conn.prepare(`SELECT t.*,r.id AS pending_id,r.slot_at AS pending_slot,r.schedule_generation AS pending_generation
    FROM automation_task_recovery_state s JOIN automation_task_runs r ON r.id=s.pending_run_id
    JOIN automation_tasks t ON t.id=s.task_id
    WHERE r.trigger='schedule' AND r.status='queued' AND r.run_phase='queued-before-start'
      AND s.schedule_generation=t.schedule_generation AND s.pending_schedule_generation=r.schedule_generation
    ORDER BY r.slot_at ASC`).all() as Array<TaskRow & { pending_id: string; pending_slot: number; pending_generation: number }>
  return rows.map((row) => ({ task: rowToTask(row), runId: row.pending_id, slot: row.pending_slot, generation: row.pending_generation }))
}

/** Reconciles completed task-run delivery summaries with the durable driver journal. */
export function syncAutomationTaskRunDeliveryStatuses(db: AppDatabase, now = Date.now()): number {
  const conn = getDbConnection(db)
  const changed = runInTransaction(conn, () => {
    const rows = conn.prepare(`SELECT r.id, r.delivery_status, r.delivered_at,
        COUNT(d.target) AS target_count,
        SUM(CASE WHEN d.status IN ('pending','deferred','delivering') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN d.status='delivery-uncertain' THEN 1 ELSE 0 END) AS uncertain_count,
        SUM(CASE WHEN d.status IN ('failed','expired','superseded') THEN 1 ELSE 0 END) AS failed_count
      FROM automation_task_runs r
      JOIN driver_deliveries d ON d.delivery_id = r.id
      WHERE r.status='completed' AND r.delivery_status IN ('pending','delivery-uncertain','delivered','failed-degraded')
      GROUP BY r.id`).all() as Array<{
        id: string; delivery_status: string | null; delivered_at: number | null;
        target_count: number; active_count: number; uncertain_count: number; failed_count: number
      }>
    const update = conn.prepare(`UPDATE automation_task_runs SET delivery_status=?,
      delivered_at=CASE WHEN ?='delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      updated_at=?
      WHERE id=? AND (delivery_status IS NOT ? OR (?='delivered' AND delivered_at IS NULL))`)
    let count = 0
    for (const row of rows) {
      const next = row.uncertain_count > 0 ? 'delivery-uncertain'
        : row.active_count > 0 ? 'pending'
          : row.failed_count > 0 ? 'failed-degraded'
            : row.target_count > 0 ? 'delivered' : null
      if (!next || (next === row.delivery_status && (next !== 'delivered' || row.delivered_at != null))) continue
      const result = update.run(next, next, now, now, row.id, next, next)
      count += Number(result.changes)
    }
    return count
  })
  if (changed > 0) db.save()
  return changed
}
