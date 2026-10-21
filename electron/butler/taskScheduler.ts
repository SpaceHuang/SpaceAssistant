import { logAgentEvent } from '../agentLogger/agentLogger'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import {
  listEnabledAutomationTasksDue,
  markActiveRunsInterrupted,
  updateAutomationTask,
  claimDueSlotAndAdvance,
  advanceMissedSlotsToCatchUp,
  listPendingScheduledClaims,
  finalizeOnceScheduledRun,
  computeNextRunAt,
  type AutomationTask,
  type AutomationTaskRun,
  type AutomationTaskSchedule
} from './taskStore'

// schedule 计算已移至 taskStore（创建/编辑层也要武装 next_run_at，评审 P0-1）；此处 re-export 保持既有导入路径。
export { computeNextRunAt }

/**
 * 管家定时驱动源（P6，Driver 层）：主进程 setInterval tick + 有界启动恢复。
 * 不引 cron 库（interval / daily 自实现）；外部依赖（准入、执行链）经注入的 runTask 走 P4 执行链。
 * 运行前提：托盘常驻启用（P0 决策 a）——未启用时不启动 tick，日志记录 disabled-no-tray。
 */

export type SchedulerRunRequest = {
  trigger: 'schedule'
  requestId: string
  scheduledFor: number
  runId?: string
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

/** 单次恢复最多保留 48 个最近槽位（含补跑槽位），避免长时间停机产生无界历史。 */
const MAX_MISSED_SLOTS = 48

/** 直接计算最近到期槽位，再最多向前枚举 48 个近期槽位；不会从旧游标扫描整个停机区间。 */
export function enumerateMissedSlots(schedule: AutomationTaskSchedule, from: number, now: number): number[] {
  if (from > now) return []
  let latest: number
  if (schedule.kind === 'interval') {
    const interval = Math.max(1, schedule.intervalMinutes) * 60_000
    latest = from + Math.floor((now - from) / interval) * interval
  } else if (schedule.kind === 'once') {
    latest = from
  } else {
    const [hour, minute] = schedule.time.split(':').map((value) => Number.parseInt(value, 10))
    const candidate = new Date(now)
    candidate.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0)
    if (candidate.getTime() > now) {
      candidate.setDate(candidate.getDate() - 1)
      candidate.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0)
    }
    latest = candidate.getTime()
  }
  if (latest < from || latest > now) return []

  const reversed = [latest]
  let cursor = latest
  while (reversed.length < MAX_MISSED_SLOTS && schedule.kind !== 'once') {
    let previous: number
    if (schedule.kind === 'interval') {
      previous = cursor - Math.max(1, schedule.intervalMinutes) * 60_000
    } else {
      const [hour, minute] = schedule.time.split(':').map((value) => Number.parseInt(value, 10))
      const priorDate = new Date(cursor)
      priorDate.setDate(priorDate.getDate() - 1)
      priorDate.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0)
      previous = priorDate.getTime()
    }
    if (previous < from || previous >= cursor) break
    reversed.push(previous)
    cursor = previous
  }
  return reversed.reverse()
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
    // 评审 P1-1：interval 回调触发的 tick 必须兜底 catch——tick 体内任何逃逸异常
    // （如退出竞态下 db 已关闭）否则成为 unhandled rejection，Electron 默认崩溃主进程。
    this.timer = this.setIntervalFn(() => {
      void this.tick().catch((error) => {
        this.logWarn('automation.scheduler.tick-failed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }, this.tickIntervalMs)
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
    const pendingTaskIds = new Set<string>()
    for (const pending of listPendingScheduledClaims(this.db)) {
      pendingTaskIds.add(pending.task.id)
      void this.runPendingClaim(pending.task, pending.runId, pending.slot, now, `recover-${pending.task.id}-${pending.slot}`)
      catchUpCount += 1
    }
    for (const task of this.dueTasks(now)) {
      if (pendingTaskIds.has(task.id)) continue
      const slots = enumerateMissedSlots(task.schedule, task.nextRunAt!, now)
      if (slots.length === 0) continue
      const catchUpSlot = slots[slots.length - 1]!
      const fastForward = advanceMissedSlotsToCatchUp(this.db, {
        taskId: task.id,
        expectedCursor: task.nextRunAt!,
        catchUpSlot,
        skippedSlots: slots.slice(0, -1)
      })
      if (!fastForward.advanced) {
        this.logWarn('automation.scheduler.catch-up-fast-forward-failed', { taskId: task.id, reason: fastForward.reason })
        continue
      }
      skippedCount += fastForward.skippedCount
      const current = { ...task, nextRunAt: catchUpSlot }
      void this.claimAndRun(current, catchUpSlot, now, `recover-${task.id}-${catchUpSlot}`)
      catchUpCount += 1
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
        await this.claimAndRun(task, scheduledFor, now, `sched-${task.id}-${scheduledFor}`)
      }
    } finally {
      this.ticking = false
    }
  }

  private async claimAndRun(task: AutomationTask, slot: number, now: number, requestId: string): Promise<void> {
    const nextSlot = task.schedule.kind === 'once' ? null : computeNextRunAt(task.schedule, slot)
    const claim = claimDueSlotAndAdvance(this.db, { taskId: task.id, slot, nextSlot, clientId: `${task.id}:${slot}`, allowCursorAdvance: true })
    if (!claim.claimed) {
      if (claim.reason !== 'pending-claim' && claim.reason !== 'not-due') this.logWarn('automation.scheduler.claim-failed', { taskId: task.id, reason: claim.reason })
      return
    }
    await this.runPendingClaim(task, claim.runId, slot, now, requestId)
  }

  private async runPendingClaim(task: AutomationTask, runId: string, slot: number, now: number, requestId: string): Promise<void> {
    const result = await this.runTaskProtected(task, { trigger: 'schedule', requestId, scheduledFor: slot, runId })
    if (result?.ok) {
      if (task.schedule.kind === 'once') {
        finalizeOnceScheduledRun(this.db, runId, now)
      }
      else updateAutomationTask(this.db, task.id, { lastRunAt: now })
    }
  }

  /**
   * 受保护的任务执行入口（评审 P1-1）：单任务异常（执行链抛错 / 退出竞态下落库失败）
   * 吞噬并落 tick-failed 日志，不影响同批后续任务，也不向调用方传播为 unhandled rejection。
   */
  private async runTaskProtected(task: AutomationTask, request: SchedulerRunRequest): Promise<{ ok: boolean } | undefined> {
    try {
      return await this.runTask(task.id, request)
    } catch (error) {
      this.logWarn('automation.scheduler.tick-failed', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error)
      })
      return undefined
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
    // 一次性任务：执行后不再排程——停用任务（next_run_at 随停用置空），满足「之后不再执行」。
    if (task.schedule.kind === 'once') {
      updateAutomationTask(this.db, task.id, { lastRunAt: now, enabled: false })
      return
    }
    updateAutomationTask(this.db, task.id, {
      lastRunAt: now,
      nextRunAt: computeNextRunAt(task.schedule, now)
    })
  }
}

export type { AutomationTaskRun }
