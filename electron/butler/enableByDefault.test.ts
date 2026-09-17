import { describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { createAutomationTask, getAutomationTask, listEnabledAutomationTasksDue, type AutomationTaskInput } from './taskStore'

/** 产品要求：新建的定时任务默认开启（不传 enabled 即启用），防止用户忘记启用导致任务「看似建好实则不跑」。 */

function uiPayload(): AutomationTaskInput {
  // 与渲染端 ButlerTaskSettings 提交载荷一致：不传 enabled
  return { name: '巡检', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: '跑', deliveryPref: 'desktop' }
}

describe('新建任务默认开启', () => {
  it('createAutomationTask 不传 enabled：任务启用且已武装 next_run_at', () => {
    const db = openDatabase(':memory:')
    const task = createAutomationTask(db, uiPayload())
    expect(task.enabled).toBe(true)
    expect(task.nextRunAt).toBeDefined()
    db.close()
  })

  it('默认开启的任务立即可被 due 扫描发现（到点即跑）', () => {
    const db = openDatabase(':memory:')
    const task = createAutomationTask(db, uiPayload())
    expect(task.nextRunAt).toBeDefined()
    expect(listEnabledAutomationTasksDue(db, task.nextRunAt!).map((t) => t.id)).toContain(task.id)
    db.close()
  })

  it('显式 enabled:false 仍然成立（用户/后续调用方明确要求停用）', () => {
    const db = openDatabase(':memory:')
    const task = createAutomationTask(db, { ...uiPayload(), enabled: false })
    expect(task.enabled).toBe(false)
    expect(getAutomationTask(db, task.id)?.enabled).toBe(false)
    db.close()
  })
})
