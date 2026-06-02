import { useRef } from 'react'

/**
 * 仅对当前会话中新追加的最后一条消息播放入场动效；切换会话或一次加载整页历史时不弹跳。
 */
export function useChatMessageEnter(sessionId: string | null, messageIds: readonly string[]): string | null {
  const prevSessionRef = useRef<string | null>(null)
  const prevCountRef = useRef(0)

  if (prevSessionRef.current !== sessionId) {
    prevSessionRef.current = sessionId
    prevCountRef.current = messageIds.length
    return null
  }

  const count = messageIds.length
  let enterId: string | null = null
  if (count > prevCountRef.current && count > 0) {
    enterId = messageIds[count - 1] ?? null
  }
  prevCountRef.current = count
  return enterId
}
