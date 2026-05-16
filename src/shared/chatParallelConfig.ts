/** 多会话并行执行默认上限（与 docs/develop/multi-session-parallel-execution.md 一致） */
export const DEFAULT_MAX_PARALLEL_CHAT_SESSIONS = 3
export const MIN_MAX_PARALLEL_CHAT_SESSIONS = 1
export const MAX_MAX_PARALLEL_CHAT_SESSIONS = 10

export function clampMaxParallelChatSessions(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_MAX_PARALLEL_CHAT_SESSIONS
  return Math.min(MAX_MAX_PARALLEL_CHAT_SESSIONS, Math.max(MIN_MAX_PARALLEL_CHAT_SESSIONS, Math.round(n)))
}
