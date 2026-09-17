import { describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import { createAutomationTask, getAutomationTask, listEnabledAutomationTasksDue, updateAutomationTask, type AutomationTaskInput } from './taskStore'
import { computeNextRunAt, ButlerTaskScheduler, type SchedulerRunFn } from './taskScheduler'
import { vi } from 'vitest'

/** 一次性任务：给定具体时刻到点执行一次，之后不再执行（执行后任务停用、不再排程）。 */

describe('一次性任务（once schedule）', () => {
  let db: AppDatabase
  const onceInput = (at: number, overrides: Partial<AutomationTaskInput> = {}): AutomationTaskInput => ({
    name: '一次性汇报',
    schedule: { kind: 'once', at },
    prompt: '跑一次',
    deliveryPref: 'none',
    ...overrides
  })

  it('computeNextRunAt(once) 恒等于给定时刻（与 from 无关）', () => {
    expect(computeNextRunAt({ kind: 'once', at: 5_000 }, 9_000)).toBe(5_000)
  })

  it('createAutomationTask 武装 next_run_at = at；到期可被 due 扫描发现', () => {
    db = openDatabase(':memory:')
    const task = createAutomationTask(db, onceInput(10_000))
    expect(task.schedule).toEqual({ kind: 'once', at: 10_000 })
    expect(task.nextRunAt).toBe(10_000)
    expect(listEnabledAutomationTasksDue(db, 9_999).map((t) => t.id)).toEqual([])
    expect(listEnabledAutomationTasksDue(db, 10_000).map((t) => t.id)).toEqual([task.id])
    db.close()
  })

  it('到点触发一次后：任务停用且不再排程，第二次 tick 不再执行', async () => {
    db = openDatabase(':memory:')
    const task = createAutomationTask(db, onceInput(10_000))
    const runTask = vi.fn(async () => ({ ok: true })) as unknown as SchedulerRunFn
    const scheduler = new ButlerTaskScheduler({ db, runTask, isTrayEnabled: () => true, now: () => 12_000 })

    await scheduler.tick()
    expect(runTask).toHaveBeenCalledTimes(1)

    await scheduler.tick()
    await scheduler.tick()
    expect(runTask).toHaveBeenCalledTimes(1)

    const after = getAutomationTask(db, task.id)!
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeUndefined()
    expect(after.lastRunAt).toBe(12_000)
    db.close()
  })

  it('停机错过一次性任务：启动恢复补跑这一次（且仅一次）', () => {
    db = openDatabase(':memory:')
    const task = createAutomationTask(db, onceInput(10_000))
    const runTask = vi.fn(async () => ({ ok: true })) as unknown as SchedulerRunFn
    const scheduler = new ButlerTaskScheduler({ db, runTask, isTrayEnabled: () => true, now: () => 90_000_000 })

    const recovery = scheduler.recoverOnStartup()
    expect(recovery.catchUpCount).toBe(1)
    expect(recovery.skippedCount).toBe(0)
    expect(runTask).toHaveBeenCalledTimes(1)

    const after = getAutomationTask(db, task.id)!
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeUndefined()
    db.close()
  })

  it('重新启用已过期的一次性任务：按 schedule 重算（at 已过 → 到期立即执行一次）', () => {
    db = openDatabase(':memory:')
    const task = createAutomationTask(db, onceInput(10_000))
    updateAutomationTask(db, task.id, { enabled: false })
    const reEnabled = updateAutomationTask(db, task.id, { enabled: true })
    expect(reEnabled?.enabled).toBe(true)
    expect(reEnabled?.nextRunAt).toBe(10_000)
    expect(listEnabledAutomationTasksDue(db, 10_000).map((t) => t.id)).toEqual([task.id])
    db.close()
  })
})
