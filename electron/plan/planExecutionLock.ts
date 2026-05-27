/** Session 级 Plan 自动执行锁，防止同一 session 并发多个 run loop */
const locks = new Map<string, string>()

export class PlanExecutionLockError extends Error {
  constructor(sessionId: string) {
    super(`Plan execution already running for session ${sessionId}`)
    this.name = 'PlanExecutionLockError'
  }
}

export function acquireSessionExecutionLock(sessionId: string, requestId: string): void {
  const existing = locks.get(sessionId)
  if (existing && existing !== requestId) {
    throw new PlanExecutionLockError(sessionId)
  }
  locks.set(sessionId, requestId)
}

export function releaseSessionExecutionLock(sessionId: string, requestId: string): void {
  if (locks.get(sessionId) === requestId) {
    locks.delete(sessionId)
  }
}

export function isSessionExecutionLocked(sessionId: string): boolean {
  return locks.has(sessionId)
}

export function getSessionExecutionLockHolder(sessionId: string): string | undefined {
  return locks.get(sessionId)
}

/** 测试用 */
export function clearAllPlanExecutionLocks(): void {
  locks.clear()
}
