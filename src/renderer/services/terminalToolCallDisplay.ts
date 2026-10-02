import type { Message } from '../../shared/domainTypes'

/** 已终态消息中的 confirming 工具已不可能再等待本轮审批，列表展示时收敛为失败。 */
export function settleTerminalToolCallsForDisplay(message: Message): Message {
  if (message.status === 'streaming' || !message.toolCalls?.some((tool) => tool.status === 'confirming')) return message
  return {
    ...message,
    toolCalls: message.toolCalls.map((tool) => tool.status === 'confirming' ? { ...tool, status: 'failed' as const } : tool)
  }
}
