export type DeferredPolicyChangeListener = () => void | Promise<void>

/** Process-local wake signal for durable IM todos invalidated by a committed policy revision. */
class DeferredPolicyChangeRegistry {
  private readonly listeners = new Map<'feishu' | 'wechat', Set<DeferredPolicyChangeListener>>()

  subscribe(channel: 'feishu' | 'wechat', listener: DeferredPolicyChangeListener): () => void {
    const group = this.listeners.get(channel) ?? new Set<DeferredPolicyChangeListener>()
    group.add(listener)
    this.listeners.set(channel, group)
    return () => {
      group.delete(listener)
      if (group.size === 0) this.listeners.delete(channel)
    }
  }

  publish(channel: 'feishu' | 'wechat'): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      try { void Promise.resolve(listener()).catch((error) => console.error('[deferredPolicyChangeRegistry] listener failed', error)) }
      catch (error) { console.error('[deferredPolicyChangeRegistry] listener failed', error) }
    }
  }
}

export const deferredPolicyChangeRegistry = new DeferredPolicyChangeRegistry()
