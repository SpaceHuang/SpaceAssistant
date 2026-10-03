const compactingSessions = new Set<string>()
const compactionLocks = new Set<string>()
const turnAdmissionSessions = new Set<string>()
const activeTurnAdmissionBlocks = new Map<string, (sessionId: string) => boolean>()

export function isSessionContextCompacting(sessionId: string): boolean {
  return compactingSessions.has(sessionId)
}

export function registerSessionCompactionAdmissionBlocker(ownerId: string, blocker: (sessionId: string) => boolean): () => void {
  activeTurnAdmissionBlocks.set(ownerId, blocker)
  return () => activeTurnAdmissionBlocks.delete(ownerId)
}

export function isSessionContextCompactionLocked(sessionId: string): boolean {
  return compactingSessions.has(sessionId) && compactionLocks.has(sessionId)
}

export function tryAcquireSessionContextCompactionLock(sessionId: string): (() => void) | undefined {
  if (compactingSessions.has(sessionId) || turnAdmissionSessions.has(sessionId)) return undefined
  compactingSessions.add(sessionId)
  compactionLocks.add(sessionId)
  return () => { compactingSessions.delete(sessionId); compactionLocks.delete(sessionId) }
}

function tryAcquireTurnAdmission(sessionId: string): (() => void) | undefined {
  if (compactingSessions.has(sessionId) || turnAdmissionSessions.has(sessionId)) return undefined
  turnAdmissionSessions.add(sessionId)
  return () => turnAdmissionSessions.delete(sessionId)
}

export async function withSessionTurnAdmission<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
  const release = tryAcquireTurnAdmission(sessionId)
  if (!release) throw new Error('SESSION_CONTEXT_COMPACTION_BUSY')
  try { return await operation() } finally { release() }
}

export function isSessionTurnAdmissionBlocked(sessionId: string): boolean {
  return compactingSessions.has(sessionId) || turnAdmissionSessions.has(sessionId) || isActiveTurnAdmissionBlocked(sessionId)
}

export function isActiveTurnAdmissionBlocked(sessionId: string): boolean {
  return [...activeTurnAdmissionBlocks.values()].some((blocker) => blocker(sessionId))
}

export async function withSessionContextCompactionLock<T>(
  sessionId: string,
  operation: () => Promise<T>
): Promise<{ status: 'busy' } | { status: 'ran'; value: T }> {
  if (compactingSessions.has(sessionId) || turnAdmissionSessions.has(sessionId)) return { status: 'busy' }
  compactingSessions.add(sessionId)
  compactionLocks.add(sessionId)
  try {
    return { status: 'ran', value: await operation() }
  } finally {
    compactingSessions.delete(sessionId)
    compactionLocks.delete(sessionId)
  }
}
