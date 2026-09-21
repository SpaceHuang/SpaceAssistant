/**
 * sessionId → 活跃流反向登记（需求 §9.4）。
 * 现状 chatCancelRegistry 仅按 requestId 登记；本模块补 Map<sessionId, Set<requestId>>，
 * 供 action.session.status / action.session.list 判定「会话是否正在运行」。
 *
 * 写点约定（与 toolChatLoop 的注册/清理对称）：
 * - runToolChatSession 入口（registerChatCancel 之后）调用 registerSessionActiveStream
 * - finally 清理调用 clearSessionActiveStream，按 requestId 粒度删除——重入时旧请求清理不丢新登记
 */
const activeStreams = new Map<string, Set<string>>()

export function registerSessionActiveStream(sessionId: string, requestId: string): void {
  if (!sessionId || !requestId) return
  let set = activeStreams.get(sessionId)
  if (!set) {
    set = new Set()
    activeStreams.set(sessionId, set)
  }
  set.add(requestId)
}

export function clearSessionActiveStream(sessionId: string, requestId: string): void {
  const set = activeStreams.get(sessionId)
  if (!set) return
  set.delete(requestId)
  if (set.size === 0) activeStreams.delete(sessionId)
}

export function isSessionActiveStream(sessionId: string): boolean {
  return (activeStreams.get(sessionId)?.size ?? 0) > 0
}

/** 仅测试用：清空全部登记 */
export function clearAllSessionActiveStreamsForTest(): void {
  activeStreams.clear()
}
