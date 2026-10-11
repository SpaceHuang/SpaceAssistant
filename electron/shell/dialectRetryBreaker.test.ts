import { describe, expect, it } from 'vitest'
import { DialectRetryBreaker } from './dialectRetryBreaker'

/** §7 T-5 / D-8 定案：键作用域 sessionId + profileId + signals；成功即 clear；会话级可清理。 */
describe('DialectRetryBreaker（D-8 作用域化）', () => {
  it('同会话同 profile 同 signals 连续两次后提示升级（tripped），成功后可清除', () => {
    const breaker = new DialectRetryBreaker()
    expect(breaker.record('session-a', 'profile', ['cmd-exe-chain']).tripped).toBe(false)
    expect(breaker.record('session-a', 'profile', ['cmd-exe-chain']).tripped).toBe(true)
    breaker.clearOnSuccess('session-a', 'profile')
    expect(breaker.record('session-a', 'profile', ['cmd-exe-chain']).count).toBe(1)
  })

  it('不同会话分别计数（sessionId 作用域隔离）', () => {
    const breaker = new DialectRetryBreaker()
    breaker.record('session-a', 'profile', ['cmd-exe-chain'])
    expect(breaker.record('session-b', 'profile', ['cmd-exe-chain']).count).toBe(1)
    expect(breaker.record('session-a', 'profile', ['cmd-exe-chain']).count).toBe(2)
  })

  it('clearOnSuccess 只清除该会话与 profile 的最近一次错配键，不波及他者', () => {
    const breaker = new DialectRetryBreaker()
    breaker.record('session-a', 'profile', ['cmd-exe-chain'])
    breaker.record('session-a', 'profile', ['cmd-exe-chain'])
    breaker.record('session-a', 'other-profile', ['posix-export'])
    breaker.record('session-b', 'profile', ['cmd-exe-chain'])
    breaker.clearOnSuccess('session-a', 'profile')
    expect(breaker.record('session-a', 'profile', ['cmd-exe-chain']).count).toBe(1)
    expect(breaker.record('session-a', 'other-profile', ['posix-export']).count).toBe(2)
    expect(breaker.record('session-b', 'profile', ['cmd-exe-chain']).count).toBe(2)
  })

  it('forgetSession 清除该会话全部键（会话结束一并清理，D-8）', () => {
    const breaker = new DialectRetryBreaker()
    breaker.record('session-a', 'profile', ['cmd-exe-chain'])
    breaker.record('session-a', 'profile', ['posix-export'])
    breaker.record('session-b', 'profile', ['cmd-exe-chain'])
    breaker.forgetSession('session-a')
    expect(breaker.record('session-a', 'profile', ['cmd-exe-chain']).count).toBe(1)
    expect(breaker.record('session-a', 'profile', ['posix-export']).count).toBe(1)
    expect(breaker.record('session-b', 'profile', ['cmd-exe-chain']).count).toBe(2)
  })

  it('不变量：任意 record/clear 交错后，同键计数 = record 次数 − clear 次数，且 tripped ⇔ 计数 ≥2', () => {
    // AGENTS.md 队列/票据类不变量要求：确定性伪随机 + 每步守恒断言
    let seed = 0x5eed4d15
    const random = () => {
      seed |= 0
      seed = seed + 0x6d2b79f5 | 0
      let value = Math.imul(seed ^ seed >>> 15, 1)
      value = value + 0x6d2b79f5 | 0
      return ((value ^ value >>> 15) >>> 0) / 4294967296
    }
    const signalSets = [['cmd-exe-chain'], ['posix-export'], ['cmd-exe-chain', 'cmd-dir-switch']] as const
    for (let round = 0; round < 200; round += 1) {
      const breaker = new DialectRetryBreaker()
      // oracle: 键 -> 有效计数
      const oracle = new Map<string, number>()
      for (let step = 0; step < 40; step += 1) {
        const sessionId = `s${Math.floor(random() * 2)}`
        const profileId = `p${Math.floor(random() * 2)}`
        const signals = signalSets[Math.floor(random() * signalSets.length)]!
        const key = JSON.stringify([sessionId, profileId, [...signals].sort()])
        const op = random()
        if (op < 0.7) {
          const { count, tripped } = breaker.record(sessionId, profileId, signals)
          const expected = (oracle.get(key) ?? 0) + 1
          oracle.set(key, expected)
          expect(count, `round ${round} step ${step} record`).toBe(expected)
          expect(tripped, `round ${round} step ${step} tripped ⇔ count>=2`).toBe(expected >= 2)
        } else {
          breaker.clear(sessionId, profileId, signals)
          oracle.delete(key)
        }
      }
      for (const [key, expected] of oracle) {
        const [sessionId, profileId, signals] = JSON.parse(key) as [string, string, string[]]
        expect(breaker.record(sessionId, profileId, signals).count, `round ${round} key ${key} 守恒`).toBe(expected + 1)
      }
    }
  })
})
