/**
 * sessionId → 活跃流反向登记（需求 §9.4）。
 * 现状 chatCancelRegistry 仅按 requestId 登记；本模块补 Map<sessionId, Set<requestId>>，
 * 供 action.session.status / action.session.list 判定「会话是否正在运行」。
 *
 * 写点约定（与 toolChatLoop 的注册/清理对称）：
 * - runToolChatSession 入口（registerChatCancel 之后）调用 registerSessionActiveStream
 * - finally 清理调用 clearSessionActiveStream，按 requestId 粒度删除——重入时旧请求清理不丢新登记
 */
const activeStreams = new Map<string, Map<string, string>>()

export function registerSessionActiveStream(sessionId: string, requestId: string, turnId = requestId): void {
  if (!sessionId || !requestId) return
  let streams = activeStreams.get(sessionId)
  if (!streams) {
    streams = new Map()
    activeStreams.set(sessionId, streams)
  }
  streams.set(requestId, turnId)
}

export function clearSessionActiveStream(sessionId: string, requestId: string): void {
  const streams = activeStreams.get(sessionId)
  if (!streams) return
  streams.delete(requestId)
  if (streams.size === 0) activeStreams.delete(sessionId)
}

export function isSessionActiveStream(sessionId: string): boolean {
  return (activeStreams.get(sessionId)?.size ?? 0) > 0
}

/** 返回最近登记且仍活跃的流对应 turn；无活跃流时返回 undefined。 */
export function getSessionActiveStreamTurnId(sessionId: string): string | undefined {
  const streams = activeStreams.get(sessionId)
  if (!streams?.size) return undefined
  return [...streams.values()].at(-1)
}

/** 仅测试用：清空全部登记 */
export function clearAllSessionActiveStreamsForTest(): void {
  activeStreams.clear()
}
