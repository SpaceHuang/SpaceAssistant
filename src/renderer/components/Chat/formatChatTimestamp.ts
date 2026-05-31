/** 聊天消息时间：当天仅显示时分，跨天显示月日+时分 */
export function formatChatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  return date.toLocaleString(undefined, opts)
}
