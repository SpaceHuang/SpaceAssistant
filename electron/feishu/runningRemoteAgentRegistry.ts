const running = new Set<string>()

export function registerRunningRemoteAgent(sessionId: string): void {
  running.add(sessionId)
}

export function unregisterRunningRemoteAgent(sessionId: string): void {
  running.delete(sessionId)
}

export function countRunningRemoteAgents(): number {
  return running.size
}

export function isRemoteAgentRunning(sessionId: string): boolean {
  return running.has(sessionId)
}
