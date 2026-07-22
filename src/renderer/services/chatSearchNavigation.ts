import type { ChatSearchMatch } from '../../shared/chatSearchFragments'

/**
 * 在局部 DOM marks 中定位与结构化 match 对应的 mark。
 * marks 与全局 matchIndex 不在同一索引空间，必须按 messageId（及同消息内次序）匹配。
 */
export function findDomMarkForStructuredMatch(
  marks: HTMLElement[],
  matches: ChatSearchMatch[],
  matchIndex: number
): HTMLElement | undefined {
  const target = matches[matchIndex]
  if (!target || marks.length === 0) return undefined

  const sameMessageStructured = matches
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.messageId === target.messageId)
  const localStructuredIdx = sameMessageStructured.findIndex(({ index }) => index === matchIndex)
  if (localStructuredIdx < 0) return undefined

  const sameMessageMarks = marks.filter((mark) => {
    const bubble = mark.closest('[data-message-id]')
    return bubble?.getAttribute('data-message-id') === target.messageId
  })
  return sameMessageMarks[localStructuredIdx]
}

/** 只要结构化 match 存在就应触发定位（不依赖 DOM mark 是否已就绪）。 */
export function resolveNavigationTarget(
  matches: ChatSearchMatch[],
  matchIndex: number
): ChatSearchMatch | null {
  if (matchIndex < 0 || matchIndex >= matches.length) return null
  return matches[matchIndex] ?? null
}
