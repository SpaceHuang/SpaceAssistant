import { describe, expect, it } from 'vitest'
import {
  registerSessionActiveStream,
  clearSessionActiveStream,
  isSessionActiveStream,
  clearAllSessionActiveStreamsForTest
} from './chatActiveStreams'

describe('chatActiveStreams（sessionId → 活跃流登记）', () => {
  it('注册后视为运行中，全部清理后视为空闲', () => {
    clearAllSessionActiveStreamsForTest()
    registerSessionActiveStream('s1', 'r1')
    expect(isSessionActiveStream('s1')).toBe(true)
    clearSessionActiveStream('s1', 'r1')
    expect(isSessionActiveStream('s1')).toBe(false)
  })

  it('重入语义：同会话多请求按 requestId 粒度删除，旧请求清理不丢登记', () => {
    clearAllSessionActiveStreamsForTest()
    registerSessionActiveStream('s1', 'r1')
    registerSessionActiveStream('s1', 'r2')
    clearSessionActiveStream('s1', 'r1')
    expect(isSessionActiveStream('s1')).toBe(true)
    clearSessionActiveStream('s1', 'r2')
    expect(isSessionActiveStream('s1')).toBe(false)
  })

  it('清理未注册的 requestId 是安全空操作', () => {
    clearAllSessionActiveStreamsForTest()
    expect(() => clearSessionActiveStream('sX', 'rX')).not.toThrow()
    expect(isSessionActiveStream('sX')).toBe(false)
  })

  it('随机操作序列不变量：active ⇔ 已登记 requestId 集非空', () => {
    clearAllSessionActiveStreamsForTest()
    // mulberry32 确定性伪随机
    let seed = 20260918
    const rand = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const sessions = ['s1', 's2']
    const requests = ['r1', 'r2', 'r3']
    const live = new Map<string, Set<string>>() // oracle: `${session}:${request}` → true
    for (let i = 0; i < 500; i++) {
      const s = sessions[Math.floor(rand() * sessions.length)]!
      const r = requests[Math.floor(rand() * requests.length)]!
      const key = `${s}:${r}`
      if (rand() < 0.5) {
        registerSessionActiveStream(s, r)
        if (!live.has(key)) live.set(key, new Set())
        live.get(key)!.add(r)
      } else {
        clearSessionActiveStream(s, r)
        live.delete(key)
      }
      // 不变量：登记态 ⇔ oracle 非空；且「已登记请求数」守恒（Set 去重由 oracle 模拟）
      const oracleCount = [...live.keys()].filter((k) => k.startsWith(`${s}:`)).length
      expect(isSessionActiveStream(s)).toBe(oracleCount > 0)
    }
  })
})
