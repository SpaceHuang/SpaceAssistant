export type ResourceLease = { release(): void }

type Waiter = { keys: readonly string[]; resolve: (lease: ResourceLease) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }

/** Runtime-owned resource mutex; keys are already normalized by the host capability adapter. */
export class ResourceLockRegistry {
  private readonly held = new Set<string>()
  private readonly waiters: Waiter[] = []

  acquire(keys: readonly string[], options: { signal?: AbortSignal } = {}): Promise<ResourceLease> {
    const unique = [...new Set(keys)].sort()
    if (options.signal?.aborted) return Promise.reject(new Error('resource-lock-cancelled'))
    if (this.canAcquire(unique) && this.waiters.length === 0) return Promise.resolve(this.grant(unique))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { keys: unique, resolve, reject, signal: options.signal }
      if (options.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          reject(new Error('resource-lock-cancelled'))
        }
        options.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.wake()
    })
  }

  private canAcquire(keys: readonly string[]): boolean {
    return keys.every((key) => ![...this.held].some((held) => resourceConflict(key, held)))
  }

  private grant(keys: readonly string[]): ResourceLease {
    keys.forEach((key) => this.held.add(key))
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        keys.forEach((key) => this.held.delete(key))
        this.wake()
      }
    }
  }

  private wake(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!
      if (!this.canAcquire(waiter.keys)) {
        index += 1
        continue
      }
      this.waiters.splice(index, 1)
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(this.grant(waiter.keys))
    }
  }
}

function resourceConflict(a: string, b: string): boolean {
  if (a === b) return true
  // 未知副作用（Shell/MCP 等）无法证明影响范围，跨会话按全局屏障保守互斥。
  if (a.startsWith('unknown:') || b.startsWith('unknown:')) return true
  const prefix = 'workspace:'
  if (!a.startsWith(prefix) || !b.startsWith(prefix)) return false
  const normalize = (key: string) => {
    const value = key.slice(prefix.length)
    return value.length > 1 ? value.replace(/\/+$/, '') : value
  }
  const [left, right] = [normalize(a), normalize(b)]
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
