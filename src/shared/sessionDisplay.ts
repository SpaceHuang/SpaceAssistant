/** 会话标题最大 Unicode 字符数（手动重命名与 LLM 自动总结共用） */
export const SESSION_TITLE_MAX_LENGTH = 64

/** 用户可见的会话标题；空名或与 sessionId 相同时返回空字符串，由 UI 做 i18n 兜底 */
export function sessionDisplayNameRaw(name: string | undefined | null, sessionId?: string): string {
  const trimmed = name?.trim()
  if (!trimmed) return ''
  if (sessionId && trimmed === sessionId) return ''
  return trimmed
}
