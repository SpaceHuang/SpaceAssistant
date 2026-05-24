import type { Session } from '../../shared/domainTypes'
import { getPendingPlanMeta } from '../../shared/planTypes'

export type PendingPlanItem = {
  sessionId: string
  planId: string
  title: string
}

type Listener = () => void

class PendingPlanStore {
  private items: PendingPlanItem[] = []
  private listeners = new Set<Listener>()
  private initialized = false
  private unsubReady: (() => void) | null = null
  private unsubState: (() => void) | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true

    const refresh = (sessionId: string) => {
      void window.api.planRead({ sessionId }).then((state) => {
        if (state.pendingPlan?.status === 'awaiting_approval') {
          this.upsert({
            sessionId,
            planId: state.pendingPlan.planId,
            title: state.summary?.title ?? '计划'
          })
        } else {
          this.removeSession(sessionId)
        }
      })
    }

    this.unsubReady = window.api.planOnApprovalReady((d) => {
      const pending = d.planState.pendingPlan
      if (pending?.status === 'awaiting_approval') {
        this.upsert({
          sessionId: d.sessionId,
          planId: pending.planId,
          title: d.planState.summary?.title ?? '计划'
        })
      }
    })

    this.unsubState = window.api.planOnStateChanged((d) => {
      refresh(d.sessionId)
    })
  }

  dispose(): void {
    this.unsubReady?.()
    this.unsubState?.()
    this.unsubReady = null
    this.unsubState = null
    this.initialized = false
    this.items = []
    this.listeners.clear()
  }

  refreshFromSessions(sessions: Session[]): void {
    const next: PendingPlanItem[] = []
    for (const s of sessions) {
      const pending = getPendingPlanMeta(s.metadata)
      if (pending?.status === 'awaiting_approval') {
        next.push({
          sessionId: s.id,
          planId: pending.planId,
          title: '计划'
        })
      }
    }
    this.items = next
    this.notify()
    for (const item of next) {
      void window.api.planRead({ sessionId: item.sessionId }).then((state) => {
        if (state.summary?.title) {
          this.upsert({ ...item, title: state.summary.title })
        }
      })
    }
  }

  getItems(): PendingPlanItem[] {
    return [...this.items]
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private upsert(item: PendingPlanItem): void {
    const i = this.items.findIndex((x) => x.sessionId === item.sessionId)
    if (i >= 0) this.items[i] = item
    else this.items.push(item)
    this.notify()
  }

  private removeSession(sessionId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => i.sessionId !== sessionId)
    if (this.items.length !== before) this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const pendingPlanStore = new PendingPlanStore()
