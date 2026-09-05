import { describe, expect, it } from 'vitest'
import { ProgressThrottle } from './progressThrottle'

describe('ProgressThrottle', () => {
  it('按最小时间间隔合并高频事件', () => {
    const throttle = new ProgressThrottle({ minIntervalMs: 100, maxEventsPerSecond: 100, minBytes: 1 })
    expect(throttle.shouldSend(0)).toBe(true)
    expect(throttle.shouldSend(50)).toBe(false)
    expect(throttle.shouldSend(100)).toBe(true)
  })

  it('按每秒事件预算限制洪泛并在窗口后恢复', () => {
    const throttle = new ProgressThrottle({ minIntervalMs: 0, maxEventsPerSecond: 2, minBytes: 1 })
    expect(throttle.shouldSend(1)).toBe(true)
    expect(throttle.shouldSend(2)).toBe(true)
    expect(throttle.shouldSend(3)).toBe(false)
    expect(throttle.shouldSend(1001)).toBe(true)
  })

  it('达到字节阈值后允许发送最新快照', () => {
    const throttle = new ProgressThrottle({ minIntervalMs: 1000, maxEventsPerSecond: 100, minBytes: 10 })
    expect(throttle.shouldSend(0, 1)).toBe(true)
    expect(throttle.shouldSend(10, 4)).toBe(false)
    expect(throttle.shouldSend(20, 6)).toBe(true)
  })
})
