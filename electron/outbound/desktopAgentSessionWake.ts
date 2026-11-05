export function wakeQueuedAgentSessions(input: {
  sessionIds: () => Iterable<string>
  getNextQueued: (sessionId: string) => { source?: string } | null
  recoverTarget: (sessionId: string) => { status: 'ready' | 'blocked' | 'active-owner' }
  drain: (sessionId: string) => void | Promise<void>
  onError?: (sessionId: string, error: unknown) => void
}): void {
  for (const sessionId of input.sessionIds()) {
    try {
      if (input.getNextQueued(sessionId)?.source !== 'agent-session') continue
      if (input.recoverTarget(sessionId).status !== 'ready') continue
      void Promise.resolve(input.drain(sessionId)).catch((error: unknown) => input.onError?.(sessionId, error))
    } catch (error) {
      input.onError?.(sessionId, error)
    }
  }
}
