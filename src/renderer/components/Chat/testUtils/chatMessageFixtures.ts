import type { Message } from '../../../../shared/domainTypes'

export function completedAssistantMessage(over: Partial<Message> = {}): Message {
  const now = Date.now()
  return {
    id: 'hist-1',
    sessionId: 's1',
    role: 'assistant',
    content: 'Completed history reply',
    timestamp: now - 10_000,
    status: 'completed',
    schemaVersion: 1,
    contentSegments: [{ content: 'Completed history reply', startTime: now - 10_000, endTime: now - 9_000 }],
    ...over
  }
}

export function streamingAssistantMessage(over: Partial<Message> = {}): Message {
  const now = Date.now()
  return {
    id: 'stream-1',
    sessionId: 's1',
    role: 'assistant',
    content: 'Streaming…',
    timestamp: now,
    status: 'streaming',
    schemaVersion: 1,
    contentSegments: [{ content: 'Streaming…', startTime: now }],
    ...over
  }
}

export function userMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'user-1',
    sessionId: 's1',
    role: 'user',
    content: 'Hello',
    timestamp: Date.now() - 20_000,
    status: 'sent',
    schemaVersion: 1,
    ...over
  }
}

export function patchStreamingContent(message: Message, content: string): Message {
  return {
    ...message,
    content,
    contentSegments: [{ content, startTime: message.timestamp }]
  }
}
