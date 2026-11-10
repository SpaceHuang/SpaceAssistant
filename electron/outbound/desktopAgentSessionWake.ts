import type { OutboundDrainWakeReason } from './drainWake'

export function wakeQueuedAgentSessions(input: {
  sessionIds: () => Iterable<string>
  getNextQueued: (sessionId: string) => { source?: string } | null
  recoverTarget: (sessionId: string) => { status: 'ready' | 'blocked' | 'active-owner' }
  reason: OutboundDrainWakeReason
  drain: (sessionId: string, reason: OutboundDrainWakeReason) => void | Promise<void>
  onError?: (sessionId: string, error: unknown) => void
}): void {
  for (const sessionId of input.sessionIds()) {
    try {
      const source = input.getNextQueued(sessionId)?.source
      if (source === 'invalid') {
        // Let the queue owner audit and park a corrupt physical head; never skip to later input.
        void Promise.resolve(input.drain(sessionId, input.reason)).catch((error: unknown) => input.onError?.(sessionId, error))
        continue
      }
      if (source !== 'agent-session') continue
      if (input.recoverTarget(sessionId).status !== 'ready') continue
      void Promise.resolve(input.drain(sessionId, input.reason)).catch((error: unknown) => input.onError?.(sessionId, error))
    } catch (error) {
      input.onError?.(sessionId, error)
    }
  }
}
