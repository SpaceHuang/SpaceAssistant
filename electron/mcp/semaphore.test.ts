import { describe, expect, it } from 'vitest'
import { Semaphore, withSemaphore } from './semaphore'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Semaphore', () => {
  it('caps concurrent executions at the limit', async () => {
    const semaphore = new Semaphore(2)
    let active = 0
    let peak = 0
    const run = async () => {
      await semaphore.acquire()
      active++
      peak = Math.max(peak, active)
      await sleep(20)
      active--
      semaphore.release()
    }
    await Promise.all(Array.from({ length: 6 }, () => run()))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('withSemaphore releases on error', async () => {
    const semaphore = new Semaphore(1)
    await expect(
      withSemaphore(semaphore, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await semaphore.acquire()
    semaphore.release()
  })

  it('serializes with limit 1', async () => {
    const semaphore = new Semaphore(1)
    let concurrent = 0
    let maxConcurrent = 0
    const run = async () => {
      await semaphore.acquire()
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(10)
      concurrent--
      semaphore.release()
    }
    await Promise.all(Array.from({ length: 4 }, () => run()))
    expect(maxConcurrent).toBe(1)
  })
})
