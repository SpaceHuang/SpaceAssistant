import { describe, expect, it } from 'vitest'
import { pendingWikiWriteCount, withWikiWriteMutex } from './wikiWriteMutex'

/**
 * 不变量测试（AGENTS.md 纪律 + 需求 §9.4/§15.2）：
 * mulberry32 固定种子生成随机并发写序列，每步后断言：
 * ① 同文件内容 = 按互斥区进入顺序（= 注册顺序，FIFO 队列）串行应用的结果；
 * ② 不同文件允许交错（不做全局串行化，跨文件任务无顺序约束）；
 * ③ 终态队列清空（无悬挂 promise / 死锁）。
 * 破坏互斥包装（直接调用 fn）应使 ① 转红（读-改-写在 yield 窗口交错产生丢失更新）。
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const FILES = [
  'C:\\data\\llm-wiki\\wiki\\index.md',
  'C:\\data\\llm-wiki\\wiki\\log.md',
  'C:\\data\\llm-wiki\\wiki\\entities\\x.md'
]

async function runInvariantSequence(seed: number, steps: number): Promise<void> {
  const rand = mulberry32(seed)
  const store = new Map<string, string>()
  const expected = new Map<string, string>()

  for (let step = 0; step < steps; step++) {
    // 每步并发 1-3 个写任务（可能同文件也可能跨文件；② 不同文件可交错）
    const fanout = 1 + Math.floor(rand() * 3)
    const tasks: Array<Promise<unknown>> = []
    for (let k = 0; k < fanout; k++) {
      const file = FILES[Math.floor(rand() * FILES.length)]
      const opId = `${step}.${k}`
      tasks.push(
        withWikiWriteMutex(file, async () => {
          // 读-改-写 + yield：无互斥时并发任务将在窗口内交错，产生丢失更新
          const current = store.get(file) ?? ''
          await Promise.resolve()
          store.set(file, `${current}#${opId}`)
          expected.set(file, `${expected.get(file) ?? ''}#${opId}`)
        })
      )
    }
    await Promise.all(tasks)
    // ① 每步后断言：同文件内容 = 按互斥区进入顺序串行应用的结果
    for (const file of FILES) {
      expect(store.get(file)).toBe(expected.get(file))
    }
  }
}

describe('wikiWriteMutex 不变量（T0.6）', () => {
  it('随机 200 步并发序列：同文件串行一致、不同文件可交错、终态队列清空', async () => {
    await runInvariantSequence(20261010, 200)
    // ③ 终态队列清空
    expect(pendingWikiWriteCount()).toBe(0)
  })

  it('不同种子多轮序列后队列仍清空（复用不残留）', async () => {
    for (let round = 0; round < 5; round++) {
      await runInvariantSequence(1000 + round * 7919, 40)
      expect(pendingWikiWriteCount()).toBe(0)
    }
  })

  it('失败传播给调用者但不阻塞后续同文件写入', async () => {
    const file = FILES[0]
    await expect(
      withWikiWriteMutex(file, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await expect(withWikiWriteMutex(file, async () => 'ok')).resolves.toBe('ok')
    expect(pendingWikiWriteCount()).toBe(0)
  })

  it('同步 fn 也被支持', async () => {
    await expect(withWikiWriteMutex(FILES[1], () => 'sync')).resolves.toBe('sync')
    expect(pendingWikiWriteCount()).toBe(0)
  })
})
