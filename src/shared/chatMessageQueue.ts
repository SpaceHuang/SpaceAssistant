import type { Message } from './domainTypes'

export const MAX_CHAT_MESSAGE_QUEUE_SIZE = 10

export function isQueuedUserMessage(message: Message): boolean {
  return message.role === 'user' && message.status === 'queued'
}

/** 单条消息是否具备进入 LLM 请求历史的资格（与 filter 同源）。 */
export function isMessageEligibleForChatApi(message: Message): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false
  if (message.status === 'streaming' || message.status === 'queued') return false
  return true
}

/** 参与 LLM 上下文的历史消息（排除流式中与排队中） */
export function filterMessagesForChatApi(messages: Message[]): Message[] {
  return messages.filter(isMessageEligibleForChatApi)
}

export function listQueuedUserMessages(messages: Message[], sessionId: string): Message[] {
  return messages
    .filter((m) => m.sessionId === sessionId && isQueuedUserMessage(m))
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function countQueuedUserMessages(messages: Message[], sessionId: string): number {
  return listQueuedUserMessages(messages, sessionId).length
}

export function getNextQueuedUserMessage(messages: Message[], sessionId: string): Message | undefined {
  return listQueuedUserMessages(messages, sessionId)[0]
}
