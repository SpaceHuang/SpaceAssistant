import type { PolicyAuthorizationChangeRegistryLike } from './agentRuntime'

/** Runtime-scoped fanout from persisted policy versions to active invocation leases. */
export class PolicyAuthorizationChangeRegistry implements PolicyAuthorizationChangeRegistryLike {
  private readonly listeners = new Map<string, Set<() => void>>()

  subscribe(requestId: string, lane: string, listener: () => void): () => void {
    const key = keyFor(requestId, lane)
    const group = this.listeners.get(key) ?? new Set<() => void>()
    group.add(listener)
    this.listeners.set(key, group)
    return () => {
      group.delete(listener)
      if (group.size === 0) this.listeners.delete(key)
    }
  }

  publish(lane: string): number {
    let count = 0
    const marker = `:${lane}`
    for (const [key, listeners] of this.listeners) {
      if (!key.endsWith(marker)) continue
      for (const listener of [...listeners]) {
        try { listener() } catch (error) {
          console.error('[agentRuntime] policy authorization listener failed', error)
        }
        count += 1
      }
    }
    return count
  }
}

function keyFor(requestId: string, lane: string): string {
  return `${requestId.length}:${requestId}:${lane}`
}
