import type { TurnDisplay } from '../../shared/turnDisplayProtocol'

type Listener = (items: TurnDisplay[]) => void

export class TurnDisplayStore {
  private readonly displays = new Map<string, TurnDisplay>()
  private readonly observedVersions = new Map<string, number>()
  private readonly pending = new Map<string, TurnDisplay>()
  private readonly listeners = new Set<Listener>()
  private readonly turnListeners = new Map<string, Set<Listener>>()
  private snapshotItems: TurnDisplay[] = []
  enqueue(display: TurnDisplay): void {
    const current = this.displays.get(display.turnId)
    const queued = this.pending.get(display.turnId)
    const observed = this.observedVersions.get(display.turnId) ?? -1
    if (display.version <= observed || (current && display.version <= current.version) || (queued && display.version <= queued.version)) return
    this.pending.set(display.turnId, display)
  }
  flush(): void {
    if (this.pending.size === 0) return
    for (const [turnId, display] of this.pending) {
      const current = this.displays.get(turnId)
      if (!current || display.version > current.version) {
        this.displays.set(turnId, display)
        this.observedVersions.set(turnId, display.version)
      }
    }
    this.pending.clear()
    const items = [...this.displays.values()]
    this.snapshotItems = items
    for (const listener of this.listeners) listener(items)
    for (const [turnId, listeners] of this.turnListeners) for (const listener of listeners) listener(this.displays.has(turnId) ? [this.displays.get(turnId)!] : [])
  }
  get(turnId: string): TurnDisplay | undefined { return this.displays.get(turnId) }
  remove(turnId: string): void { this.pending.delete(turnId); const current = this.displays.get(turnId); if (current) this.observedVersions.set(turnId, Math.max(current.version, this.observedVersions.get(turnId) ?? -1)); if (this.displays.delete(turnId)) { this.snapshotItems = [...this.displays.values()]; for (const listener of this.listeners) listener(this.snapshotItems); for (const listener of this.turnListeners.get(turnId) ?? []) listener([]) } }
  all(): TurnDisplay[] { return this.snapshotItems }
  activeKnown(): Array<{ turnId: string; version: number }> {
    return [...this.displays.values()].filter((display) => display.lifecycle === 'running' || display.lifecycle === 'awaiting-confirmation').map((display) => ({ turnId: display.turnId, version: display.version }))
  }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeTurn(turnId: string, listener: Listener): () => void { const listeners = this.turnListeners.get(turnId) ?? new Set<Listener>(); listeners.add(listener); this.turnListeners.set(turnId, listeners); return () => { listeners.delete(listener); if (!listeners.size) this.turnListeners.delete(turnId) } }
  clear(): void { const ids = [...this.displays.keys()]; this.pending.clear(); this.displays.clear(); this.observedVersions.clear(); this.snapshotItems = []; for (const listener of this.listeners) listener([]); for (const id of ids) for (const listener of this.turnListeners.get(id) ?? []) listener([]); this.turnListeners.clear() }
}

export const turnDisplayStore = new TurnDisplayStore()

export function initTurnDisplayBridge(): () => void {
  let frameHandle: number | undefined
  let disposed = false
  const flush = (): void => {
    frameHandle = undefined
    if (!disposed) turnDisplayStore.flush()
  }
  const unsubscribe = window.api.chatOnTurnDisplay(({ display }) => {
    if (disposed) return
    turnDisplayStore.enqueue(display)
    if (typeof window.requestAnimationFrame === 'function') {
      if (frameHandle === undefined) frameHandle = window.requestAnimationFrame(flush)
    } else turnDisplayStore.flush()
  })
  return () => {
    disposed = true
    unsubscribe()
    if (frameHandle !== undefined && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frameHandle)
    frameHandle = undefined
    turnDisplayStore.clear()
  }
}
