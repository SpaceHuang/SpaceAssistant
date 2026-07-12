const running = new Set<string>()

export type ClaimResult = 'ok' | 'session_busy' | 'parallel_full'

/**
 * Atomically claim a session: single-flight per sessionId + global parallel cap.
 * countRunningRemoteAgents() === running.size (distinct busy session count).
 */
export function tryClaimRemoteSession(sessionId: string, maxParallel: number): ClaimResult {
  if (running.has(sessionId)) {
    return 'session_busy'
  }
  if (running.size >= maxParallel) {
    return 'parallel_full'
  }
  running.add(sessionId)
  return 'ok'
}

/** Idempotent release; safe to call multiple times. */
export function releaseRemoteSession(sessionId: string): void {
  running.delete(sessionId)
}

/** @deprecated Use tryClaimRemoteSession / releaseRemoteSession in processCommand instead. */
export function registerRunningRemoteAgent(sessionId: string): void {
  running.add(sessionId)
}

/** @deprecated Use releaseRemoteSession in processCommand finally instead. */
export function unregisterRunningRemoteAgent(sessionId: string): void {
  running.delete(sessionId)
}

export function countRunningRemoteAgents(): number {
  return running.size
}

export function isRemoteAgentRunning(sessionId: string): boolean {
  return running.has(sessionId)
}

/** Test-only: reset registry between tests. */
export function resetRunningRemoteAgentRegistryForTests(): void {
  running.clear()
}
