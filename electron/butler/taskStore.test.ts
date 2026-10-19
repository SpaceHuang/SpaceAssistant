import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { openDatabase } from '../database'
import type { AppDatabase } from '../database'
import {
  createAutomationTask,
  updateAutomationTask,
  updateAutomationTaskConditional,
  deleteAutomationTask,
  getAutomationTask,
  listAutomationTasks,
  listAutomationTaskRuns,
  listEnabledAutomationTasksDue,
  insertAutomationTaskRun,
  insertManualTaskClaim,
  transitionClaimToRunning,
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
import type { TargetBinding } from '../../src/shared/automationTaskTypes'

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
    workDirs: ['/tmp/automation'],
    ...overrides
  }
}

describe('automation_tasks / automation_task_runs（P4 任务表）', () => {
  it('round-trips the result output directory and organization without converting legacy authorized roots', () => {
    const d = db()
    const input = Object.assign(taskInput({ workDirs: ['/authorized/source'] }), {
      authorizedDirs: ['/authorized/source'],
      outputDir: '/results',
      outputOrganization: 'hourly',
    })
    const task = createAutomationTask(d, input)

    expect(task).toMatchObject({
      workDirs: ['/authorized/source'],
      authorizedDirs: ['/authorized/source'],
      outputDir: '/results',
      outputOrganization: 'hourly',
    })
  })

  it('accepts Shell access only from the trusted authorization record and freezes that record into the run snapshot', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({
      authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'],
      accessPermissions: { directories: ['/ignored/client-copy'], tools: ['run_shell'] }
    } as never))
    expect(task.accessPermissions?.tools).toEqual([])
    getDbConnection(d).prepare('UPDATE automation_tasks SET access_permissions_json = ? WHERE id = ?')
      .run(JSON.stringify({ directories: ['/authorized/source'], tools: ['run_shell'] }), task.id)
    expect(getAutomationTask(d, task.id)?.accessPermissions?.tools).toEqual([])

    const authorizedTask = createAutomationTask(d, taskInput({
      name: 'approved shell task', authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'],
      accessPermissions: { directories: ['/ignored/client-copy'], tools: [] }, outputDir: '/results', outputOrganization: 'hourly'
    } as never), {
      targetBindings: [],
      authorizationRecord: {
        id: 'authorization-1', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 123,
        taskRevision: 1, preflightFactsDigest: 'facts-digest', permissions: [
          { kind: 'local-shell', scopeRoots: ['/authorized/source'], commands: [{ command: 'git log --oneline -5', workingDirectory: '/authorized/source', timeout: 60 }] },
          { kind: 'grep', scopeRoots: ['/authorized/source'] },
          { kind: 'run-script', scopeRoots: ['/authorized/source'], scriptHashBinding: 'per-invocation' },
          { kind: 'mcp-tool', serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues', purpose: 'Find current issues', parameters: [{ name: 'query', required: true }], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64) },
          { kind: 'result-write', outputDirectory: '/results', organization: 'hourly' }
        ],
        preflightTrace: [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'TODO', path: '/authorized/source' }, dispatch: 'simulated', resultKind: 'synthetic' }]
      }
    } as never)
    const claimed = insertManualTaskClaim(d, authorizedTask.id, 'shell-grant-snapshot')
    const started = transitionClaimToRunning(d, claimed.runId!, authorizedTask.id, 0, claimed.scheduleGeneration!)

    expect(authorizedTask.accessPermissions).toMatchObject({ directories: ['/authorized/source'], tools: ['run_shell', 'grep', 'run_script'], authorizationRecord: { id: 'authorization-1' } })
    expect(started).toMatchObject({ ok: true, snapshot: { accessPermissions: { directories: ['/authorized/source'], tools: ['run_shell', 'grep', 'run_script'], authorizationRecord: { id: 'authorization-1' } } } })
    updateAutomationTaskConditional(d, authorizedTask.id, { accessPermissions: { directories: ['/authorized/source'], tools: [] } } as never)
    expect(getRunById(d, claimed.runId!)?.configSnapshot?.accessPermissions).toMatchObject({ directories: ['/authorized/source'], tools: ['run_shell', 'grep', 'run_script'], authorizationRecord: { id: 'authorization-1' } })
    expect(getRunById(d, claimed.runId!)?.configSnapshot?.accessPermissions?.authorizationRecord?.preflightTrace).toEqual([
      { kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'TODO', path: '/authorized/source' }, dispatch: 'simulated', resultKind: 'synthetic' }
    ])
  })

  it('does not expose a persisted authorization receipt after its task revision becomes stale', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'] }), {
      authorizationRecord: {
        id: 'authorization-stale', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 123,
        taskRevision: 1, permissions: [{ kind: 'local-shell', scopeRoots: ['/authorized/source'], commands: [{ command: 'git log', workingDirectory: '/authorized/source' }] }]
      }
    })
    getDbConnection(d).prepare('UPDATE automation_tasks SET task_revision = ? WHERE id = ?').run(2, task.id)

    expect(getAutomationTask(d, task.id)?.accessPermissions).toMatchObject({ directories: ['/authorized/source'], tools: [] })
    expect(getAutomationTask(d, task.id)?.accessPermissions?.authorizationRecord).toBeUndefined()
  })

  it('does not upgrade historical tool-name or root-only Shell grants into parameter authorization', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'] }), {
      authorizationRecord: {
        id: 'legacy-shell-receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 123,
        taskRevision: 1, permissions: [{ kind: 'local-shell', scopeRoots: ['/authorized/source'] }]
      }
    } as never)
    expect(getAutomationTask(d, task.id)?.accessPermissions).toMatchObject({ directories: ['/authorized/source'], tools: [] })
    expect(getAutomationTask(d, task.id)?.accessPermissions?.authorizationRecord).toBeUndefined()
  })

  it('rejects MCP task grants without valid host fingerprints and parameter metadata', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'] }), {
      authorizationRecord: {
        id: 'bad-mcp-receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 123,
        taskRevision: 1, permissions: [{ kind: 'mcp-tool', serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search',
          description: 'Search issues', purpose: 'Find issues', parameters: [], descriptorHash: 'invalid', profileHash: 'b'.repeat(64) }]
      }
    } as never)

    expect(getAutomationTask(d, task.id)?.accessPermissions?.authorizationRecord).toBeUndefined()
  })

  it('rejects an authorization receipt whose persisted mock trace exceeds its item budget', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'] }), {
      authorizationRecord: {
        id: 'oversized-preflight-trace', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 123,
        taskRevision: 1, permissions: [{ kind: 'result-write', outputDirectory: '/results', organization: 'daily' }],
        preflightTrace: Array.from({ length: 13 }, (_, index) => ({
          kind: 'proposed-tool-call' as const, toolName: 'grep', input: { pattern: `p-${index}` }, dispatch: 'simulated' as const
        }))
      }
    } as never)

    expect(getAutomationTask(d, task.id)?.accessPermissions?.authorizationRecord).toBeUndefined()
  })

  it('ignores legacy Shell timeout metadata when loading an authorization receipt', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ authorizedDirs: ['/authorized/source'], workDirs: ['/authorized/source'] }), {
      authorizationRecord: {
        id: 'invalid-shell-timeout', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 123,
        taskRevision: 1, permissions: [{ kind: 'local-shell', scopeRoots: ['/authorized/source'], commands: [{ command: 'git log', workingDirectory: '/authorized/source', timeout: 86401 }] }]
      }
    } as never)

    expect(getAutomationTask(d, task.id)?.accessPermissions?.tools).toEqual(['run_shell'])
    expect(getAutomationTask(d, task.id)?.accessPermissions?.authorizationRecord?.permissions).toEqual([
      { kind: 'local-shell', scopeRoots: ['/authorized/source'], commands: [{ command: 'git log', workingDirectory: '/authorized/source' }] }
    ])
  })

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
      workDirs: ['/tmp/automation'], modelId: 'catalog-a', modelServiceId: 'service-a',
      modelOverride: 'same-provider-name', reasoningEffort: 'high'
    }))
    expect(task).toMatchObject({ workDirs: ['/tmp/automation'], modelId: 'catalog-a', modelServiceId: 'service-a', modelOverride: 'same-provider-name', reasoningEffort: 'high' })
    expect(listAutomationTasks(d)[0]).toMatchObject({ modelId: 'catalog-a', modelServiceId: 'service-a' })
    const updated = updateAutomationTask(d, task.id, { clearConfig: ['workDirs', 'modelId', 'modelServiceId', 'reasoningEffort'] })
    expect(updated?.workDirs).toEqual([])
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

describe('automation task multi-root compatibility storage', () => {
  it('round-trips multiple canonical roots and treats explicit empty roots as empty', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ workDirs: ['/workspace/a', '/workspace/b'] }))
    expect(getAutomationTask(d, task.id)).toMatchObject({ workDirs: ['/workspace/a', '/workspace/b'] })
    expect(getDbConnection(d).prepare('SELECT work_dirs_json,work_dir FROM automation_tasks WHERE id=?').get(task.id)).toEqual({
      work_dirs_json: '["/workspace/a","/workspace/b"]', work_dir: null,
    })

    const updated = updateAutomationTask(d, task.id, { workDirs: [] })
    expect(updated?.workDirs).toEqual([])
    expect(getAutomationTask(d, task.id)?.workDirs).toEqual([])
  })

  it('adapts a legacy single root into workDirs while preserving the legacy column', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ workDirs: ['/legacy/root'] }))
    getDbConnection(d).prepare('UPDATE automation_tasks SET work_dirs_json=NULL,work_dir=? WHERE id=?').run('/legacy/root', task.id)
    expect(getAutomationTask(d, task.id)).toMatchObject({ workDirs: ['/legacy/root'] })
    const row = getDbConnection(d).prepare('SELECT work_dirs_json,work_dir FROM automation_tasks WHERE id=?').get(task.id)
    expect(row).toEqual({ work_dirs_json: null, work_dir: '/legacy/root' })
  })
})

describe('task revision and schedule generation', () => {
  it('advances task revision on edits and schedule generation only on scheduling changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const d = db()
    const task = createAutomationTask(d, taskInput())
    expect(task).toMatchObject({ taskRevision: 0, scheduleGeneration: 0 })
    const initialState = getDbConnection(d).prepare('SELECT schedule_generation,recovery_cursor_at FROM automation_task_recovery_state WHERE task_id=?').get(task.id)
    expect(initialState).toEqual({ schedule_generation: 0, recovery_cursor_at: task.nextRunAt })

    const edited = updateAutomationTask(d, task.id, { prompt: 'changed prompt' })
    expect(edited).toMatchObject({ taskRevision: 1, scheduleGeneration: 0, nextRunAt: task.nextRunAt })
    expect(getDbConnection(d).prepare('SELECT schedule_generation,recovery_cursor_at FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ schedule_generation: 0, recovery_cursor_at: task.nextRunAt })

    const rescheduled = updateAutomationTask(d, task.id, { schedule: { kind: 'interval', intervalMinutes: 60 } })
    expect(rescheduled).toMatchObject({ taskRevision: 2, scheduleGeneration: 1, nextRunAt: 3_610_000 })
    expect(getDbConnection(d).prepare('SELECT schedule_generation,recovery_cursor_at FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ schedule_generation: 1, recovery_cursor_at: 3_610_000 })
  })

  it('conditionally commits a preflight update only against its expected revision', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ workDirs: ['/workspace'] }))
    const newer = updateAutomationTask(d, task.id, { prompt: 'newer prompt' })!
    const stale = updateAutomationTaskConditional(d, task.id, { prompt: 'stale overwrite', expectedTaskRevision: task.taskRevision }, {
      targetBindings: [{ kind: 'exact', path: '/workspace/a.txt', targetType: 'file', targetReference: { kind: 'basename', value: 'a.txt' }, rawText: 'a.txt', resolverVersion: 2, rootsDigest: 'roots', taskRevision: 1 }]
    })
    expect(stale).toEqual({ ok: false, reason: 'task-revision-conflict' })
    expect(getAutomationTask(d, task.id)).toMatchObject({ prompt: 'newer prompt', taskRevision: newer.taskRevision, preflightVersion: 0 })
  })
})


describe('preflight binding persistence', () => {
  it('commits v1 and target bindings together with task changes', () => {
    const d = db()
    const targetBindings: TargetBinding[] = [{
      kind: 'exact', path: '/workspace/report.csv', targetType: 'file', targetReference: { kind: 'basename', value: 'report.csv' }, rawText: 'report.csv',
      resolverVersion: 2, rootsDigest: 'roots-digest', taskRevision: 1,
    }]
    const task = createAutomationTask(d, taskInput({ workDirs: ['/workspace'] }), { targetBindings })
    expect(task).toMatchObject({ preflightVersion: 1, targetBindingsJson: JSON.stringify(targetBindings) })
    const updatedBindings = targetBindings.map((binding) => ({ ...binding, taskRevision: 2 }))
    const updated = updateAutomationTask(d, task.id, { prompt: 'updated' }, { targetBindings: updatedBindings })
    expect(updated).toMatchObject({ preflightVersion: 1, targetBindingsJson: JSON.stringify(updatedBindings), taskRevision: 2 })
    expect(getAutomationTask(d, task.id)).toMatchObject({ preflightVersion: 1, targetBindingsJson: JSON.stringify(updatedBindings) })
  })
})

describe('queued claim snapshot CAS', () => {
  it('freezes split directory configuration and resolves the archive from the claimed slot with empty authorized roots', async () => {
    const d = db()
    const scheduledFor = new Date(2026, 9, 18, 7, 15).getTime()
    const targetBindings: TargetBinding[] = [{
      kind: 'output', path: '/results/reports/summary.txt', ancestor: '/results', relativeSuffix: 'reports/summary.txt', outputRoot: '/results',
      expectedType: 'file', rawText: 'write summary', resolverVersion: 3, rootsDigest: 'output-digest', taskRevision: 1,
    }]
    const task = createAutomationTask(d, taskInput({
      schedule: { kind: 'interval', intervalMinutes: 60 },
      workDirs: [], authorizedDirs: [], outputDir: '/results', outputOrganization: 'hourly', nextRunAt: scheduledFor,
    }), { targetBindings })
    const { claimDueSlotAndAdvance } = await import('./taskStore')
    const claim = claimDueSlotAndAdvance(d, { taskId: task.id, slot: scheduledFor, nextSlot: scheduledFor + 60 * 60 * 1000, clientId: 'split-output-snapshot' })
    expect(claim.claimed).toBe(true)
    const editedBindings: TargetBinding[] = [{
      ...targetBindings[0]!, path: '/new-results/report.txt', ancestor: '/new-results', relativeSuffix: 'report.txt', outputRoot: '/new-results', taskRevision: 2,
    }]
    updateAutomationTask(d, task.id, { authorizedDirs: ['/authorized/new'], outputDir: '/new-results', outputOrganization: 'daily' }, { targetBindings: editedBindings })

    const started = transitionClaimToRunning(d, claim.runId!, task.id, scheduledFor, 0)

    expect(started).toMatchObject({ ok: true, snapshot: {
      authorizedDirs: ['/authorized/new'], workDirs: ['/authorized/new'], outputDir: '/new-results', outputOrganization: 'daily', scheduledFor,
      runOutputDir: path.join('/new-results', '20261018'), targetSelections: editedBindings,
    } })
  })

  it('manual claim freezes task revision exactly once when resumed', () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ workDirs: ['/workspace/one', '/workspace/two'] }))
    const claim = insertManualTaskClaim(d, task.id, 'manual-snapshot')
    expect(claim.inserted).toBe(true)
    const updated = updateAutomationTask(d, task.id, { prompt: 'updated prompt', workDirs: ['/workspace/new'] })!
    const started = transitionClaimToRunning(d, claim.runId!, task.id, 0, claim.scheduleGeneration!)
    expect(started).toMatchObject({ ok: true, snapshot: { prompt: 'updated prompt', workDirs: ['/workspace/new'], taskRevision: updated.taskRevision } })
    expect(transitionClaimToRunning(d, claim.runId!, task.id, 0, claim.scheduleGeneration!)).toMatchObject({ ok: false, reason: 'claim-not-queued' })
  })

  it('freezes the latest edited task revision exactly once when queued work starts', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ workDirs: ['/workspace/old'], nextRunAt: 123 }))
    const { claimDueSlotAndAdvance, transitionClaimToRunning } = await import('./taskStore')
    const claim = claimDueSlotAndAdvance(d, { taskId: task.id, slot: 123, nextSlot: 456, clientId: 'queued-snapshot-cas' })
    updateAutomationTask(d, task.id, { prompt: 'new prompt', workDirs: ['/workspace/new'] })

    const first = transitionClaimToRunning(d, claim.runId!, task.id, 123, 0)
    const duplicate = transitionClaimToRunning(d, claim.runId!, task.id, 123, 0)
    expect(first).toMatchObject({ ok: true, snapshot: { taskRevision: 1, prompt: 'new prompt', workDirs: ['/workspace/new'] } })
    expect(duplicate).toEqual({ ok: false, reason: 'claim-not-queued' })
    expect(getRunById(d, claim.runId!)).toMatchObject({ status: 'running', runPhase: 'running', taskRevision: 1, scheduleGeneration: 0, slotAt: 123 })
  })
})

describe('claim terminal cleanup identity', () => {
  it('clears only the pending claim with the matching run id and schedule generation', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput())
    const first = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'pending-first', trigger: 'schedule', scheduledFor: 100 })
    const conn = getDbConnection(d)
    conn.prepare(`UPDATE automation_task_recovery_state SET pending_run_id=?,pending_run_slot=?,pending_schedule_generation=0 WHERE task_id=?`)
      .run(first.runId, 100, task.id)
    const { finalizeClaimAndClearPending } = await import('./taskStore')
    expect(finalizeClaimAndClearPending(d, first.runId!, 'completed')).toEqual({ updated: true, clearedPending: true })
    expect(conn.prepare('SELECT pending_run_id,pending_schedule_generation FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ pending_run_id: null, pending_schedule_generation: null })

    const second = insertAutomationTaskRun(d, { taskId: task.id, clientId: 'pending-second', trigger: 'schedule', scheduledFor: 200 })
    conn.prepare(`UPDATE automation_task_recovery_state SET pending_run_id=?,pending_run_slot=?,pending_schedule_generation=1 WHERE task_id=?`)
      .run(second.runId, 200, task.id)
    expect(finalizeClaimAndClearPending(d, first.runId!, 'failed', 'late completion')).toEqual({ updated: false, clearedPending: false })
    expect(conn.prepare('SELECT pending_run_id,pending_schedule_generation FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ pending_run_id: second.runId, pending_schedule_generation: 1 })
  })

  it('keeps a matching queued schedule claim for same-run recovery and interrupts running claims transactionally', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 100 }))
    const { claimDueSlotAndAdvance, listPendingScheduledClaims, markActiveRunsInterrupted, transitionClaimToRunning } = await import('./taskStore')
    const claim = claimDueSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'recover-existing-claim' })
    expect(markActiveRunsInterrupted(d)).toBe(0)
    expect(listPendingScheduledClaims(d).map((pending) => pending.runId)).toEqual([claim.runId])
    expect(transitionClaimToRunning(d, claim.runId!, task.id, 100, 0).ok).toBe(true)
    expect(markActiveRunsInterrupted(d)).toBe(1)
    expect(getRunById(d, claim.runId!)).toMatchObject({ status: 'interrupted', error: 'interrupted' })
    expect(getDbConnection(d).prepare('SELECT pending_run_id,recovery_cursor_at FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ pending_run_id: null, recovery_cursor_at: 200 })
  })
})

describe('atomic due slot claim', () => {
  it('creates one pending claim and advances nextRunAt with the recovery cursor atomically', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 100 }))
    const { claimDueSlotAndAdvance } = await import('./taskStore')
    const first = claimDueSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'due-slot-100' })
    expect(first).toMatchObject({ claimed: true, runId: expect.any(String) })
    expect(claimDueSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'due-slot-100' })).toEqual(first)
    expect(getAutomationTask(d, task.id)?.nextRunAt).toBe(200)
    expect(getRunById(d, first.runId!)).toMatchObject({ status: 'queued', runPhase: 'queued-before-start', slotAt: 100, scheduleGeneration: 0 })
    expect(getDbConnection(d).prepare('SELECT schedule_generation,recovery_cursor_at,pending_run_id,pending_run_slot,pending_schedule_generation FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ schedule_generation: 0, recovery_cursor_at: 100, pending_run_id: first.runId, pending_run_slot: 100, pending_schedule_generation: 0 })
    expect(claimDueSlotAndAdvance(d, { taskId: task.id, slot: 200, nextSlot: 300, clientId: 'due-slot-200' })).toEqual({ claimed: false, reason: 'pending-claim' })
    expect(getAutomationTask(d, task.id)?.nextRunAt).toBe(200)
    const { finalizeClaimAndClearPending } = await import('./taskStore')
    expect(finalizeClaimAndClearPending(d, first.runId!, 'completed')).toEqual({ updated: true, clearedPending: true })
    expect(getDbConnection(d).prepare('SELECT recovery_cursor_at,pending_run_id FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ recovery_cursor_at: 200, pending_run_id: null })
  })

  it('allows a startup catch-up claim to advance from the already-recorded recovery cursor', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 100 }))
    const { claimDueSlotAndAdvance, recordSkippedSlotAndAdvance } = await import('./taskStore')
    expect(recordSkippedSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'skip-100' }).recorded).toBe(true)
    expect(recordSkippedSlotAndAdvance(d, { taskId: task.id, slot: 200, nextSlot: 300, clientId: 'skip-200' }).recorded).toBe(true)
    const catchUp = claimDueSlotAndAdvance(d, { taskId: task.id, slot: 300, nextSlot: 400, clientId: 'catch-up-300', allowCursorAdvance: true })
    expect(catchUp.claimed).toBe(true)
    expect(getAutomationTask(d, task.id)?.nextRunAt).toBe(400)
    expect(getRunById(d, catchUp.runId!)).toMatchObject({ status: 'queued', slotAt: 300 })
  })

  it('terminal update preserves result fields and clears its scheduled pending claim atomically', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 100 }))
    const { claimDueSlotAndAdvance } = await import('./taskStore')
    const claim = claimDueSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'terminal-100' })
    updateAutomationTaskRun(d, claim.runId!, { status: 'completed', resultSummary: 'done', deliveryStatus: 'pending' })
    expect(getRunById(d, claim.runId!)).toMatchObject({ status: 'completed', resultSummary: 'done', deliveryStatus: 'pending' })
    expect(getDbConnection(d).prepare('SELECT recovery_cursor_at,pending_run_id,pending_run_slot FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ recovery_cursor_at: 200, pending_run_id: null, pending_run_slot: null })
  })
})

describe('pending claim task mutation conflicts', () => {
  it('blocks schedule changes while queued, allows config edits, and keeps running claims across new generations', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ workDirs: ['/workspace/old'], nextRunAt: 100 }))
    const { claimDueSlotAndAdvance, transitionClaimToRunning } = await import('./taskStore')
    const claim = claimDueSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'pending-mutations' })
    expect(claim.claimed).toBe(true)
    expect(updateAutomationTask(d, task.id, { schedule: { kind: 'daily', time: '10:00' } })).toBeUndefined()
    expect(updateAutomationTask(d, task.id, { prompt: 'edit while queued' })).toMatchObject({ taskRevision: 1, scheduleGeneration: 0 })
    expect(transitionClaimToRunning(d, claim.runId!, task.id, 100, 0)).toMatchObject({ ok: true })
    updateAutomationTask(d, task.id, { prompt: 'edit while running', workDirs: ['/workspace/new'] })
    expect(getRunById(d, claim.runId!)?.configSnapshot).toMatchObject({ prompt: 'edit while queued', workDirs: ['/workspace/old'], taskRevision: 1 })

    const scheduleChanged = updateAutomationTask(d, task.id, { schedule: { kind: 'daily', time: '10:00' } })
    expect(scheduleChanged).toMatchObject({ scheduleGeneration: 1 })
    expect(getDbConnection(d).prepare('SELECT schedule_generation,pending_run_id,pending_schedule_generation FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toMatchObject({ schedule_generation: 1, pending_run_id: claim.runId, pending_schedule_generation: 0 })
    expect(deleteAutomationTask(d, task.id)).toBe(false)
  })
})

describe('atomic missed-slot skip', () => {
  it('writes the complete skipped result and advances the cursor exactly once', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 100 }))
    const { recordSkippedSlotAndAdvance } = await import('./taskStore')
    const input = { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'missed-slot-100' }
    const first = recordSkippedSlotAndAdvance(d, input)
    expect(first).toMatchObject({ recorded: true, runId: expect.any(String) })
    expect(getRunById(d, first.runId!)).toMatchObject({ status: 'skipped', error: 'missed-window', deliveryStatus: 'none', runPhase: 'terminal', slotAt: 100 })
    expect(getAutomationTask(d, task.id)?.nextRunAt).toBe(200)
    expect(getDbConnection(d).prepare('SELECT recovery_cursor_at,pending_run_id FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ recovery_cursor_at: 200, pending_run_id: null })
    expect(recordSkippedSlotAndAdvance(d, input)).toEqual(first)
    expect(getDbConnection(d).prepare("SELECT COUNT(*) AS count FROM automation_task_runs WHERE client_id='missed-slot-100'").get()).toEqual({ count: 1 })
  })
})


describe('task recovery transaction rollback', () => {
  it('does not leave a task row when recovery state creation fails', () => {
    const d = db()
    const conn = getDbConnection(d)
    conn.exec(`CREATE TRIGGER reject_recovery_insert BEFORE INSERT ON automation_task_recovery_state
      BEGIN SELECT RAISE(ABORT,'injected recovery insert failure'); END;`)
    expect(() => createAutomationTask(d, taskInput())).toThrow(/injected recovery insert failure/)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM automation_tasks').get()).toEqual({ count: 0 })
  })

  it('rolls back a due run insert and next slot when pending-state write fails', async () => {
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 100 }))
    const conn = getDbConnection(d)
    conn.exec(`CREATE TRIGGER reject_pending_claim BEFORE UPDATE OF pending_run_id ON automation_task_recovery_state
      BEGIN SELECT RAISE(ABORT,'injected pending-state failure'); END;`)
    const { claimDueSlotAndAdvance } = await import('./taskStore')
    expect(() => claimDueSlotAndAdvance(d, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'rollback-claim' }))
      .toThrow(/injected pending-state failure/)
    expect(getAutomationTask(d, task.id)?.nextRunAt).toBe(100)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM automation_task_runs WHERE client_id=?').get('rollback-claim')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT recovery_cursor_at,pending_run_id FROM automation_task_recovery_state WHERE task_id=?').get(task.id))
      .toEqual({ recovery_cursor_at: 100, pending_run_id: null })
  })
})

describe('recovery lifecycle randomized invariants', () => {
  it('preserves cursor and pending identity through deterministic randomized schedule/config/restart operations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const d = db()
    const task = createAutomationTask(d, taskInput({ nextRunAt: 1_000_000 }))
    const { claimDueSlotAndAdvance, markActiveRunsInterrupted, recordSkippedSlotAndAdvance, transitionClaimToRunning } = await import('./taskStore')
    let seed = 0x51a7
    const random = () => { seed = (seed * 48271) % 0x7fffffff; return seed }
    for (let step = 0; step < 120; step += 1) {
      const current = getAutomationTask(d, task.id)!
      const recovery = getDbConnection(d).prepare('SELECT * FROM automation_task_recovery_state WHERE task_id=?').get(task.id) as { pending_run_id: string | null; pending_run_slot: number | null; pending_schedule_generation: number | null; recovery_cursor_at: number | null; schedule_generation: number }
      const op = random() % 7
      if (op === 0) updateAutomationTask(d, task.id, { prompt: `prompt-${step}` })
      else if (op === 1 && !recovery.pending_run_id) {
        const slot = current.nextRunAt ?? Date.now()
        vi.setSystemTime(slot)
        claimDueSlotAndAdvance(d, { taskId: task.id, slot, nextSlot: slot + 300_000, clientId: `${task.id}:${slot}` })
      } else if (op === 2 && recovery.pending_run_id) {
        const run = getRunById(d, recovery.pending_run_id)!
        if (run.status === 'queued') transitionClaimToRunning(d, run.id, task.id, run.scheduledFor, run.scheduleGeneration!)
        else updateAutomationTaskRun(d, run.id, { status: 'completed', resultSummary: `result-${step}` })
      } else if (op === 3 && !recovery.pending_run_id) {
        const slot = current.nextRunAt
        if (slot != null) recordSkippedSlotAndAdvance(d, { taskId: task.id, slot, nextSlot: slot + 300_000, clientId: `${task.id}:${slot}` })
      } else if (op === 4) {
        const run = recovery.pending_run_id ? getRunById(d, recovery.pending_run_id) : undefined
        if (!run || run.status === 'running') markActiveRunsInterrupted(d, `restart-${step}`)
      } else if (op === 5) {
        const run = recovery.pending_run_id ? getRunById(d, recovery.pending_run_id) : undefined
        if (run?.runPhase === 'running' || !run) updateAutomationTask(d, task.id, { schedule: { kind: 'interval', intervalMinutes: step % 2 ? 5 : 10 } })
      } else if (op === 6 && !recovery.pending_run_id) {
        updateAutomationTask(d, task.id, { enabled: !current.enabled })
      }

      const afterTask = getAutomationTask(d, task.id)!
      const afterState = getDbConnection(d).prepare('SELECT * FROM automation_task_recovery_state WHERE task_id=?').get(task.id) as { pending_run_id: string | null; pending_run_slot: number | null; pending_schedule_generation: number | null; recovery_cursor_at: number | null; schedule_generation: number }
      expect(afterState.schedule_generation).toBe(afterTask.scheduleGeneration)
      if (!afterState.pending_run_id) {
        expect(afterState.pending_run_slot).toBeNull()
        expect(afterState.pending_schedule_generation).toBeNull()
        expect(afterState.recovery_cursor_at).toBe(afterTask.nextRunAt ?? null)
      } else {
        const pending = getRunById(d, afterState.pending_run_id)!
        expect(['queued', 'running']).toContain(pending.status)
        expect(afterState.pending_run_slot).toBe(pending.slotAt)
        expect(afterState.pending_schedule_generation).toBe(pending.scheduleGeneration)
        if (pending.status === 'queued') {
          expect(pending.scheduleGeneration).toBe(afterTask.scheduleGeneration)
          expect(afterState.recovery_cursor_at).toBe(pending.slotAt)
          expect(afterTask.nextRunAt).toBeGreaterThan(pending.slotAt!)
        }
      }
      const allRuns = listAutomationTaskRuns(d, task.id)
      expect(new Set(allRuns.map((run) => run.clientId)).size).toBe(allRuns.length)
      expect(allRuns.filter((run) => run.status === 'skipped').every((run) => run.error === 'missed-window' && run.runPhase === 'terminal')).toBe(true)
    }
  })
})
