import type { ContentSegment, ChatImageAttachment, Message, SkillHintRecord, ThinkingData, ToolCallRecord, ToolUseData } from '../src/shared/domainTypes'
import { logAgentEvent } from './agentLogger/agentLogger'
import { createCorruptedToolCallPlaceholder } from './database/streamingCleanup'

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

export function serializeContentSegmentsForDb(segments: ContentSegment[] | undefined): string | null {
  if (!segments?.length) return null
  return JSON.stringify(segments)
}

export function deserializeContentSegmentsFromDb(raw: string | null | undefined): ContentSegment[] | undefined {
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw) as ContentSegment[]
    return Array.isArray(arr) ? arr : undefined
  } catch {
    return undefined
  }
}

export function serializeToolCallsForDb(calls: ToolCallRecord[] | undefined): string | null {
  if (!calls || calls.length === 0) return null
  return JSON.stringify(
    calls.map((c) => ({
      ...c,
      input: JSON.stringify(c.input),
      result: c.result
        ? {
            ...c.result,
            data: c.result.data !== undefined ? JSON.stringify(c.result.data) : undefined
          }
        : undefined
    }))
  )
}

export function deserializeToolCallsFromDb(raw: string | null | undefined): ToolCallRecord[] | undefined {
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw) as Array<
      ToolCallRecord & { input: string; result?: { success: boolean; data?: string; error?: string } }
    >
    if (!Array.isArray(arr)) return undefined
    return arr.map((c) => ({
      id: c.id,
      toolName: c.toolName,
      input: typeof c.input === 'string' ? JSON.parse(c.input || '{}') : (c.input as Record<string, unknown>),
      result: c.result
        ? {
            success: c.result.success,
            error: c.result.error,
            data: c.result.data !== undefined ? JSON.parse(c.result.data) : undefined
          }
        : undefined,
      status: c.status,
      riskLevel: c.riskLevel,
      confirmDiff: c.confirmDiff,
      confirmedAt: c.confirmedAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      duration: c.duration,
      corrupted: c.corrupted,
      interrupted: c.interrupted
    }))
  } catch (e) {
    logAgentEvent('warn', 'db.tool_calls.deserialize_failed', { error: String(e) })
    return [createCorruptedToolCallPlaceholder()]
  }
}

export function serializeSkillHintsForDb(hints: SkillHintRecord[] | undefined): string | null {
  if (!hints?.length) return null
  return JSON.stringify(hints)
}

export function deserializeSkillHintsFromDb(raw: string | null | undefined): SkillHintRecord[] | undefined {
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw) as SkillHintRecord[]
    if (!Array.isArray(arr)) return undefined
    return arr
      .filter((h) => h && typeof h.id === 'string' && typeof h.text === 'string' && typeof h.shownAt === 'number')
      .map((h) => ({ id: h.id, text: h.text, shownAt: h.shownAt }))
  } catch {
    return undefined
  }
}

export function serializeAttachmentsForDb(attachments: ChatImageAttachment[] | undefined): string | null {
  if (!attachments?.length) return null
  return JSON.stringify(attachments)
}

export function deserializeAttachmentsFromDb(raw: string | null | undefined): ChatImageAttachment[] | undefined {
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw) as ChatImageAttachment[]
    return Array.isArray(arr) ? arr : undefined
  } catch {
    return undefined
  }
}

export function rowToMessage(row: {
  id: string
  sessionId: string
  role: string
  content: string
  toolUse: string | null
  toolCalls?: string | null
  thinking: string | null
  contentSegments?: string | null
  skillHints?: string | null
  attachments?: string | null
  imagesDeliveredToApi?: boolean | null
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
    toolCalls: deserializeToolCallsFromDb(row.toolCalls),
    thinking: deserializeThinkingFromDb(row.thinking),
    contentSegments: deserializeContentSegmentsFromDb(row.contentSegments),
    skillHints: deserializeSkillHintsFromDb(row.skillHints),
    attachments: deserializeAttachmentsFromDb(row.attachments),
    imagesDeliveredToApi: row.imagesDeliveredToApi ?? undefined,
    status: row.status as Message['status'],
    schemaVersion: row.schemaVersion
  }
}
