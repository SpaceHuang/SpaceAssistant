import type { TurnDisplay } from '../../shared/turnDisplayProtocol'
import { turnDisplayStore, type TurnDisplayStore } from './turnDisplayStore'

type Known = { turnId: string; version: number }
type Read = (payload: { known: Known[] }) => Promise<{ changed: TurnDisplay[] }>

export class TurnDisplayReconciliation {
  private readonly known = new Map<string, number>()
  private inFlight?: Promise<void>
  constructor(private readonly read: Read, readonly store: TurnDisplayStore = turnDisplayStore) {}
  remember(item: Known): void { this.known.set(item.turnId, Math.max(item.version, this.known.get(item.turnId) ?? -1)) }
  getKnown(): Known[] { return [...this.known].map(([turnId, version]) => ({ turnId, version })) }
  clear(): void { this.known.clear(); this.store.clear() }
  reconcile(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const activeKnown = this.store.activeKnown()
    // store 是实时事实；测试/启动阶段若 store 尚未恢复，则沿用尚存的 active known。
    const known = activeKnown.length > 0 ? activeKnown : this.getKnown()
    this.known.clear()
    for (const item of known) this.known.set(item.turnId, item.version)
    this.inFlight = this.read({ known }).then(async ({ changed }) => {
      for (const display of changed) {
        this.store.enqueue(display)
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('spaceassistant:turn-display-reconcile', { detail: display }))
        if (display.lifecycle === 'running' || display.lifecycle === 'awaiting-confirmation') this.remember({ turnId: display.turnId, version: display.version })
        else this.known.delete(display.turnId)
      }
      // 连接恢复时重新触发仍未 ready 的确认详情读取。
      const confirmStore = await import('./pendingConfirmStore')
      confirmStore.pendingConfirmStore.retryUnready()
      this.store.flush()
    }).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
}

export const turnDisplayReconciliation = new TurnDisplayReconciliation((payload) => window.api.chatGetTurnDisplays(payload))
