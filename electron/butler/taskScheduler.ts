import { logAgentEvent } from '../agentLogger/agentLogger'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import {
  listEnabledAutomationTasksDue,
  markActiveRunsInterrupted,
  updateAutomationTask,
  insertAutomationTaskRun,
  type AutomationTask,
  type AutomationTaskRun,
  type AutomationTaskSchedule
} from './taskStore'

/**
 * 管家定时驱动源（P6，Driver 层）：主进程 setInterval tick + 有界启动恢复。
 * 不引 cron 库（interval / daily 自实现）；外部依赖（准入、执行链）经注入的 runTask 走 P4 执行链。
 * 运行前提：托盘常驻启用（P0 决策 a）——未启用时不启动 tick，日志记录 disabled-no-tray。
 */

export type SchedulerRunRequest = {
  trigger: 'schedule'
  requestId: string
  scheduledFor: number
}

export type SchedulerRunFn = (taskId: string, request: SchedulerRunRequest) => Promise<{ ok: boolean }>

export type ButlerSchedulerDeps = {
  db: AppDatabase
  runTask: SchedulerRunFn
  isTrayEnabled: () => boolean
  now?: () => number
  tickIntervalMs?: number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  logWarn?: (event: string, fields?: Record<string, unknown>) => void
}

/** 单次错过扫描上限：interval 任务最多回看 48 个槽位（防风暴）。 */
const MAX_MISSED_SLOTS = 48

/** 下一次触发时刻（interval：from + N 分钟；daily：下一个 HH:mm 本地时刻）。 */
export function computeNextRunAt(schedule: AutomationTaskSchedule, from: number): number {
  if (schedule.kind === 'interval') {
    return from + Math.max(1, schedule.intervalMinutes) * 60_000
  }
  const [h, m] = schedule.time.split(':').map((v) => Number.parseInt(v, 10))
  const next = new Date(from)
  next.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** 枚举 (from, now] 内错过的全部调度槽位（升序，有界）。from 本身视作第一个错过的槽位。 */
export function enumerateMissedSlots(schedule: AutomationTaskSchedule, from: number, now: number): number[] {
  const slots: number[] = []
  let cursor = from
  while (cursor <= now && slots.length < MAX_MISSED_SLOTS) {
    slots.push(cursor)
    const next = computeNextRunAt(schedule, cursor)
    if (next <= cursor) break
    cursor = next
  }
  return slots
}

export class ButlerTaskScheduler {
  private readonly db: AppDatabase
  private readonly runTask: SchedulerRunFn
  private readonly isTrayEnabledFn: () => boolean
  private readonly nowFn: () => number
  private readonly tickIntervalMs: number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  private readonly logWarn: (event: string, fields?: Record<string, unknown>) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = false

  constructor(deps: ButlerSchedulerDeps) {
    this.db = deps.db
    this.runTask = deps.runTask
    this.isTrayEnabledFn = deps.isTrayEnabled
    this.nowFn = deps.now ?? Date.now
    this.tickIntervalMs = deps.tickIntervalMs ?? 30_000
    this.setIntervalFn = deps.setIntervalFn ?? setInterval
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval
    this.logWarn = deps.logWarn ?? ((event, fields) => logAgentEvent('warn', event as never, fields))
  }

  /** app ready 后调用：托盘校验 → 启动恢复（有界补跑 + interrupted 标记）→ 启动 tick。 */
  start(): void {
    if (!this.isTrayEnabledFn()) {
      this.logWarn('automation.scheduler.disabled-no-tray')
      return
    }
    this.recoverOnStartup()
    this.stopped = false
    this.timer = this.setIntervalFn(() => void this.tick(), this.tickIntervalMs)
  }

  /** before-quit：停 tick；进行中 run 走现有取消语义后标 interrupted（退出显式且干净）。 */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    markActiveRunsInterrupted(this.db, 'app-quit')
  }

  /** 启动恢复：崩溃遗留 running → interrupted；停机错过的触发只补最近一次，更早标 skipped(missed-window)。 */
  recoverOnStartup(): { skippedCount: number; catchUpCount: number; interruptedCount: number } {
    const now = this.nowFn()
    const interruptedCount = markActiveRunsInterrupted(this.db, 'interrupted')
    let skippedCount = 0
    let catchUpCount = 0
    for (const task of this.dueTasks(now)) {
      const slots = enumerateMissedSlots(task.schedule, task.nextRunAt!, now)
      // 更早的槽位：落 skipped 行（audit trail），不执行
      for (const slot of slots.slice(0, -1)) {
        const claim = insertAutomationTaskRun(this.db, {
          taskId: task.id,
          clientId: `${task.id}:${slot}`,
          trigger: 'schedule',
          scheduledFor: slot
        })
        if (claim.inserted) {
          this.markSkipped(claim.runId!)
          skippedCount += 1
        }
      }
      // 最近一次错过：有界补跑（走 P4 执行链，准入取票）
      const lastSlot = slots[slots.length - 1]!
      if (lastSlot <= now) {
        void this.runTask(task.id, {
          trigger: 'schedule',
          requestId: `recover-${task.id}-${lastSlot}`,
          scheduledFor: lastSlot
        })
          .then(() => undefined)
          .catch(() => undefined)
        catchUpCount += 1
        this.rearm(task, now)
      }
    }
    return { skippedCount, catchUpCount, interruptedCount }
  }

  /** 单次 tick：扫描 due 任务 → 幂等抢占 run → 执行链 → 重排。重入由 ticking 标志 + client_id 幂等双保险。 */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      const now = this.nowFn()
      for (const task of this.dueTasks(now)) {
        const scheduledFor = task.nextRunAt!
        await this.runTask(task.id, {
          trigger: 'schedule',
          requestId: `sched-${task.id}-${scheduledFor}`,
          scheduledFor
        })
        this.rearm(task, now)
      }
    } finally {
      this.ticking = false
    }
  }

  private dueTasks(now: number): AutomationTask[] {
    const conn = getDbConnection(this.db)
    void conn
    return listEnabledAutomationTasksDue(this.db, now)
  }

  private markSkipped(runId: string): void {
    const conn = getDbConnection(this.db)
    conn
      .prepare("UPDATE automation_task_runs SET status = 'skipped', error = 'missed-window', updated_at = ? WHERE id = ?")
      .run(Date.now(), runId)
    this.db.save()
  }

  private rearm(task: AutomationTask, now: number): void {
    updateAutomationTask(this.db, task.id, {
      lastRunAt: now,
      nextRunAt: computeNextRunAt(task.schedule, now)
    })
  }
}

export type { AutomationTaskRun }
