type RunRequestRegistration = Readonly<{ sessionId: string; requestId: string; turnId?: string }>

/** requestId → owning session registrations; same requestId can be active in distinct sessions. */
const requestToSessions = new Map<string, Map<string, RunRequestRegistration>>()

export function registerRunRequest(sessionId: string, requestId: string, turnId?: string): void {
  const sessions = requestToSessions.get(requestId) ?? new Map<string, RunRequestRegistration>()
  sessions.set(sessionId, { sessionId, requestId, ...(turnId ? { turnId } : {}) })
  requestToSessions.set(requestId, sessions)
}

export function unregisterRunRequest(requestId: string, sessionId?: string): void {
  if (sessionId === undefined) {
    requestToSessions.delete(requestId)
    return
  }
  const sessions = requestToSessions.get(requestId)
  sessions?.delete(sessionId)
  if (sessions?.size === 0) requestToSessions.delete(requestId)
}

export function unregisterRunRequestsForSession(sessionId: string): void {
  for (const [requestId, sessions] of requestToSessions) {
    sessions.delete(sessionId)
    if (sessions.size === 0) requestToSessions.delete(requestId)
  }
}

export function resolveSessionIdForRequest(requestId: string): string | undefined {
  const sessions = requestToSessions.get(requestId)
  return sessions?.size === 1 ? sessions.keys().next().value : undefined
}

export function resolveRunRequest(sessionId: string, requestId: string): RunRequestRegistration | undefined {
  return requestToSessions.get(requestId)?.get(sessionId)
}

/** 测试用 */
export function clearRunRequestIndex(): void {
  requestToSessions.clear()
}
