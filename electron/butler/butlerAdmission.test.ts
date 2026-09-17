import { describe, expect, it, vi, beforeEach } from 'vitest'

const logEvents: Array<{ level: string; event: string; fields: Record<string, unknown> }> = []
vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    logEvents.push({ level, event, fields })
  },
  logAgentError: vi.fn()
}))

import { ButlerAdmission } from './butlerAdmission'

describe('butlerAdmission 单入口准入（偏差 23 单例外）', () => {
  beforeEach(() => {
    logEvents.length = 0
  })

  it('并发 = 1：第二个触发排队，释放后获得许可', async () => {
    const admission = new ButlerAdmission({ now: () => 1_000_000 })
    const first = await admission.acquire('req-1')
    expect(first.ok).toBe(true)

    let secondResolved = false
    const second = admission.acquire('req-2')
    void second.then((r) => {
      secondResolved = true
      return r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(secondResolved).toBe(false)

    first.ok && first.release()
    const secondResult = await second
    expect(secondResult.ok).toBe(true)
    secondResult.ok && secondResult.release()
  })

  it('小时上限：窗口内超限立即拒绝并落审计事件', async () => {
    let now = 1_000_000
    const admission = new ButlerAdmission({ hourlyLimit: 2, now: () => now })
    const a = await admission.acquire('req-1')
    a.ok && a.release()
    const b = await admission.acquire('req-2')
    b.ok && b.release()
    const c = await admission.acquire('req-3')
    expect(c.ok).toBe(false)
    expect(!c.ok && c.reason).toBe('hourly-limit')
    expect(logEvents.some((e) => e.event === 'automation.admission.denied' && e.fields.reason === 'hourly-limit')).toBe(true)

    // 窗口推进 → 计数重置
    now += 3_601_000
    const d = await admission.acquire('req-4')
    expect(d.ok).toBe(true)
    d.ok && d.release()
  })

  it('排队受控上限：队列满时新触发被拒绝（queue-full）', async () => {
    const admission = new ButlerAdmission({ queueLimit: 1, now: () => 1_000_000 })
    const running = await admission.acquire('req-running')
    expect(running.ok).toBe(true)

    const queued = admission.acquire('req-queued')
    const rejected = await admission.acquire('req-rejected')
    expect(rejected.ok).toBe(false)
    expect(!rejected.ok && rejected.reason).toBe('queue-full')

    running.ok && running.release()
    const queuedResult = await queued
    expect(queuedResult.ok).toBe(true)
    queuedResult.ok && queuedResult.release()
  })

  it('排队触发在 acquire 时即计入配额，启动时不重复计数', async () => {
    let now = 1_000_000
    const admission = new ButlerAdmission({ hourlyLimit: 2, queueLimit: 1, now: () => now })
    const first = await admission.acquire('req-1')
    expect(first.ok).toBe(true)

    // 第二个触发排队：占用第 2 个配额
    const queued = admission.acquire('req-2')
    await Promise.resolve()
    // 第三个触发：配额已满 → 立即拒绝（可回答「为什么没跑」）
    const denied = await admission.acquire('req-3')
    expect(denied.ok).toBe(false)
    expect(!denied.ok && denied.reason).toBe('hourly-limit')

    first.ok && first.release()
    const started = await queued
    expect(started.ok).toBe(true)
    now += 3_601_000
    started.ok && started.release()
    // 窗口推进后恢复正常
    const next = await admission.acquire('req-4')
    expect(next.ok).toBe(true)
    next.ok && next.release()
  })
})

describe('评审 P1：排队唤醒后并发计数不漂移', () => {
  it('两次排队接力后，并发上限仍生效（第三个触发必须排队而非立即运行）', async () => {
    const admission = new ButlerAdmission({ now: () => 1_000_000 })
    const first = await admission.acquire('req-1')
    expect(first.ok).toBe(true)

    const second = admission.acquire('req-2')
    await Promise.resolve()
    first.ok && first.release()
    const secondResult = await second
    expect(secondResult.ok).toBe(true)

    // running 应为 1：第三个触发必须进入排队，不得立即运行
    let thirdResolved = false
    const third = admission.acquire('req-3')
    void third.then((r) => {
      thirdResolved = true
      return r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdResolved).toBe(false)

    secondResult.ok && secondResult.release()
    const thirdResult = await third
    expect(thirdResult.ok).toBe(true)
    thirdResult.ok && thirdResult.release()
  })

  it('多次排队接力后并发恰为 1（计数既不漂负也不漂正）', async () => {
    const admission = new ButlerAdmission({ now: () => 1_000_000 })
    let current = await admission.acquire('req-0')
    for (let i = 1; i <= 5; i += 1) {
      const queued = admission.acquire('req-' + i)
      await Promise.resolve()
      current.ok && current.release()
      current = await queued
      expect(current.ok).toBe(true)
      // 每一轮接力后并发必须恰为 1：下一个 acquire 必须排队（不立即解决）
      let probeResolved = false
      const probe = admission.acquire('probe-' + i)
      void probe.then((r) => {
        probeResolved = true
        return r
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(probeResolved).toBe(false)
      // 清理 probe：释放当前后让它接管
      current.ok && current.release()
      const probeResult = await probe
      probeResult.ok && probeResult.release()
      // 重新取一张作为下一轮的 current
      current = await admission.acquire('next-' + i)
      expect(current.ok).toBe(true)
    }
  })
})

describe('不变量：任意 acquire/release 序列后，探针排队 ⇔ 持票数已满（AGENTS.md 测试纪律示范）', () => {
  // mulberry32 确定性伪随机：序列可复现，失败时可固定种子收缩
  function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  type Ticket = Extract<ButlerAdmissionResult, { ok: true }>

  // 立即性探测（与既有用例同一模式）：2 个微任务内 resolve = 立即获票；否则已进入排队
  async function acquireTracked(admission: ButlerAdmission, id: string): Promise<{ immediate: boolean; result?: Ticket; pending: Promise<ButlerAdmissionResult> }> {
    let settled: Ticket | undefined
    const promise = admission.acquire(id)
    void promise.then((r) => {
      if (r.ok) settled = r
    })
    await Promise.resolve()
    await Promise.resolve()
    if (settled) return { immediate: true, result: settled, pending: promise }
    return { immediate: false, pending: promise }
  }

  it('3 个随机种子 × 300 步：oracle 持票数与排队行为全程一致', async () => {
    for (const seed of [1, 42, 2026]) {
      const rand = mulberry32(seed)
      const admission = new ButlerAdmission({ hourlyLimit: 1e9, queueLimit: 1e9, now: () => 1_000_000 })
      const held: Ticket[] = []                       // oracle：在外未释放的票
      const pending: Array<Promise<ButlerAdmissionResult>> = [] // 已进入排队的 acquire

      for (let step = 0; step < 300; step += 1) {
        const roll = rand()
        if (roll < 0.5) {
          const r = await acquireTracked(admission, 'a' + seed + '-' + step)
          if (r.immediate) {
            expect(held.length).toBe(0)               // 立即获票 ⇔ 此前未满
            held.push(r.result!)
          } else {
            pending.push(r.pending)                   // 排队 ⇔ 此前已满
            expect(held.length).toBe(1)
          }
        } else if (roll < 0.75 && held.length > 0) {
          const idx = Math.floor(rand() * held.length)
          held[idx]!.release()
          held.splice(idx, 1)
          // 释放唤醒队首排队者（同步 resolve），收编为持票
          if (pending.length > 0) {
            const woken = await pending.shift()!
            expect(woken.ok).toBe(true)
            if (woken.ok) held.push(woken)
          }
        }

        // 不变量断言（每步后）：
        expect(held.length).toBeLessThanOrEqual(1)    // 并发上界
        if (pending.length > 0) {
          expect(held.length).toBe(1)                 // 有排队者 ⇔ 并发已满
        }
      }
    }
  })
})
