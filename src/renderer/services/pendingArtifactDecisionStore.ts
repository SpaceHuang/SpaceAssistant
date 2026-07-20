import type {
  ArtifactDecisionRequest,
  ArtifactDecisionSubmitResult
} from '../../shared/artifactDecisionTypes'

type Listener = () => void

export type PendingArtifactDecisionItem = ArtifactDecisionRequest & {
  uiStatus?: 'active' | 'stale'
}

class PendingArtifactDecisionStore {
  private items: PendingArtifactDecisionItem[] = []
  private listeners = new Set<Listener>()
  private initialized = false
  private unsubRequest: (() => void) | null = null
  private unsubSettled: (() => void) | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.unsubRequest = window.api.artifactOnDecisionRequest((data) => {
      if (this.items.some((item) => item.decisionId === data.decisionId)) return
      this.items.push({ ...data, uiStatus: 'active' })
      this.notify()
    })
    this.unsubSettled = window.api.artifactOnDecisionSettled((event) => {
      if (event.reason === 'resolved') {
        this.items = this.items.filter((item) => item.decisionId !== event.decisionId)
      } else {
        this.items = this.items.map((item) =>
          item.decisionId === event.decisionId ? { ...item, uiStatus: 'stale' } : item
        )
      }
      this.notify()
    })
  }

  dispose(): void {
    this.unsubRequest?.()
    this.unsubSettled?.()
    this.unsubRequest = null
    this.unsubSettled = null
    this.initialized = false
    this.items = []
    this.listeners.clear()
  }

  getItems(): PendingArtifactDecisionItem[] {
    return [...this.items]
  }

  findForSession(sessionId: string): PendingArtifactDecisionItem | undefined {
    return this.items.find((item) => item.sessionId === sessionId)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(item: ArtifactDecisionRequest, choice: string): void {
    void this.respondAsync(item, choice)
  }

  private async respondAsync(item: ArtifactDecisionRequest, choice: string): Promise<void> {
    let result: ArtifactDecisionSubmitResult
    try {
      result = await window.api.artifactDecisionResponse({
        decisionId: item.decisionId,
        requestId: item.requestId,
        sessionId: item.sessionId,
        toolUseId: item.toolUseId,
        attempt: item.attempt,
        choice
      })
    } catch {
      this.items = this.items.map((candidate) =>
        candidate.decisionId === item.decisionId ? { ...candidate, uiStatus: 'stale' } : candidate
      )
      this.notify()
      return
    }
    if (result === 'resolved') {
      this.items = this.items.filter((candidate) => candidate.decisionId !== item.decisionId)
    } else {
      this.items = this.items.map((candidate) =>
        candidate.decisionId === item.decisionId ? { ...candidate, uiStatus: 'stale' } : candidate
      )
    }
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

  /** Test helper: seed a pending card without going through IPC. */
  upsertForTests(item: PendingArtifactDecisionItem): void {
    this.items = this.items.filter((candidate) => candidate.decisionId !== item.decisionId)
    this.items.push({ uiStatus: 'active', ...item })
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const pendingArtifactDecisionStore = new PendingArtifactDecisionStore()
