import type { ArtifactDecisionRequest } from '../../shared/artifactDecisionTypes'

type Listener = () => void

class PendingArtifactDecisionStore {
  private items: ArtifactDecisionRequest[] = []
  private listeners = new Set<Listener>()
  private initialized = false
  private unsub: (() => void) | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.unsub = window.api.artifactOnDecisionRequest((data) => {
      if (this.items.some((item) => item.decisionId === data.decisionId)) return
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

  getItems(): ArtifactDecisionRequest[] {
    return [...this.items]
  }

  findForSession(sessionId: string): ArtifactDecisionRequest | undefined {
    return this.items.find((item) => item.sessionId === sessionId)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(item: ArtifactDecisionRequest, choice: string): void {
    void window.api.artifactDecisionResponse({
      decisionId: item.decisionId,
      requestId: item.requestId,
      sessionId: item.sessionId,
      toolUseId: item.toolUseId,
      attempt: item.attempt,
      choice
    })
    this.items = this.items.filter((candidate) => candidate.decisionId !== item.decisionId)
    this.notify()
  }

  cancel(item: ArtifactDecisionRequest): void {
    this.respond(item, 'cancel')
  }

  removeAllForRequest(requestId: string): void {
    const before = this.items.length
    this.items = this.items.filter((item) => item.requestId !== requestId)
    if (this.items.length !== before) this.notify()
  }

  reset(): void {
    this.items = []
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const pendingArtifactDecisionStore = new PendingArtifactDecisionStore()
