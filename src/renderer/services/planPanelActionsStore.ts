import type { PlanPanelActions } from '../components/Plan/PlanPanelActionsContext'

type Listener = () => void

class PlanPanelActionsStore {
  private actions: PlanPanelActions | null = null
  private listeners = new Set<Listener>()

  set(actions: PlanPanelActions | null): void {
    this.actions = actions
    this.notify()
  }

  get(): PlanPanelActions | null {
    return this.actions
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const planPanelActionsStore = new PlanPanelActionsStore()
