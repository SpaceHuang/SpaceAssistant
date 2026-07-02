import type { WriteDirConfirmChoice, WriteDirConfirmRequest } from '../../shared/api'

export type PendingWriteDirConfirmItem = WriteDirConfirmRequest

type Listener = () => void

class PendingWriteDirConfirmStore {
  private items: PendingWriteDirConfirmItem[] = []
  private listeners = new Set<Listener>()
  private initialized = false
  private unsub: (() => void) | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.unsub = window.api.fileWriteDirOnConfirmRequest((data) => {
      if (this.items.some((i) => i.requestId === data.requestId && i.sessionId === data.sessionId)) return
      this.items.push(data)
      this.notify()
    })
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.initialized = false
    this.items = []
    this.listeners.clear()
  }

  getItems(): PendingWriteDirConfirmItem[] {
    return [...this.items]
  }

  findForSession(sessionId: string): PendingWriteDirConfirmItem | undefined {
    return this.items.find((i) => i.sessionId === sessionId)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(item: PendingWriteDirConfirmItem, choice: WriteDirConfirmChoice | null): void {
    void window.api.fileWriteDirConfirmResponse({
      requestId: item.requestId,
      sessionId: item.sessionId,
      choice
    })
    this.items = this.items.filter(
      (i) => !(i.requestId === item.requestId && i.sessionId === item.sessionId)
    )
    this.notify()
  }

  removeAllForRequest(requestId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => i.requestId !== requestId)
    if (this.items.length !== before) this.notify()
  }

  reset(): void {
    this.items = []
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const pendingWriteDirConfirmStore = new PendingWriteDirConfirmStore()
