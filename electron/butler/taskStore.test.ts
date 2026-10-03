import { afterEach, describe, expect, it, vi } from 'vitest'
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
  syncAutomationTaskRunDeliveryStatuses,
  getLatestRunForTask,
  getRunById,
  type AutomationTaskInput
} from './taskStore'
import { getDbConnection } from '../database/sqliteStore'
import { createDeliveryHub } from '../driver/deliveryHub'
import { SqliteDeliveryJournal } from '../driver/sqliteDeliveryJournal'
import { createTempDatabase } from '../database/testHelpers'

const dbs: AppDatabase[] = []

afterEach(() => {
  vi.useRealTimers()
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
  it('持续离线跨过投递 TTL 后自动过期并同步管家 run 状态', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const d = db()
    const task = createAutomationTask(d, taskInput({ deliveryPref: 'feishu', deliveryTarget: 'ou_owner' }))
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'offline-expiry-run', trigger: 'manual', scheduledFor: 1_000 })
    updateAutomationTaskRun(d, run.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const journal = new SqliteDeliveryJournal(d)
    const hub = createDeliveryHub({ journal, onDeferredSettled: () => { syncAutomationTaskRunDeliveryStatuses(d) } })
    hub.registerDriver({ id: 'feishu', isReachable: () => false, deliver: async () => undefined })

    await expect(hub.deliver({ target: 'feishu', deliveryId: run.runId, ttlMs: 30_000 }, { kind: 'butler-run-result', text: 'result' }))
      .resolves.toMatchObject({ outcome: 'deferred' })
    expect(getRunById(d, run.runId!)?.deliveryStatus).toBe('pending')

    await vi.advanceTimersByTimeAsync(30_001)

    expect(journal.status(run.runId!, 'feishu')).toBe('expired')
    expect(hub.getRecords()).toContainEqual(expect.objectContaining({ deliveryId: run.runId, outcome: 'expired' }))
    expect(getRunById(d, run.runId!)).toMatchObject({ status: 'completed', deliveryStatus: 'failed-degraded' })
  })

  it('新结果取代旧 deferred 后同步旧管家 run 状态', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ deliveryPref: 'feishu', deliveryTarget: 'ou_owner' }))
    const older = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'superseded-old-run', trigger: 'manual', scheduledFor: 1 })
    const newer = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'superseded-new-run', trigger: 'manual', scheduledFor: 2 })
    updateAutomationTaskRun(d, older.runId!, { status: 'completed', deliveryStatus: 'pending' })
    updateAutomationTaskRun(d, newer.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const journal = new SqliteDeliveryJournal(d)
    let reachable = false
    const hub = createDeliveryHub({ journal, onDeferredSettled: () => { syncAutomationTaskRunDeliveryStatuses(d) } })
    hub.registerDriver({ id: 'feishu', isReachable: () => reachable, deliver: async () => undefined })
    await hub.deliver({ target: 'feishu', deliveryId: older.runId, supersedeKey: task.id }, { kind: 'butler-run-result', text: 'old' })

    reachable = true
    await hub.deliver({ target: 'feishu', deliveryId: newer.runId, supersedeKey: task.id }, { kind: 'butler-run-result', text: 'new' })

    expect(journal.status(older.runId!, 'feishu')).toBe('superseded')
    expect(getRunById(d, older.runId!)).toMatchObject({ status: 'completed', deliveryStatus: 'failed-degraded' })
  })

  it('deferred 队列溢出后同步被丢弃的管家 run 状态', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const dropped = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'overflow-run', trigger: 'manual', scheduledFor: 1 })
    updateAutomationTaskRun(d, dropped.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const journal = new SqliteDeliveryJournal(d)
    const hub = createDeliveryHub({ journal, onDeferredSettled: () => { syncAutomationTaskRunDeliveryStatuses(d) } })
    hub.registerDriver({ id: 'offline', isReachable: () => false, deliver: async () => undefined })
    await hub.deliver({ target: 'offline', deliveryId: dropped.runId }, { kind: 'butler-run-result', text: 'oldest' })

    for (let i = 0; i < 200; i++) {
      await hub.deliver({ target: 'offline', deliveryId: `overflow-fill-${i}` }, { kind: 'result', text: String(i) })
    }

    expect(journal.status(dropped.runId!, 'offline')).toBe('failed')
    expect(getRunById(d, dropped.runId!)).toMatchObject({ status: 'completed', deliveryStatus: 'failed-degraded' })
  })

  it('驱动重注册废弃 deferred 后同步对应管家 run 状态', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'replaced-driver-run', trigger: 'manual', scheduledFor: 1 })
    updateAutomationTaskRun(d, run.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const journal = new SqliteDeliveryJournal(d)
    const hub = createDeliveryHub({ journal, onDeferredSettled: () => { syncAutomationTaskRunDeliveryStatuses(d) } })
    hub.registerDriver({ id: 'replaceable', isReachable: () => false, deliver: async () => undefined })
    await hub.deliver({ target: 'replaceable', deliveryId: run.runId }, { kind: 'butler-run-result', text: 'result' })

    hub.registerDriver({ id: 'replaceable', isReachable: () => true, deliver: async () => undefined })

    expect(journal.status(run.runId!, 'replaceable')).toBe('superseded')
    expect(getRunById(d, run.runId!)).toMatchObject({ status: 'completed', deliveryStatus: 'failed-degraded' })
  })

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

  it('任务配置字段新建、更新、清除并保留 provider model name 语义', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({
      workDir: '/tmp/automation', modelId: 'catalog-a', modelServiceId: 'service-a',
      modelOverride: 'same-provider-name', reasoningEffort: 'high'
    }))
    expect(task).toMatchObject({ workDir: '/tmp/automation', modelId: 'catalog-a', modelServiceId: 'service-a', modelOverride: 'same-provider-name', reasoningEffort: 'high' })
    expect(listAutomationTasks(d)[0]).toMatchObject({ modelId: 'catalog-a', modelServiceId: 'service-a' })
    const updated = updateAutomationTask(d, task.id, { clearConfig: ['workDir', 'modelId', 'modelServiceId', 'reasoningEffort'] })
    expect(updated).not.toHaveProperty('workDir')
    expect(updated).not.toHaveProperty('modelId')
    expect(updated?.modelOverride).toBe('same-provider-name')
  })

  it('运行配置快照初始为空、可更新读取，损坏 JSON 安全降级', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'snapshot-run', trigger: 'manual', scheduledFor: 1 })
    expect(getRunById(d, run.runId!)?.configSnapshot).toBeUndefined()
    const snapshot = { resolutionStatus: 'resolved' as const, workDir: '/task', modelId: 'm1', providerModelName: 'provider-name', serviceId: 's1', requestedEffort: 'high' as const, effectiveEffort: 'off' as const, reasoningDegraded: true }
    updateAutomationTaskRun(d, run.runId!, { configSnapshot: snapshot })
    expect(getRunById(d, run.runId!)?.configSnapshot).toEqual(snapshot)
    getDbConnection(d).prepare('UPDATE automation_task_runs SET config_snapshot_json = ? WHERE id = ?').run('{broken', run.runId!)
    expect(getRunById(d, run.runId!)?.configSnapshot).toBeUndefined()
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

  it('投递 journal 到达终态后收敛对应 run 的 delivery 状态', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const created = insertAutomationTaskRun(d, {
      taskId: task.id,
      clientId: `${task.id}:manual:delivery-sync`,
      trigger: 'manual',
      scheduledFor: 1
    })
    updateAutomationTaskRun(d, created.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const conn = getDbConnection(d)
    conn.prepare(`INSERT INTO driver_deliveries(delivery_id,target,preference_json,payload_json,status,created_at,updated_at)
      VALUES(?, 'feishu', '{}', '{}', 'delivered', 1, 2)`).run(created.runId)

    const { syncAutomationTaskRunDeliveryStatuses } = await import('./taskStore')
    expect(syncAutomationTaskRunDeliveryStatuses(d)).toBe(1)
    expect(getLatestRunForTask(d, task.id)).toMatchObject({ deliveryStatus: 'delivered', deliveredAt: expect.any(Number) })
  })

  it('投递仍待恢复或含不确定目标时不伪报成功', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const pendingRun = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'pending-run', trigger: 'manual', scheduledFor: 1 })
    const uncertainRun = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'uncertain-run', trigger: 'manual', scheduledFor: 2 })
    updateAutomationTaskRun(d, pendingRun.runId!, { status: 'completed', deliveryStatus: 'pending' })
    updateAutomationTaskRun(d, uncertainRun.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const conn = getDbConnection(d)
    const add = conn.prepare(`INSERT INTO driver_deliveries(delivery_id,target,preference_json,payload_json,status,created_at,updated_at)
      VALUES(?, ?, '{}', '{}', ?, 1, 2)`)
    add.run(pendingRun.runId, 'feishu', 'deferred')
    add.run(uncertainRun.runId, 'feishu', 'delivered')
    add.run(uncertainRun.runId, 'wechat', 'delivery-uncertain')

    const { syncAutomationTaskRunDeliveryStatuses } = await import('./taskStore')
    expect(syncAutomationTaskRunDeliveryStatuses(d)).toBe(1)
    expect(getRunById(d, uncertainRun.runId!)?.deliveryStatus).toBe('delivery-uncertain')
  })

  it('多目标部分成功保持 pending，deliveredAt 只记录最后目标实际送达时间', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'partial-target-run', trigger: 'manual', scheduledFor: 1 })
    updateAutomationTaskRun(d, run.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const conn = getDbConnection(d)
    const add = conn.prepare(`INSERT INTO driver_deliveries(delivery_id,target,preference_json,payload_json,status,created_at,updated_at)
      VALUES(?, ?, '{}', '{}', ?, 1, 2)`)
    add.run(run.runId, 'target-a', 'delivered')
    add.run(run.runId, 'target-b', 'deferred')

    const { syncAutomationTaskRunDeliveryStatuses } = await import('./taskStore')
    expect(syncAutomationTaskRunDeliveryStatuses(d, 100)).toBe(0)
    expect(getRunById(d, run.runId!)).toMatchObject({ deliveryStatus: 'pending' })
    expect(getRunById(d, run.runId!)?.deliveredAt).toBeUndefined()
    expect(syncAutomationTaskRunDeliveryStatuses(d, 150)).toBe(0)

    conn.prepare("UPDATE driver_deliveries SET status='delivered', updated_at=200 WHERE delivery_id=? AND target='target-b'").run(run.runId)
    expect(syncAutomationTaskRunDeliveryStatuses(d, 200)).toBe(1)
    expect(getRunById(d, run.runId!)).toMatchObject({ deliveryStatus: 'delivered', deliveredAt: 200 })
  })

  it('多目标部分送达后重启只补 deferred 目标，并将 Butler run 收敛为 delivered', async () => {
    const temp = createTempDatabase('butler-partial-restart-')
    const d = temp.db
    try {
      const task = createAutomationTask(d, taskInput())
      const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'partial-restart-run', trigger: 'manual', scheduledFor: 1 })
      updateAutomationTaskRun(d, run.runId!, { status: 'completed', deliveryStatus: 'pending' })
      let now = 1_000
      const journal = new SqliteDeliveryJournal(d, () => now)
      const firstHub = createDeliveryHub({ journal, now: () => now })
      const sendA = vi.fn(async () => undefined)
      const sendB = vi.fn(async () => undefined)
      firstHub.registerDriver({ id: 'target-a', isReachable: () => true, deliver: sendA })
      firstHub.registerDriver({ id: 'target-b', isReachable: () => false, deliver: sendB })

      await expect(firstHub.deliverAll({ targets: ['target-a', 'target-b'], deliveryId: run.runId }, {
        kind: 'butler-run-result', text: 'result'
      })).resolves.toMatchObject([
        { driverId: 'target-a', outcome: 'delivered' },
        { driverId: 'target-b', outcome: 'deferred' }
      ])
      expect(syncAutomationTaskRunDeliveryStatuses(d, now)).toBe(0)
      expect(getRunById(d, run.runId!)?.deliveryStatus).toBe('pending')
      expect(sendA).toHaveBeenCalledOnce()
      expect(sendB).not.toHaveBeenCalled()

      d.close()
      const reopened = openDatabase(temp.dbPath)
      try {
        now = 1_500
        const restoredJournal = new SqliteDeliveryJournal(reopened, () => now)
        const restoredHub = createDeliveryHub({ journal: restoredJournal, now: () => now })
        const retryA = vi.fn(async () => undefined)
        const retryB = vi.fn(async () => undefined)
        restoredHub.registerDriver({ id: 'target-a', isReachable: () => true, deliver: retryA })
        restoredHub.registerDriver({ id: 'target-b', isReachable: () => true, deliver: retryB })

        await expect(restoredHub.reportReachability('target-b')).resolves.toBe(1)
        expect(retryA).not.toHaveBeenCalled()
        expect(retryB).toHaveBeenCalledOnce()
        expect(restoredJournal.status(run.runId!, 'target-a')).toBe('delivered')
        expect(restoredJournal.status(run.runId!, 'target-b')).toBe('delivered')
        expect(syncAutomationTaskRunDeliveryStatuses(reopened, now)).toBe(1)
        expect(getRunById(reopened, run.runId!)).toMatchObject({
          status: 'completed', deliveryStatus: 'delivered', deliveredAt: now
        })
      } finally {
        reopened.close()
      }
    } finally {
      temp.cleanup()
    }
  })

  it('Driver journal 的 TTL expired 终态应将 Butler run 收敛为 failed-degraded', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'expired-delivery-run', trigger: 'manual', scheduledFor: 1 })
    updateAutomationTaskRun(d, run.runId!, { status: 'completed', deliveryStatus: 'pending' })
    const conn = getDbConnection(d)
    conn.prepare(`INSERT INTO driver_deliveries(delivery_id,target,preference_json,payload_json,status,created_at,updated_at)
      VALUES(?, 'feishu', '{}', '{}', 'expired', 1, 2)`).run(run.runId)

    const { syncAutomationTaskRunDeliveryStatuses } = await import('./taskStore')
    expect(syncAutomationTaskRunDeliveryStatuses(d, 3)).toBe(1)
    expect(getRunById(d, run.runId!)).toMatchObject({ status: 'completed', deliveryStatus: 'failed-degraded' })
    expect(getRunById(d, run.runId!)?.deliveredAt).toBeUndefined()
  })

  it('重启恢复时离线且已过 TTL 的 delivery 会同步终结 Butler run', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const run = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'expired-offline-recovery-run', trigger: 'manual', scheduledFor: 1 })
    updateAutomationTaskRun(d, run.runId!, { status: 'completed', deliveryStatus: 'pending' })
    let now = 1_000
    const journal = new SqliteDeliveryJournal(d, () => now)
    journal.transition({
      deliveryId: run.runId!, target: 'feishu', preference: { target: 'feishu', deliveryId: run.runId!, ttlMs: 500 },
      payload: { kind: 'butler-run-result', text: 'result' }, status: 'pending', createdAt: now
    }, 'deferred')
    now = 1_600

    const recovered = createDeliveryHub({ journal, now: () => now })
    recovered.registerDriver({ id: 'feishu', isReachable: () => false, deliver: async () => undefined })
    expect(journal.status(run.runId!, 'feishu')).toBe('expired')
    expect(syncAutomationTaskRunDeliveryStatuses(d, now)).toBe(1)
    expect(getRunById(d, run.runId!)).toMatchObject({ status: 'completed', deliveryStatus: 'failed-degraded' })
    expect(getRunById(d, run.runId!)?.deliveredAt).toBeUndefined()
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
