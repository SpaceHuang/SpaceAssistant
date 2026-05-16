/** requestId → sessionId，供 IPC 事件路由（多会话并行） */
const requestToSession = new Map<string, string>()

export function registerRunRequest(sessionId: string, requestId: string): void {
  requestToSession.set(requestId, sessionId)
}

export function unregisterRunRequest(requestId: string): void {
  requestToSession.delete(requestId)
}

export function unregisterRunRequestsForSession(sessionId: string): void {
  for (const [requestId, sid] of requestToSession) {
    if (sid === sessionId) requestToSession.delete(requestId)
  }
}

export function resolveSessionIdForRequest(requestId: string): string | undefined {
  return requestToSession.get(requestId)
}

/** 测试用 */
export function clearRunRequestIndex(): void {
  requestToSession.clear()
}
