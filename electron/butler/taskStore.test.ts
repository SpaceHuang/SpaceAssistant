import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import type { AppDatabase } from '../database'
import {
  createAutomationTask,
  updateAutomationTask,
  deleteAutomationTask,
  getAutomationTask,
  listAutomationTasks,
  listEnabledAutomationTasksDue,
  insertAutomationTaskRun,
  updateAutomationTaskRun,
  getLatestRunForTask,
  type AutomationTaskInput
} from './taskStore'

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
    name: '每日巡检',
    schedule: { kind: 'interval', intervalMinutes: 30 },
    prompt: '检查磁盘空间并汇报',
    deliveryPref: 'desktop',
    ...overrides
  }
}

describe('automation_tasks / automation_task_runs（P4 任务表）', () => {
  it('任务 CRUD：创建字段齐全、更新、删除', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    expect(task.id).toBeTruthy()
    expect(task.name).toBe('每日巡检')
    expect(task.schedule).toEqual({ kind: 'interval', intervalMinutes: 30 })
    expect(task.enabled).toBe(true)

    const updated = updateAutomationTask(d, task.id, { enabled: false, deliveryPref: 'none' })
    expect(updated?.enabled).toBe(false)
    expect(updated?.deliveryPref).toBe('none')
    expect(getAutomationTask(d, task.id)?.enabled).toBe(false)

    expect(deleteAutomationTask(d, task.id)).toBe(true)
    expect(getAutomationTask(d, task.id)).toBeUndefined()
  })

  it('client_id 唯一幂等：同键重复插入被忽略（防 tick 重入 / 双投递）', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const first = insertAutomationTaskRun(d, {
      taskId: task.id,
      clientId: `${task.id}:1700000000`,
      trigger: 'schedule',
      scheduledFor: 1700000000
    })
    const duplicate = insertAutomationTaskRun(d, {
      taskId: task.id,
      clientId: `${task.id}:1700000000`,
      trigger: 'schedule',
      scheduledFor: 1700000000
    })
    expect(first.inserted).toBe(true)
    expect(duplicate.inserted).toBe(false)
    expect(duplicate.runId).toBe(first.runId)
  })

  it('run 生命周期与 run 行状态 / usage / summary 落库', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, {
      taskId: task.id,
      clientId: `${task.id}:manual:req-1`,
      trigger: 'manual',
      scheduledFor: 1
    })
    expect(run.runId).toBeTruthy()
    updateAutomationTaskRun(d, run.runId, { status: 'running', sessionId: 'sess-1' })
    updateAutomationTaskRun(d, run.runId, {
      status: 'completed',
      resultSummary: '任务完成：磁盘 42% 已用',
      usageJson: JSON.stringify({ input_tokens: 10, output_tokens: 5 })
    })
    const latest = getLatestRunForTask(d, task.id)
    expect(latest?.status).toBe('completed')
    expect(latest?.sessionId).toBe('sess-1')
    expect(latest?.resultSummary).toContain('磁盘')
  })

  it('到期扫描：enabled=1 且 next_run_at <= now 才返回', () => {
    const d = db()
    createAutomationTask(d, taskInput({ name: 'due', schedule: { kind: 'interval', intervalMinutes: 30 }, nextRunAt: 1000 }))
    createAutomationTask(d, taskInput({ name: 'future', schedule: { kind: 'interval', intervalMinutes: 30 }, nextRunAt: 9000 }))
    createAutomationTask(d, taskInput({ name: 'disabled', schedule: { kind: 'interval', intervalMinutes: 30 }, nextRunAt: 500, enabled: false }))
    const due = listEnabledAutomationTasksDue(d, 5000)
    expect(due.map((t) => t.name)).toEqual(['due'])
  })
})
