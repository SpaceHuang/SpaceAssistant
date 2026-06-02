/** 侧栏会话列表展示用名称（空标题兜底） */
export function sessionDisplayName(name: string | undefined | null): string {
  const trimmed = name?.trim()
  return trimmed || '未命名会话'
}

/** 确认框等短文案中的长标题截断 */
export function truncateSessionTitle(name: string, maxLen = 48): string {
  if (name.length <= maxLen) return name
  return `${name.slice(0, maxLen)}…`
}

export function sessionListEmptyDescription(
  totalCount: number,
  hasSearchQuery: boolean
): string {
  if (totalCount === 0) return '暂无会话，点击「新会话」开始'
  if (hasSearchQuery) return '没有匹配的会话'
  return '暂无会话'
}
