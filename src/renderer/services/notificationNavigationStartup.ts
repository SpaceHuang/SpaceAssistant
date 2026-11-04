import type { Session } from '../../shared/domainTypes'
import { store } from '../store'
import { setSession } from '../store/chatSlice'
import { setSessions } from '../store/sessionSlice'
import { navigateToPendingConfirmation } from './notificationNavigation'

export type PendingConfirmationNavigation = { sessionId: string; toolUseId?: string }
type Navigate = (payload: PendingConfirmationNavigation) => Promise<void>

/**
 * Holds notification navigation until config and the startup session selection are ready.
 * A single latest request is enough: each notification represents the newest pending target.
 */
export class NotificationNavigationStartup {
  private initialSessionSelectionReady = false
  private queuedNavigation: PendingConfirmationNavigation | null = null
  private unsubscribe: () => void

  constructor(
    private navigate: Navigate = navigateToPendingConfirmation,
    private onError: (error: unknown) => void = () => {}
  ) {
    this.unsubscribe = store.subscribe(() => {
      if (this.isReady() && this.queuedNavigation) {
        void this.flush().catch(this.onError)
      }
    })
  }

  receive(payload: PendingConfirmationNavigation): Promise<void> {
    this.queuedNavigation = payload
    return this.flush()
  }

  /** Apply the default startup session first, then allow a queued notification to take precedence. */
  completeInitialSessionLoad(sessions: Session[] | null): Promise<void> {
    if (sessions) {
      store.dispatch(setSessions(sessions))
      if (sessions[0]) store.dispatch(setSession(sessions[0].id))
    }
    this.initialSessionSelectionReady = true
    return this.flush()
  }

  dispose(): void {
    this.unsubscribe()
    this.queuedNavigation = null
  }

  private isReady(): boolean {
    return this.initialSessionSelectionReady && store.getState().config.config !== null
  }

  private flush(): Promise<void> {
    if (!this.isReady() || !this.queuedNavigation) return Promise.resolve()
    const payload = this.queuedNavigation
    this.queuedNavigation = null
    return this.navigate(payload)
  }
}
