/**
 * 信号量与 MCP 并发闸(SDK 纯核,偏差 18/19):无宿主依赖,随 runtime 实例走。
 */

export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0

  constructor(readonly limit: number) {}

  get pending(): number {
    return this.queue.length
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.active = Math.max(0, this.active - 1)
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

/** MCP 并发闸:全局 + 每服务两级信号量(每实例独立持有,不再模块级共享)。 */
export class McpConcurrencyGate {
  private readonly perServerSemaphores = new Map<string, Semaphore>()
  private readonly globalSemaphore: Semaphore

  constructor(
    readonly globalConcurrency = 8,
    private readonly perServerConcurrency = 4
  ) {
    this.globalSemaphore = new Semaphore(this.globalConcurrency)
  }

  perServer(serverId: string): Semaphore {
    let semaphore = this.perServerSemaphores.get(serverId)
    if (!semaphore) {
      semaphore = new Semaphore(this.perServerConcurrency)
      this.perServerSemaphores.set(serverId, semaphore)
    }
    return semaphore
  }

  run<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    return withSemaphore(this.globalSemaphore, () => withSemaphore(this.perServer(serverId), fn))
  }
}
