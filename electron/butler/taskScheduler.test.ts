import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import { createAutomationTask, getAutomationTask, insertAutomationTaskRun, listAutomationTaskRuns, updateAutomationTaskRun, type AutomationTaskInput } from './taskStore'
import {
  computeNextRunAt,
  enumerateMissedSlots,
  ButlerTaskScheduler,
  type SchedulerRunFn
} from './taskScheduler'

const dbs: AppDatabase[] = []
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
})

function db(): AppDatabase {
  const d = openDatabase(':memory:')
  dbs.push(d)
  return d
}

function taskInput(overrides: Partial<AutomationTaskInput> = {}): AutomationTaskInput {
  return {
    name: '巡检',
    schedule: { kind: 'interval', intervalMinutes: 30 },
    prompt: '检查',
    deliveryPref: 'none',
    ...overrides
  }
}

const MIN = 60_000

describe('schedule 计算（P6 纯函数）', () => {
  it('interval：next = from + intervalMinutes', () => {
    expect(computeNextRunAt({ kind: 'interval', intervalMinutes: 30 }, 1_000)).toBe(1_000 + 30 * MIN)
  })

  it('daily：当天时间未到 → 今天 HH:mm；已过 → 明天 HH:mm', () => {
    const day = new Date(2026, 8, 16, 8, 0).getTime()
    expect(new Date(computeNextRunAt({ kind: 'daily', time: '09:30' }, day))).toEqual(new Date(2026, 8, 16, 9, 30))
    const after = new Date(2026, 8, 16, 10, 0).getTime()
    expect(new Date(computeNextRunAt({ kind: 'daily', time: '09:30' }, after))).toEqual(new Date(2026, 8, 17, 9, 30))
  })

  it('enumerateMissedSlots：interval 错过多次时列出全部到期槽位（有界）', () => {
    const from = 0
    const now = 90 * MIN
    const slots = enumerateMissedSlots({ kind: 'interval', intervalMinutes: 30 }, from, now)
    expect(slots).toEqual([0, 30 * MIN, 60 * MIN, 90 * MIN])
  })

  it('enumerateMissedSlots：超过扫描上限时有界截断（防风暴）', () => {
    const slots = enumerateMissedSlots({ kind: 'interval', intervalMinutes: 30 }, 0, 100 * 24 * 60 * MIN)
    expect(slots.length).toBeLessThanOrEqual(48)
    expect(slots[slots.length - 1]!).toBeLessThanOrEqual(100 * 24 * 60 * MIN)
  })
})

describe('ButlerTaskScheduler（fake clock）', () => {
  it('到点触发：due 任务被 runTask 消费（scheduledFor = next_run_at）并重排 next_run_at / last_run_at', async () => {
    const d = db()
    let now = 10_000
    const task = createAutomationTask(d, taskInput({ nextRunAt: 10_000 }))
    const runTask = vi.fn(async () => ({ ok: true, runId: 'r1', sessionId: 's1', summary: 'ok' })) as unknown as SchedulerRunFn
    const scheduler = new ButlerTaskScheduler({
      db: d,
      runTask,
      isTrayEnabled: () => true,
      now: () => now
    })
    now = 12_000
    await scheduler.tick()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(runTask.mock.calls[0]![1].scheduledFor).toBe(10_000)
    const updated = getAutomationTask(d, task.id)!
    expect(updated.lastRunAt).toBe(12_000)
    expect(updated.nextRunAt).toBe(12_000 + 30 * MIN)
  })

  it('未到期不触发', async () => {
    const d = db()
    let now = 10_000
    createAutomationTask(d, taskInput({ nextRunAt: 60_000 }))
    const runTask = vi.fn(async () => ({ ok: true, runId: 'r1', sessionId: 's1', summary: 'ok' })) as unknown as SchedulerRunFn
    const scheduler = new ButlerTaskScheduler({ db: d, runTask, isTrayEnabled: () => true, now: () => now })
    now = 20_000
    await scheduler.tick()
    expect(runTask).not.toHaveBeenCalled()
  })

  it('有界补跑：错过 3 次只补最近 1 次，更早的标 skipped(missed-window)', async () => {
    const d = db()
    let now = 0
    const task = createAutomationTask(d, taskInput({ nextRunAt: 0 }))
    const runTask = vi.fn(async () => ({ ok: true, runId: 'r1', sessionId: 's1', summary: 'ok' })) as unknown as SchedulerRunFn
    const scheduler = new ButlerTaskScheduler({ db: d, runTask, isTrayEnabled: () => true, now: () => now })

    now = 90 * MIN
    scheduler.recoverOnStartup()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(runTask.mock.calls[0]![1].scheduledFor).toBe(90 * MIN)
    const runs = listAutomationTaskRuns(d, task.id)
    const skipped = runs.filter((r) => r.status === 'skipped')
    // 错过 4 个槽位（0/30m/60m/90m）：更早 3 个 skipped，最近 1 个补跑
    expect(skipped.map((r) => r.scheduledFor).sort()).toEqual([0, 30 * MIN, 60 * MIN])
    expect(skipped.every((r) => r.error === 'missed-window')).toBe(true)
    const updated = getAutomationTask(d, task.id)!
    expect(updated.nextRunAt).toBe(120 * MIN)
  })

  it('崩溃遗留 running 的 run 在启动恢复时标 interrupted', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: `${task.id}:1700000000`, trigger: 'schedule', scheduledFor: 1700000000 })
    updateAutomationTaskRun(d, run.runId!, { status: 'running' })
    const scheduler = new ButlerTaskScheduler({
      db: d,
      runTask: vi.fn() as unknown as SchedulerRunFn,
      isTrayEnabled: () => true,
      now: () => 0
    })
    scheduler.recoverOnStartup()
    expect(listAutomationTaskRuns(d, task.id)[0]?.status).toBe('interrupted')
  })

  it('退出停机：stop 将进行中 run 标 interrupted 并停 tick', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: `${task.id}:m1`, trigger: 'manual', scheduledFor: 0 })
    updateAutomationTaskRun(d, run.runId!, { status: 'running' })
    const scheduler = new ButlerTaskScheduler({
      db: d,
      runTask: vi.fn() as unknown as SchedulerRunFn,
      isTrayEnabled: () => true,
      now: () => 0,
      tickIntervalMs: 1000,
      setIntervalFn: (() => 1) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval
    })
    scheduler.start()
    scheduler.stop()
    expect(listAutomationTaskRuns(d, task.id)[0]?.status).toBe('interrupted')
  })

  it('托盘前提：未启用托盘时不启动 tick 并记录 disabled-no-tray', () => {
    const d = db()
    const logEvents: string[] = []
    const scheduler = new ButlerTaskScheduler({
      db: d,
      runTask: vi.fn() as unknown as SchedulerRunFn,
      isTrayEnabled: () => false,
      now: () => 0,
      setIntervalFn: (() => {
        logEvents.push('interval-set')
        return 1
      }) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
      logWarn: (event: string) => logEvents.push(event)
    })
    scheduler.start()
    expect(logEvents).not.toContain('interval-set')
    expect(logEvents).toContain('automation.scheduler.disabled-no-tray')
  })
})
