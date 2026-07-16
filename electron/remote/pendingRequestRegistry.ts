export type PendingDecision = 'y' | 'n' | 'timeout'

export type PendingAuthFields = {
  channel?: 'feishu' | 'wechat'
  authOwner?: string
  authorizationGeneration?: number
  requestId?: string
}

export class PendingRequestRegistry<
  T extends { id: string; sessionId: string; expiresAt: number } & PendingAuthFields
> {
  private pending = new Map<string, T>()
  private resolvers = new Map<string, (v: PendingDecision) => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  listPending(): T[] {
    return [...this.pending.values()]
  }

  get(id: string): T | undefined {
    return this.pending.get(id)
  }

  hasPendingForSession(sessionId: string): boolean {
    return [...this.pending.values()].some((p) => p.sessionId === sessionId)
  }

  countPending(): number {
    return this.pending.size
  }

  cancel(id: string, onCancel?: (item: T) => void): boolean {
    const item = this.pending.get(id)
    if (!item) return false
    onCancel?.(item)
    this.resolve(id, 'n')
    return true
  }

  /** Resolve every waiter with 'n' (e.g. on app quit) so long timers do not keep the process alive. */
  cancelAllPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.resolve(id, 'n')
    }
  }

  /**
   * Synchronously cancel all pending items for a channel (authorization revoke linearization).
   * Returns number of cancelled items.
   */
  cancelByChannel(channel: 'feishu' | 'wechat'): number {
    let n = 0
    for (const item of [...this.pending.values()]) {
      if (item.channel === channel) {
        this.resolve(item.id, 'n')
        n++
      }
    }
    return n
  }

  /**
   * Store item and wait for resolve()/cancel()/timeout.
   * Caller must ensure the id is unique and not already registered.
   */
  register(
    item: T,
    timeoutMs: number,
    opts?: { onTimeout?: (item: T) => void }
  ): Promise<PendingDecision> {
    this.pending.set(item.id, item)
    return new Promise((resolve) => {
      this.resolvers.set(item.id, resolve)
      const timer = setTimeout(() => {
        if (!this.pending.has(item.id)) return
        const current = this.pending.get(item.id)
        this.resolve(item.id, 'timeout')
        if (current) opts?.onTimeout?.(current)
      }, timeoutMs)
      this.timers.set(item.id, timer)
    })
  }

  /** Resolve a pending request. Returns false if id is unknown. */
  resolve(id: string, decision: PendingDecision): boolean {
    if (!this.pending.has(id) && !this.resolvers.has(id)) return false
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    const resolver = this.resolvers.get(id)
    this.resolvers.delete(id)
    this.pending.delete(id)
    resolver?.(decision)
    return true
  }
}
