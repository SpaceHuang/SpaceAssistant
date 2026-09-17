import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import { createAutomationTask, updateAutomationTask, listEnabledAutomationTasksDue, getAutomationTask, type AutomationTaskInput } from './taskStore'
import { ButlerTaskScheduler, type SchedulerRunFn } from './taskScheduler'

/**
 * 评审 P0-1 回归：渲染端创建/编辑任务不传 nextRunAt（IPC 链路无人赋值），
 * 任务仍必须能被调度器扫描触发——create/update 层按 schedule 自动武装 next_run_at。
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function uiTaskInput(overrides: Partial<AutomationTaskInput> = {}): AutomationTaskInput {
  // 与渲染端 ButlerTaskSettings 提交的载荷一致：不含 nextRunAt
  return {
    name: 'UI 创建的任务',
    schedule: { kind: 'interval', intervalMinutes: 30 },
    prompt: '检查',
    deliveryPref: 'none',
    ...overrides
  }
}

describe('评审 P0-1：UI 创建任务的 next_run_at 自动武装', () => {
  it('createAutomationTask 不传 nextRunAt 时按 schedule 自动计算（非 NULL）', () => {
    const db = openDatabase(':memory:')
    const before = Date.now()
    const task = createAutomationTask(db, uiTaskInput())
    expect(task.nextRunAt).toBeDefined()
    expect(task.nextRunAt!).toBeGreaterThanOrEqual(before)
    expect(task.nextRunAt!).toBeLessThanOrEqual(before + 30 * 60_000 + 5_000)
    db.close()
  })

  it('UI 创建（未显式传 nextRunAt）的任务到期后能被 due 扫描发现并触发', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p0-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'p0.db')
    const db = openDatabase(dbPath)
    const task = createAutomationTask(db, uiTaskInput())
    expect(task.nextRunAt).toBeDefined()

    const runTask = vi.fn(async () => ({ ok: true })) as unknown as SchedulerRunFn
    const scheduler = new ButlerTaskScheduler({ db, runTask, isTrayEnabled: () => true, now: () => task.nextRunAt! + 1_000 })
    await scheduler.tick()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(runTask.mock.calls[0]![0]).toBe(task.id)
    db.close()
  })

  it('更新 schedule 时重算 next_run_at；仅改名/提示词不动既有排程', () => {
    const db = openDatabase(':memory:')
    const task = createAutomationTask(db, uiTaskInput({ nextRunAt: 123_456 }))
    expect(task.nextRunAt).toBe(123_456)

    const renamed = updateAutomationTask(db, task.id, { name: '新名字' })
    expect(renamed?.nextRunAt).toBe(123_456)

    const rescheduled = updateAutomationTask(db, task.id, { schedule: { kind: 'daily', time: '09:30' } })
    expect(rescheduled?.nextRunAt).toBeDefined()
    expect(rescheduled?.nextRunAt).not.toBe(123_456)
    db.close()
  })

  it('停用任务置空 next_run_at；重新启用时按 schedule 重新武装', () => {
    const db = openDatabase(':memory:')
    const task = createAutomationTask(db, uiTaskInput())
    expect(task.nextRunAt).toBeDefined()

    const disabled = updateAutomationTask(db, task.id, { enabled: false })
    expect(disabled?.nextRunAt).toBeUndefined()

    const before = Date.now()
    const enabled = updateAutomationTask(db, task.id, { enabled: true })
    expect(enabled?.nextRunAt).toBeDefined()
    expect(enabled?.nextRunAt!).toBeGreaterThanOrEqual(before)
    db.close()
  })

  it('due 扫描不返回已停用任务（next_run_at 置空后）', () => {
    const db = openDatabase(':memory:')
    const task = createAutomationTask(db, uiTaskInput({ nextRunAt: 1 }))
    updateAutomationTask(db, task.id, { enabled: false })
    expect(listEnabledAutomationTasksDue(db, Date.now() + 10 ** 9)).toHaveLength(0)
    expect(getAutomationTask(db, task.id)?.enabled).toBe(false)
    db.close()
  })
})
