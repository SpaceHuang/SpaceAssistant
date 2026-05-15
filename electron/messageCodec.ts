import type { Message, ThinkingData, ToolUseData } from '../src/shared/domainTypes'

/** SQLite / JSON 列用的序列化（复杂字段 JSON.stringify） */
export function serializeToolUseForDb(tool: ToolUseData | undefined): string | null {
  if (!tool) return null
  return JSON.stringify({
    ...tool,
    parameters: JSON.stringify(tool.parameters),
    result: tool.result
      ? {
          ...tool.result,
          data: JSON.stringify(tool.result.data),
          metadata: tool.result.metadata ? JSON.stringify(tool.result.metadata) : undefined
        }
      : undefined,
    metadata: tool.metadata ? JSON.stringify(tool.metadata) : undefined
  })
}

export function deserializeToolUseFromDb(raw: string | null): ToolUseData | undefined {
  if (!raw) return undefined
  const o = JSON.parse(raw) as {
    id: string
    toolName: string
    toolType: string
    parameters: string
    result?: {
      data: string
      success: boolean
      error?: string
      metadata?: string
    }
    status: ToolUseData['status']
    timestamp: number
    duration?: number
    metadata?: string
  }
  return {
    id: o.id,
    toolName: o.toolName,
    toolType: o.toolType,
    parameters: JSON.parse(o.parameters || '{}'),
    result: o.result
      ? {
          data: JSON.parse(o.result.data || 'null'),
          success: o.result.success,
          error: o.result.error,
          metadata: o.result.metadata ? JSON.parse(o.result.metadata) : undefined
        }
      : undefined,
    status: o.status,
    timestamp: o.timestamp,
    duration: o.duration,
    metadata: o.metadata ? JSON.parse(o.metadata) : undefined
  }
}

export function serializeThinkingForDb(t: ThinkingData | undefined): string | null {
  if (!t) return null
  return JSON.stringify({
    ...t,
    metadata: t.metadata ? JSON.stringify(t.metadata) : undefined
  })
}

export function deserializeThinkingFromDb(raw: string | null): ThinkingData | undefined {
  if (!raw) return undefined
  const o = JSON.parse(raw) as ThinkingData & { metadata?: string }
  return {
    ...o,
    metadata: o.metadata && typeof o.metadata === 'string' ? JSON.parse(o.metadata) : o.metadata
  }
}

export function rowToMessage(row: {
  id: string
  sessionId: string
  role: string
  content: string
  toolUse: string | null
  thinking: string | null
  status: string
  schemaVersion: number
  timestamp: number
  sequence: number
}): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as Message['role'],
    content: row.content,
    timestamp: row.timestamp,
    toolUse: deserializeToolUseFromDb(row.toolUse),
    thinking: deserializeThinkingFromDb(row.thinking),
    status: row.status as Message['status'],
    schemaVersion: row.schemaVersion
  }
}
