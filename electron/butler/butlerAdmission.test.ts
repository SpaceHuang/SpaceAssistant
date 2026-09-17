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
