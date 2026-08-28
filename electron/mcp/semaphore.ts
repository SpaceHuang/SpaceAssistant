/**
 * 轻量信号量：MCP 每服务并发 4 / 全局并发 8 的排队用。
 */
export class Semaphore {
  private count: number
  private waiters: Array<() => void> = []

  constructor(limit: number) {
    this.count = Math.max(1, limit)
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.count++
    }
  }
}

export async function withSemaphore<T>(semaphore: Semaphore, fn: () => Promise<T>): Promise<T> {
  await semaphore.acquire()
  try {
    return await fn()
  } finally {
    semaphore.release()
  }
}
