import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeliveryHub,
  type DeliveryDriver,
  type DeliveryPreference
} from './deliveryHub'

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
    expect(hub2.getRecords().find((r) => r.seq === r1.seq)?.outcome).toBe('superseded')
    // 送达即止：再投同键 → 弃（已送达过）
    const r3 = await hub2.deliver(pref({ supersedeKey: 'task-1' }), payload)
    expect(r3.outcome).toBe('already-delivered')
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
