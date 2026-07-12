/** UUID v4，与 sessions.id 一致 */
export const SESSION_SUFFIX_REGEX =
  / 会话\$[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\$$/

export const REMOTE_PROCESSING_PLACEHOLDERS = [
  '已收到，正在处理…',
  '仍在处理…',
  '仍在处理中，请稍候…'
] as const

export function isRemoteProcessingPlaceholder(text: string): boolean {
  return REMOTE_PROCESSING_PLACEHOLDERS.includes(text.trim() as (typeof REMOTE_PROCESSING_PLACEHOLDERS)[number])
}

export function stripSessionSuffix(text: string): string {
  return text.replace(SESSION_SUFFIX_REGEX, '').trimEnd()
}

export function formatRemoteOutboundMessage(
  body: string,
  sessionId: string,
  opts?: { forceSuffix?: boolean }
): string {
  const trimmed = body.trim()
  if (!opts?.forceSuffix && isRemoteProcessingPlaceholder(trimmed)) {
    return trimmed
  }
  const stripped = stripSessionSuffix(trimmed)
  return `${stripped} 会话$${sessionId}$`
}

/** 进度 dedupe 用：剥后缀后的正文 */
export function progressReplyDedupeKey(text: string): string {
  return stripSessionSuffix(text).trim()
}

export function sessionSuffixLength(sessionId: string): number {
  return formatRemoteOutboundMessage('', sessionId).length
}
