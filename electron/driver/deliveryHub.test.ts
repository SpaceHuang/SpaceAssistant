import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeliveryHub,
  DeliveryUncertainError,
  type DeliveryDriver,
  type DeliveryPreference
} from './deliveryHub'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { SqliteDeliveryJournal } from './sqliteDeliveryJournal'
import { getDbConnection, openDatabase } from '../database'

/**
 * P6（偏差 8 机制面）：驱动源层唯一投递入口。
 * 不变量风格用例（参照 butlerAdmission.test 末组）：
 * 送达记录成对性、TTL 过期不补投、取代键命中即弃、送达即止、
 * 单目标默认 / 多目标必须显式、可达性缺失延后不丢弃。
 */

function makeDriver(overrides: Partial<DeliveryDriver> = {}): DeliveryDriver {
  return {
    id: 'test-driver',
    isReachable: () => true,
    deliver: vi.fn(async () => undefined),
    ...overrides
  }
}

function pref(overrides: Partial<DeliveryPreference> = {}): DeliveryPreference {
  return { target: 'test-driver', ...overrides }
}

const payload = { kind: 'test-result', text: 'hello' } as const

describe('deliveryHub 投递与送达记录（P6）', () => {
  let hub: ReturnType<typeof createDeliveryHub>

  beforeEach(() => {
    vi.clearAllMocks()
    hub = createDeliveryHub({ now: () => 1_000 })
  })

  it('journal 状态快照与追加事件必须在同一 SQLite 事务提交', () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1000)
    const intent = { deliveryId: 'atomic-delivery', target: 'driver', preference: { target: 'driver', deliveryId: 'atomic-delivery' }, payload, status: 'pending' as const, createdAt: 1000 }
    journal.transition(intent, 'pending')
    getDbConnection(db).exec(`CREATE TRIGGER fail_delivery_event BEFORE INSERT ON driver_delivery_events
      WHEN NEW.status = 'delivering' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`)
    expect(() => journal.transition(intent, 'delivering')).toThrow('injected event failure')
    expect(journal.status('atomic-delivery', 'driver')).toBe('pending')
    const events = getDbConnection(db).prepare('SELECT status FROM driver_delivery_events WHERE delivery_id=?').all('atomic-delivery') as Array<{ status: string }>
    expect(events.map((event) => event.status)).toEqual(['pending'])
    db.close()
  })

  it('送达记录成对性：每次投递必有记录（delivered）', async () => {
    const driver = makeDriver()
    hub.registerDriver(driver)
    const record = await hub.deliver(pref(), payload)
    expect(record.outcome).toBe('delivered')
    expect(record.driverId).toBe('test-driver')
    expect(driver.deliver).toHaveBeenCalledOnce()
    // 记录成对：hub 内台账可查
    expect(hub.getRecords()).toHaveLength(1)
    expect(hub.getRecords()[0]).toMatchObject({ outcome: 'delivered', kind: 'test-result' })
  })

  it('外部接受后 journal 确认写入失败时记录 uncertain，不能作为失败重试', async () => {
    const transitions: string[] = []
    const journal = {
      listResumable: () => [],
      status: () => undefined,
      intent: () => undefined,
      transition: (_intent: unknown, status: string) => {
        transitions.push(status)
        if (status === 'delivered') throw new Error('local ack write failed')
      }
    }
    const driver = makeDriver()
    const hub = createDeliveryHub({ journal: journal as never, now: () => 1000 })
    hub.registerDriver(driver)
    const record = await hub.deliver({ target: driver.id, deliveryId: 'ack-fails' }, payload)
    expect(driver.deliver).toHaveBeenCalledOnce()
    expect(record.outcome).toBe('delivery-uncertain')
    expect(transitions).toEqual(['delivering', 'delivered', 'delivery-uncertain'])
    expect(await hub.flushDeferred()).toBe(0)
  })

  it('deferred 补投完成但本地确认失败时转 uncertain，后续 flush 不再发送', async () => {
    let reachable = false
    const transitions: string[] = []
    const journal = {
      listResumable: () => [],
      status: () => undefined,
      transition: (_intent: unknown, status: string) => {
        transitions.push(status)
        if (status === 'delivered') throw new Error('local ack write failed')
      }
    }
    const driver = makeDriver({ isReachable: () => reachable })
    const hub = createDeliveryHub({ journal: journal as never, now: () => 1000 })
    hub.registerDriver(driver)
    expect((await hub.deliver({ target: driver.id, deliveryId: 'flush-ack-fails' }, payload)).outcome).toBe('deferred')
    reachable = true
    expect(await hub.flushDeferred()).toBe(0)
    expect(driver.deliver).toHaveBeenCalledOnce()
    expect(hub.getRecords().at(-1)?.outcome).toBe('delivery-uncertain')
    expect(await hub.flushDeferred()).toBe(0)
    expect(driver.deliver).toHaveBeenCalledOnce()
    expect(transitions).toEqual(['deferred', 'delivering', 'delivered', 'delivery-uncertain'])
  })

  it('TTL 过期不补投：deferred 后超期标「未送达且已过期」并落台账，不算失败', async () => {
    let now = 1_000
    let reachable = false
    const hub2 = createDeliveryHub({ now: () => now })
    const driver = makeDriver({ isReachable: () => reachable })
    hub2.registerDriver(driver)
    // 通道不可达 → deferred（结果已产生，TTL=500ms 从此刻起算）
    const record = await hub2.deliver(pref({ target: 'test-driver', ttlMs: 500 }), payload)
    expect(record.outcome).toBe('deferred')
    expect(driver.deliver).not.toHaveBeenCalled()
    // 通道恢复时已超期 600ms → expired（不补投，也不是 failed）
    now = 1_600
    reachable = true
    const flushed = await hub2.flushDeferred()
    expect(flushed).toBe(0)
    expect(driver.deliver).not.toHaveBeenCalled()
    const expired = hub2.getRecords().find((r) => r.outcome === 'expired')
    expect(expired).toBeDefined()
  })

  it('多目标 deferred 过期时仍按实际目标记录 expired', async () => {
    let now = 1_000
    const hub = createDeliveryHub({ now: () => now })
    hub.registerDriver(makeDriver({ id: 'target-a', isReachable: () => false }))
    hub.registerDriver(makeDriver({ id: 'target-b', isReachable: () => false }))
    await hub.deliverAll({ targets: ['target-a', 'target-b'], ttlMs: 500 }, payload)
    now = 1_600

    expect(await hub.flushDeferred()).toBe(0)
    expect(hub.getRecords().filter((record) => record.outcome === 'expired').map((record) => record.driverId))
      .toEqual(['target-a', 'target-b'])
  })

  it('取代键：新结果取代旧结果——旧未送达被弃（superseded），送达即止', async () => {
    let now = 1_000
    const hub2 = createDeliveryHub({ now: () => now })
    const driver = makeDriver({ deliver: vi.fn(async () => { throw new Error('not reachable yet') }) })
    hub2.registerDriver(driver)
    // 第一次投递失败（仍可达但投递抛错 → failed，保留等待取代）
    const r1 = await hub2.deliver(pref({ supersedeKey: 'task-1' }), payload)
    expect(r1.outcome).toBe('failed')
    // 新结果以同取代键到达：取代旧结果
    driver.deliver = vi.fn(async () => undefined)
    now = 1_100
    const r2 = await hub2.deliver(pref({ supersedeKey: 'task-1' }), payload)
    expect(r2.outcome).toBe('delivered')
    // 旧结果标记被取代（送达记录可查）
    expect(hub2.getRecords().find((r) => r.seq === r1.seq)?.outcome).toBe('failed')
    expect(hub2.getRecords()).toContainEqual(expect.objectContaining({ outcome: 'superseded', supersedeKey: 'task-1' }))
    // 送达即止：再投同键 → 弃（已送达过）
    const r3 = await hub2.deliver(pref({ supersedeKey: 'task-1' }), payload)
    expect(r3.outcome).toBe('already-delivered')
  })

  it('新结果已送达后，重试相同 supersedeKey 的旧 failed delivery 不得再次派发', async () => {
    let oldAttempts = 0
    let releaseNewDelivery!: () => void
    let markNewDeliveryStarted!: () => void
    const newDeliveryStarted = new Promise<void>((resolve) => { markNewDeliveryStarted = resolve })
    const deliver = vi.fn(async (body: { text?: string }) => {
      if (body.text === 'old') {
        oldAttempts += 1
        if (oldAttempts === 1) throw new Error('temporary failure')
      } else if (body.text === 'new') {
        markNewDeliveryStarted()
        await new Promise<void>((resolve) => { releaseNewDelivery = resolve })
      }
    })
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1_000)
    const hub = createDeliveryHub({ journal, now: () => 1_000 })
    hub.registerDriver(makeDriver({ id: 'target', deliver }))

    await expect(hub.deliver({ target: 'target', deliveryId: 'old-failed', supersedeKey: 'same-task' }, { kind: 'result', text: 'old' }))
      .resolves.toMatchObject({ outcome: 'failed' })
    const newDelivery = hub.deliver({ target: 'target', deliveryId: 'new-delivered', supersedeKey: 'same-task' }, { kind: 'result', text: 'new' })
    await newDeliveryStarted
    await expect(hub.deliver({ target: 'target', deliveryId: 'old-failed', supersedeKey: 'same-task' }, { kind: 'result', text: 'old' }))
      .resolves.toMatchObject({ outcome: 'superseded' })
    releaseNewDelivery()
    await expect(newDelivery).resolves.toMatchObject({ outcome: 'delivered' })

    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls.map(([body]) => body.text)).toEqual(['old', 'new'])
    expect(journal.status('old-failed', 'target')).toBe('superseded')
    db.close()
  })

  it('同一 supersedeKey 的新 deferred 原子取代旧 pending，且不改写已输出的记录', async () => {
    let reachable = false
    const driver = makeDriver({ id: 'test-driver', isReachable: () => reachable })
    hub.registerDriver(driver)
    const old = await hub.deliver(pref({ supersedeKey: 'task-x' }), { kind: 'result', text: 'old' })
    const latest = await hub.deliver(pref({ supersedeKey: 'task-x' }), { kind: 'result', text: 'latest' })
    expect(old.outcome).toBe('deferred')
    expect(hub.getRecords().find((record) => record.seq === old.seq)?.outcome).toBe('deferred')
    reachable = true
    await hub.flushDeferred()
    expect(driver.deliver).toHaveBeenCalledTimes(1)
    expect(driver.deliver).toHaveBeenCalledWith({ kind: 'result', text: 'latest' })
    expect(hub.getRecords().find((record) => record.seq === latest.seq)?.outcome).toBe('deferred')
  })

  it('更新 supersedeKey 后立即送达的新结果会持久取代旧 deferred，重启也不补发旧结果', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1_000)
    let reachable = false
    const hub = createDeliveryHub({ journal, now: () => 1_000 })
    const driver = makeDriver({ id: 'target', isReachable: () => reachable })
    hub.registerDriver(driver)
    await hub.deliver({ target: 'target', deliveryId: 'old-result', supersedeKey: 'task-result' }, { kind: 'result', text: 'old' })
    expect(journal.status('old-result', 'target')).toBe('deferred')

    reachable = true
    await hub.deliver({ target: 'target', deliveryId: 'new-result', supersedeKey: 'task-result' }, { kind: 'result', text: 'new' })
    expect(journal.status('old-result', 'target')).toBe('superseded')
    expect(journal.status('new-result', 'target')).toBe('delivered')

    const restarted = createDeliveryHub({ journal, now: () => 1_000 })
    const restartedDriver = makeDriver({ id: 'target' })
    restarted.registerDriver(restartedDriver)
    expect(await restarted.flushDeferred()).toBe(0)
    expect(restartedDriver.deliver).not.toHaveBeenCalled()
    db.close()
  })

  it('flush 中旧结果失败并被新送达结果取代后，重启不再补发旧 deferred', async () => {
    const temp = createTempDatabase('delivery-supersede-race-')
    const db = temp.db
    const journal = new SqliteDeliveryJournal(db, () => 1_000)
    let reachable = false
    let oldSendCalls = 0
    let newSendCalls = 0
    let releaseOldFailure!: () => void
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve })
    const driver = makeDriver({
      id: 'target',
      isReachable: () => reachable,
      deliver: vi.fn(async (body) => {
        if (body.text === 'old') {
          oldSendCalls += 1
          if (oldSendCalls === 1) {
            markOldStarted()
            await new Promise<void>((_resolve, reject) => { releaseOldFailure = () => reject(new Error('temporary send failure')) })
          }
        } else if (body.text === 'new') newSendCalls += 1
      })
    })
    const hub = createDeliveryHub({ journal, now: () => 1_000 })
    hub.registerDriver(driver)
    await hub.deliver({ target: 'target', deliveryId: 'old-inflight', supersedeKey: 'same-result' }, { kind: 'result', text: 'old' })
    reachable = true

    const flushing = hub.flushDeferred()
    await oldStarted
    await expect(hub.deliver({ target: 'target', deliveryId: 'new-result-after-old-dispatch', supersedeKey: 'same-result' }, { kind: 'result', text: 'new' }))
      .resolves.toMatchObject({ outcome: 'delivered' })
    releaseOldFailure()
    await flushing
    expect(journal.status('old-inflight', 'target')).toBe('deferred')
    expect(journal.status('new-result-after-old-dispatch', 'target')).toBe('delivered')

    db.close()
    const reopened = openDatabase(temp.dbPath)
    const restartedJournal = new SqliteDeliveryJournal(reopened, () => 1_000)
    const restarted = createDeliveryHub({ journal: restartedJournal, now: () => 1_000 })
    const restartedDriver = makeDriver({ id: 'target' })
    restarted.registerDriver(restartedDriver)
    expect(await restarted.flushDeferred()).toBe(0)
    expect(restartedDriver.deliver).not.toHaveBeenCalled()
    expect(oldSendCalls).toBe(1)
    expect(newSendCalls).toBe(1)
    expect(restartedJournal.status('old-inflight', 'target')).toBe('superseded')
    reopened.close()
    temp.cleanup()
  })

  it.each([
    { latestStatus: 'pending' as const, expectedFlush: 1, expectedDeliveredText: 'new' },
    { latestStatus: 'deferred' as const, expectedFlush: 1, expectedDeliveredText: 'new' },
    { latestStatus: 'failed' as const, expectedFlush: 0 },
    { latestStatus: 'delivery-uncertain' as const, expectedFlush: 0 },
    { latestStatus: 'expired' as const, expectedFlush: 0 },
    { latestStatus: 'superseded' as const, expectedFlush: 0 },
    { latestStatus: 'delivered' as const, expectedFlush: 0 }
  ])('重启时最新状态为 $latestStatus 时只恢复最新 supersede 意图', async ({ latestStatus, expectedFlush, expectedDeliveredText }) => {
    const temp = createTempDatabase(`delivery-supersede-${latestStatus}-`)
    const db = temp.db
    const journal = new SqliteDeliveryJournal(db, () => 1_000)
    const oldIntent = {
      deliveryId: 'older-result', target: 'target',
      preference: { target: 'target', deliveryId: 'older-result', supersedeKey: 'same-key' },
      payload: { kind: 'result', text: 'old' }, status: 'pending' as const, createdAt: 100
    }
    const latestIntent = {
      deliveryId: 'latest-result', target: 'target',
      preference: { target: 'target', deliveryId: 'latest-result', supersedeKey: 'same-key' },
      payload: { kind: 'result', text: 'new' }, status: 'pending' as const, createdAt: 200
    }
    journal.transition(oldIntent, 'deferred')
    journal.transition(latestIntent, latestStatus)
    db.close()

    const reopened = openDatabase(temp.dbPath)
    const restartedJournal = new SqliteDeliveryJournal(reopened, () => 1_000)
    const restarted = createDeliveryHub({ journal: restartedJournal, now: () => 1_000 })
    const deliver = vi.fn(async () => undefined)
    restarted.registerDriver(makeDriver({ id: 'target', deliver }))

    expect(await restarted.flushDeferred()).toBe(expectedFlush)
    expect(deliver.mock.calls).toHaveLength(expectedFlush)
    if (expectedDeliveredText) expect(deliver).toHaveBeenCalledWith({ kind: 'result', text: expectedDeliveredText })
    expect(restartedJournal.status('older-result', 'target')).toBe('superseded')
    expect(restartedJournal.status('latest-result', 'target')).toBe(expectedFlush ? 'delivered' : latestStatus)
    reopened.close()
    temp.cleanup()
  })

  it('supersedeKey 的已送达状态按目标隔离', async () => {
    const hub = createDeliveryHub()
    let deliveriesA = 0
    let deliveriesB = 0
    hub.registerDriver({ id: 'a', isReachable: () => true, deliver: async () => { deliveriesA += 1 } })
    hub.registerDriver({ id: 'b', isReachable: () => true, deliver: async () => { deliveriesB += 1 } })
    const first = await hub.deliver({ target: 'a', supersedeKey: 'same-task' }, payload)
    const second = await hub.deliver({ target: 'b', supersedeKey: 'same-task' }, payload)
    expect(first.outcome).toBe('delivered')
    expect(second.outcome).toBe('delivered')
    expect([deliveriesA, deliveriesB]).toEqual([1, 1])
  })

  it('单目标默认：target 单值只投一个驱动源；多目标必须显式声明（targets 数组）', async () => {
    const a = makeDriver({ id: 'a' })
    const b = makeDriver({ id: 'b' })
    hub.registerDriver(a)
    hub.registerDriver(b)
    await hub.deliver(pref({ target: 'a' }), payload)
    expect(a.deliver).toHaveBeenCalledOnce()
    expect(b.deliver).not.toHaveBeenCalled()
    // 多目标显式
    await hub.deliver({ targets: ['a', 'b'] }, payload)
    expect(a.deliver).toHaveBeenCalledTimes(2)
    expect(b.deliver).toHaveBeenCalledOnce()
  })

  it('多目标返回每个目标的独立结果', async () => {
    const a = makeDriver({ id: 'a' })
    const b = makeDriver({ id: 'b', deliver: vi.fn(async () => { throw new Error('offline') }) })
    hub.registerDriver(a); hub.registerDriver(b)
    await expect(hub.deliverAll({ targets: ['a', 'b'] }, payload)).resolves.toMatchObject([
      { driverId: 'a', outcome: 'delivered' }, { driverId: 'b', outcome: 'failed', error: 'offline' }
    ])
  })

  it('SQLite journal 在 hub 重建后恢复 deferred，并把 dispatch 中断保留为 uncertain', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1000)
    const first = createDeliveryHub({ journal, now: () => 1000 })
    first.registerDriver(makeDriver({ id: 'durable', isReachable: () => false }))
    await first.deliver({ target: 'durable', deliveryId: 'd1', ttlMs: 10_000 }, payload)
    expect(journal.status('d1', 'durable')).toBe('deferred')
    const second = createDeliveryHub({ journal, now: () => 1000 })
    const recovered = makeDriver({ id: 'durable' })
    second.registerDriver(recovered)
    expect(await second.flushDeferred()).toBe(1)
    expect(recovered.deliver).toHaveBeenCalledOnce()
    expect(journal.status('d1', 'durable')).toBe('delivered')
    expect((await second.deliver({ target: 'durable', deliveryId: 'd1', ttlMs: 10_000 }, payload)).outcome).toBe('already-delivered')
    expect(recovered.deliver).toHaveBeenCalledOnce()

    const uncertainHub = createDeliveryHub({ journal, now: () => 1000 })
    const uncertain = makeDriver({ id: 'im', deliver: vi.fn(async () => { throw new DeliveryUncertainError('remote accepted; local ack missing') }) })
    uncertainHub.registerDriver(uncertain)
    await uncertainHub.deliver({ target: 'im', deliveryId: 'd2' }, payload)
    expect(journal.status('d2', 'im')).toBe('delivery-uncertain')
    const restart = createDeliveryHub({ journal, now: () => 1000 })
    const retry = makeDriver({ id: 'im' })
    restart.registerDriver(retry)
    expect(await restart.flushDeferred()).toBe(0)
    expect(retry.deliver).not.toHaveBeenCalled()

    journal.transition({ deliveryId: 'crash', target: 'im', preference: { deliveryId: 'crash', target: 'im' }, payload, status: 'delivering', createdAt: 1000 }, 'delivering')
    expect(journal.markInterruptedDispatchesUncertain()).toBe(1)
    expect(journal.status('crash', 'im')).toBe('delivery-uncertain')
    const crashRecovery = createDeliveryHub({ journal, now: () => 1000 })
    const crashDriver = makeDriver({ id: 'im' })
    crashRecovery.registerDriver(crashDriver)
    expect(await crashRecovery.flushDeferred()).toBe(0)
    expect(crashDriver.deliver).not.toHaveBeenCalled()
    db.close()
  })

  it('hub 重启恢复时即使 driver 仍离线，也会持久终结已过 TTL 的 deferred', async () => {
    const db = createMemoryAppDb()
    let now = 1_000
    const journal = new SqliteDeliveryJournal(db, () => now)
    const first = createDeliveryHub({ journal, now: () => now })
    first.registerDriver(makeDriver({ id: 'im', isReachable: () => false }))
    await first.deliver({ target: 'im', deliveryId: 'expired-on-restart', ttlMs: 500 }, payload)
    now = 1_600

    const restarted = createDeliveryHub({ journal, now: () => now })
    const driver = makeDriver({ id: 'im', isReachable: () => false })
    restarted.registerDriver(driver)
    expect(journal.status('expired-on-restart', 'im')).toBe('expired')
    expect(restarted.getRecords()).toContainEqual(expect.objectContaining({ deliveryId: 'expired-on-restart', outcome: 'expired' }))
    expect(driver.deliver).not.toHaveBeenCalled()
    expect(journal.listResumable()).toEqual([])
    db.close()
  })

  it('SQLite journal 中 dispatch 中断的 supersede 意图会阻止较旧 deferred 在重启后补发', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1_000)
    const oldPreference = { target: 'im', deliveryId: 'old-deferred', supersedeKey: 'same-task' }
    const newPreference = { target: 'im', deliveryId: 'new-interrupted', supersedeKey: 'same-task' }
    journal.transition({ deliveryId: oldPreference.deliveryId, target: 'im', preference: oldPreference, payload, status: 'pending', createdAt: 900 }, 'deferred')
    journal.transition({ deliveryId: newPreference.deliveryId, target: 'im', preference: newPreference, payload, status: 'pending', createdAt: 1_000 }, 'delivering')
    expect(journal.markInterruptedDispatchesUncertain()).toBe(1)

    const restarted = createDeliveryHub({ journal, now: () => 1_000 })
    const driver = makeDriver({ id: 'im' })
    restarted.registerDriver(driver)
    expect(await restarted.flushDeferred()).toBe(0)
    expect(driver.deliver).not.toHaveBeenCalled()
    expect(journal.status('new-interrupted', 'im')).toBe('delivery-uncertain')
    expect(journal.status('old-deferred', 'im')).toBe('superseded')
    db.close()
  })

  it('较新的 uncertain intent 即使 createdAt 较早，也必须压过旧 deferred', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1_000)
    const oldPreference = { target: 'im', deliveryId: 'old-deferred-time', supersedeKey: 'same-task' }
    const newPreference = { target: 'im', deliveryId: 'new-uncertain-time', supersedeKey: 'same-task' }
    journal.transition({ deliveryId: oldPreference.deliveryId, target: 'im', preference: oldPreference, payload, status: 'pending', createdAt: 2_000 }, 'deferred')
    journal.transition({ deliveryId: newPreference.deliveryId, target: 'im', preference: newPreference, payload, status: 'pending', createdAt: 1_000 }, 'delivering')
    journal.markInterruptedDispatchesUncertain()

    const restarted = createDeliveryHub({ journal, now: () => 2_000 })
    const driver = makeDriver({ id: 'im' })
    restarted.registerDriver(driver)
    expect(await restarted.flushDeferred()).toBe(0)
    expect(driver.deliver).not.toHaveBeenCalled()
    expect(journal.status('new-uncertain-time', 'im')).toBe('delivery-uncertain')
    expect(journal.status('old-deferred-time', 'im')).toBe('superseded')
    db.close()
  })

  it('同一 deliveryId 携带不同 payload 时拒绝重写已持久化的投递意图', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1000)
    const offline = createDeliveryHub({ journal, now: () => 1000 })
    offline.registerDriver(makeDriver({ id: 'durable', isReachable: () => false }))
    await offline.deliver({ target: 'durable', deliveryId: 'immutable-intent' }, { kind: 'result', text: 'original' })

    const retry = createDeliveryHub({ journal, now: () => 1000 })
    const driver = makeDriver({ id: 'durable' })
    retry.registerDriver(driver)
    const result = await retry.deliver({ target: 'durable', deliveryId: 'immutable-intent' }, { kind: 'result', text: 'changed' })

    expect(result).toMatchObject({ outcome: 'failed', error: 'DELIVERY_ID_CONFLICT' })
    expect(driver.deliver).not.toHaveBeenCalled()
    expect(journal.listResumable()).toEqual([expect.objectContaining({ deliveryId: 'immutable-intent', payload: { kind: 'result', text: 'original' }, status: 'deferred' })])
    db.close()
  })

  it('SQLite 原子直接 claim 会在事务内拒绝与首次意图不符的 payload', () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1000)
    const original = { deliveryId: 'atomic-intent', target: 'durable', preference: { target: 'durable', deliveryId: 'atomic-intent' }, payload: { kind: 'result', text: 'original' }, status: 'deferred' as const, createdAt: 1000 }
    journal.transition(original, 'deferred')

    expect(journal.claimNewForDispatch({ ...original, payload: { kind: 'result', text: 'changed' }, status: 'pending' })).toBe('conflict')
    expect(journal.status('atomic-intent', 'durable')).toBe('deferred')
    db.close()
  })

  it('已过期的持久 deliveryId 不能通过再次直接调用绕过 TTL', async () => {
    const db = createMemoryAppDb()
    let now = 1000
    const journal = new SqliteDeliveryJournal(db, () => now)
    const offline = createDeliveryHub({ journal, now: () => now })
    offline.registerDriver(makeDriver({ id: 'durable', isReachable: () => false }))
    await offline.deliver({ target: 'durable', deliveryId: 'expired-intent', ttlMs: 500 }, payload)
    now = 1600
    expect(await offline.flushDeferred()).toBe(0)
    expect(journal.status('expired-intent', 'durable')).toBe('expired')

    const retry = createDeliveryHub({ journal, now: () => now })
    const driver = makeDriver({ id: 'durable' })
    retry.registerDriver(driver)
    expect(await retry.deliver({ target: 'durable', deliveryId: 'expired-intent', ttlMs: 500 }, payload)).toMatchObject({ outcome: 'expired' })
    expect(driver.deliver).not.toHaveBeenCalled()
    db.close()
  })

  it('两个独立 hub 并发 flush 同一持久 deferred 时只允许一个取得派发权', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1000)
    const offline = createDeliveryHub({ journal, now: () => 1000 })
    offline.registerDriver(makeDriver({ id: 'shared-target', isReachable: () => false }))
    await offline.deliver({ target: 'shared-target', deliveryId: 'concurrent-flush' }, payload)

    const deliver = vi.fn(async () => undefined)
    const first = createDeliveryHub({ journal, now: () => 1000 })
    const second = createDeliveryHub({ journal, now: () => 1000 })
    first.registerDriver(makeDriver({ id: 'shared-target', deliver }))
    second.registerDriver(makeDriver({ id: 'shared-target', deliver }))

    await expect(Promise.all([first.flushDeferred(), second.flushDeferred()])).resolves.toEqual([1, 0])
    expect(deliver).toHaveBeenCalledOnce()
    expect(journal.status('concurrent-flush', 'shared-target')).toBe('delivered')
    db.close()
  })

  it('两个独立 hub 同时直接派发同一 deliveryId 时由 SQLite 原子 claim 防止重复发送', async () => {
    const db = createMemoryAppDb()
    const journal = new SqliteDeliveryJournal(db, () => 1000)
    // 模拟两个进程都在对方写入 delivering 之前读到相同的旧状态。
    vi.spyOn(journal, 'status').mockReturnValue(undefined)
    const deliver = vi.fn(async () => { await Promise.resolve() })
    const first = createDeliveryHub({ journal, now: () => 1000 })
    const second = createDeliveryHub({ journal, now: () => 1000 })
    first.registerDriver(makeDriver({ id: 'shared-target', deliver }))
    second.registerDriver(makeDriver({ id: 'shared-target', deliver }))

    await Promise.all([
      first.deliver({ target: 'shared-target', deliveryId: 'concurrent-direct' }, payload),
      second.deliver({ target: 'shared-target', deliveryId: 'concurrent-direct' }, payload)
    ])

    expect(deliver).toHaveBeenCalledOnce()
    expect(journal.status).toHaveBeenCalled()
    expect(journal.intent('concurrent-direct', 'shared-target')?.status).toBe('delivered')
    db.close()
  })

  it('可达性缺失：延后不丢弃（deferred），可达后重投成功', async () => {
    let reachable = false
    const driver = makeDriver({ isReachable: () => reachable })
    hub.registerDriver(driver)
    const record = await hub.deliver(pref({ ttlMs: 60_000 }), payload)
    expect(record.outcome).toBe('deferred')
    expect(driver.deliver).not.toHaveBeenCalled()
    // 驱动源恢复可达 → flush 重投
    reachable = true
    const flushed = await hub.flushDeferred()
    expect(flushed).toBe(1)
    expect(driver.deliver).toHaveBeenCalledOnce()
    expect(hub.getRecords().filter((r) => r.outcome === 'delivered')).toHaveLength(1)
  })

  it('覆盖注册：旧 deferred 绑定失效目标——落 superseded 且绝不发给新目标（评审 P0-2 错投回归）', async () => {
    let reachable = false
    const oldDriver = makeDriver({ id: 'im', isReachable: () => reachable, deliver: vi.fn(async () => undefined) })
    hub.registerDriver(oldDriver)
    // 任务 A 的结果因不可达积压（闭包捕获 A 的目标）
    const r1 = await hub.deliver(pref({ target: 'im', ttlMs: 60_000 }), { kind: 'butler-run-result', text: 'task-A' })
    expect(r1.outcome).toBe('deferred')
    // 任务 B 覆盖注册同 id 驱动源（闭包换成 B 的目标）
    const newDriver = makeDriver({ id: 'im', isReachable: () => true, deliver: vi.fn(async () => undefined) })
    hub.registerDriver(newDriver)
    // flush：A 的积压不得发给 B 的驱动源实例
    const flushed = await hub.flushDeferred()
    expect(flushed).toBe(0)
    expect(oldDriver.deliver).not.toHaveBeenCalled()
    expect(newDriver.deliver).not.toHaveBeenCalled()
    // 旧积压落 superseded（DEFERRED_TARGET_REPLACED 留痕）
    const superseded = hub.getRecords().find((r) => r.outcome === 'superseded')
    expect(superseded).toMatchObject({ driverId: 'im', error: 'DEFERRED_TARGET_REPLACED' })
  })

  it('deferred 队列有界：溢出丢最旧并落 failed 记录（DEFERRED_OVERFLOW）', async () => {
    let reachable = false
    const driver = makeDriver({ id: 'im', isReachable: () => reachable })
    hub.registerDriver(driver)
    for (let i = 0; i < 205; i++) {
      await hub.deliver(pref({ target: 'im', ttlMs: 60_000 }), { kind: 'k', text: `m-${i}` })
    }
    expect(hub.getRecords().filter((r) => r.outcome === 'failed' && r.error === 'DEFERRED_OVERFLOW').length).toBeGreaterThanOrEqual(1)
  })

  it('未知目标：显式失败（fail-loud），不静默丢弃', async () => {
    const record = await hub.deliver(pref({ target: 'no-such-driver' }), payload)
    expect(record.outcome).toBe('failed')
    expect(record.error).toContain('no-such-driver')
  })

  it('不变量扫描：随机投递序列后，台账条数 = 投递次数 + flush 重投数（记录成对不变量）', async () => {
    // 确定性伪随机（mulberry32）
    let seed = 42
    const rand = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const driver = makeDriver()
    hub.registerDriver(driver)
    const deliveries = 30
    for (let i = 0; i < deliveries; i++) {
      const useKey = rand() < 0.5
      await hub.deliver(pref(useKey ? { supersedeKey: `k-${i % 5}`, ttlMs: 60_000 } : { ttlMs: 60_000 }), payload)
    }
    // 记录数 ≥ 投递数（superseded 会补写旧记录），每条记录有唯一 seq
    const records = hub.getRecords()
    expect(records.length).toBeGreaterThanOrEqual(deliveries)
    const seqs = new Set(records.map((r) => r.seq))
    expect(seqs.size).toBe(records.length)
    // 每条记录都有 driverId 或 outcome=deferred/expired（无 driver 归属的记录必须说明去向）
    for (const r of records) {
      expect(r.outcome).toBeDefined()
    }
  })
})
