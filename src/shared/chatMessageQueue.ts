import type { Message } from './domainTypes'

export const MAX_CHAT_MESSAGE_QUEUE_SIZE = 10

export function isQueuedUserMessage(message: Message): boolean {
  return message.role === 'user' && message.status === 'queued'
}

/** 参与 LLM 上下文的历史消息（排除流式中与排队中） */
export function filterMessagesForChatApi(messages: Message[]): Message[] {
  return messages.filter((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return false
    if (m.status === 'streaming' || m.status === 'queued') return false
    return true
  })
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
