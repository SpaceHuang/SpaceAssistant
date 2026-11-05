export function wakeQueuedAgentSessions(input: {
  sessionIds: () => Iterable<string>
  getNextQueued: (sessionId: string) => { source?: string } | null
  drain: (sessionId: string) => void | Promise<void>
  onError?: (sessionId: string, error: unknown) => void
}): void {
  for (const sessionId of input.sessionIds()) {
    try {
      if (input.getNextQueued(sessionId)?.source !== 'agent-session') continue
      void Promise.resolve(input.drain(sessionId)).catch((error: unknown) => input.onError?.(sessionId, error))
    } catch (error) {
      input.onError?.(sessionId, error)
    }
  }
}
