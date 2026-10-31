/** Process-local fence: live provider work must never be mistaken for a stale claim. */
const activeOwners = new Set<string>()

export function hasActiveSessionExecutionOwner(sessionId: string): boolean {
  return activeOwners.has(sessionId)
}

export function registerActiveSessionExecutionOwner(sessionId: string): void {
  activeOwners.add(sessionId)
}

export function releaseActiveSessionExecutionOwner(sessionId: string): void {
  activeOwners.delete(sessionId)
}
