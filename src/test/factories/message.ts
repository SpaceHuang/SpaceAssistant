import type { Message, ThinkingData, ToolCallRecord } from '../../shared/domainTypes'

const base = { sessionId: 'session-1', timestamp: 1, schemaVersion: 1 } as const

export function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>, defaults: Partial<Message> = {}): Message {
  return { ...base, content: '', status: 'completed', ...defaults, ...overrides }
}

export function userMessage(overrides: Partial<Message> | string = {}, status: Message['status'] = 'sent', sessionId = 's1'): Message {
  const supplied = typeof overrides === 'string'
    ? { id: overrides, sessionId, content: `msg-${overrides}`, status, timestamp: Number(overrides.replace(/\D/g, '') || 0) }
    : overrides
  return message({ id: 'user-1', role: 'user', status: 'sent', ...supplied })
}

export function assistantMessage(overrides: Partial<Message> = {}): Message {
  return message({
    id: 'a1', role: 'assistant', content: 'Hello world', timestamp: 1_000_000, status: 'streaming',
    contentSegments: [{ content: 'Hello world', startTime: 1_000_000 }], ...overrides
  })
}

export function toolUse(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tool-1', toolName: 'read_file', input: {}, status: 'completed', riskLevel: 'low', ...overrides
  }
}

export function thinking(overrides: Partial<ThinkingData> = {}): ThinkingData {
  return { content: 'thinking', isVisible: true, startTime: 1, ...overrides }
}
