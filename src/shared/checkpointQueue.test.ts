import { describe, expect, it } from 'vitest'
import { CheckpointQueue } from './checkpointQueue'

describe('CheckpointQueue', () => {
  it('同一 turn 的异步 checkpoint 不重叠，并按提交顺序执行', async () => {
    const queue = new CheckpointQueue()
    let inFlight = 0
    let maxInFlight = 0
    const order: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const write = (version: number) => queue.enqueue('turn-1', async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(version)
      if (version === 1) await firstGate
      inFlight--
      return true
    })

    const first = write(1)
    const second = write(2)
    expect(maxInFlight).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(maxInFlight).toBe(1)
    expect(order).toEqual([1, 2])
  })

  it('不同 turn 可以并行 checkpoint', async () => {
    const queue = new CheckpointQueue()
    let inFlight = 0
    let maxInFlight = 0
    const write = (key: string) => queue.enqueue(key, async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      return true
    })
    await Promise.all([write('turn-1'), write('turn-2')])
    expect(maxInFlight).toBe(2)
  })

  it('前一次异步写入失败后不会阻塞同 turn 后续写入', async () => {
    const queue = new CheckpointQueue()
    const order: number[] = []
    const first = queue.enqueue('turn-1', async () => {
      order.push(1)
      throw new Error('SQLITE_BUSY')
    })
    const second = queue.enqueue('turn-1', async () => {
      order.push(2)
      return true
    })

    await expect(first).rejects.toThrow('SQLITE_BUSY')
    await expect(second).resolves.toBe(true)
    expect(order).toEqual([1, 2])
  })
})
