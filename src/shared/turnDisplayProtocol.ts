import type { Message, ToolCallRecord, ToolRiskLevel } from './domainTypes'
import { buildAssistantActivityTimeline } from './assistantActivityTimeline'
import { contentSegmentsForRender } from './contentSegments'

export const MAX_FIXED_BYTES = 2048
export const MAX_TOOL_SUMMARY_BYTES = 4096
export const MAX_TOOL_CALLS_PER_TURN = 50
export const MAX_BOUNDED_DISPLAY_META_BYTES = MAX_FIXED_BYTES + MAX_TOOL_CALLS_PER_TURN * MAX_TOOL_SUMMARY_BYTES
export const MAX_PREVIEW_BYTES = 4096

export type ToolCallDisplaySummary = {
  inputPreview?: string
  inputPreviewTruncated: boolean
  progressPreview?: string
  progressPreviewTruncated: boolean
  resultPreview?: string
  resultPreviewTruncated: boolean
  hasDetails: boolean
  confirmRisk: ToolRiskLevel
  /** 审批 Agent 裁决中的工具不属于人工待确认。 */
  autoAnswerer?: true
}

export type ActivityDisplayItem =
  | { kind: 'text'; contentStart: number; contentEnd: number; segmentIndex: number }
  | { kind: 'thinking'; segmentIndex: number }
  | { kind: 'tool'; toolId: string }
  | { kind: 'skill'; hintId: string }

export type TurnDisplay = {
  turnId: string
  sessionId: string
  requestId: string
  version: number
  lifecycle: 'running' | 'awaiting-confirmation' | 'completed' | 'failed'
  outcome?: 'completed' | 'failed' | 'cancelled' | 'timed-out'
  message: Pick<Message, 'id' | 'content' | 'thinking' | 'skillHints'> & {
    contentSegments: Array<{ segmentIndex: number; start: number; end: number }>
    toolCalls: Array<Pick<ToolCallRecord, 'id' | 'toolName' | 'status' | 'startedAt' | 'completedAt' | 'duration'> & { display: ToolCallDisplaySummary }>
    activity: ActivityDisplayItem[]
  }
}

export type ConfirmationDisplay = {
  toolCallId: string
  input: Record<string, unknown>
  memoryTiers: Array<{ optionId: number; label: string }>
  riskLevel: ToolRiskLevel
  effect: 'read' | 'write' | 'execute' | 'navigate' | 'connect' | 'unknown'
  shellSecurityHints?: ToolCallRecord['shellSecurityHints']
  browser: { currentPageUrl?: string; dangerInfo?: ToolCallRecord['dangerInfo']; sessionTrustedHint?: true }
  mcp?: { serverId: string; serverName: string; originalToolName: string; mappedToolName: string; description?: string }
  autoApproveFallback?: ToolCallRecord['autoApproveFallback']
  diff: string
  complete: true
}

export type ConfirmationSnapshot = { sessionId: string; turnId: string; requestId: string; turnVersion: number; toolCallId: string; confirmation: ConfirmationDisplay }

export type TurnDisplayBytes = { payloadBytes: number; activityIndexBytes: number }

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength
const SUMMARY_CACHE_LIMIT = 256
const summaryCache = new Map<string, { status: string; resultSignature: string; summary: ToolCallDisplaySummary; bytes: number }>()
let summaryCacheBytes = 0
const SUMMARY_CACHE_BYTES = 512 * 1024

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (maxBytes <= 0) return { value: '', truncated: value.length > 0 }
  let bytes = 0
  let end = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + characterBytes > maxBytes) return { value: value.slice(0, end), truncated: true }
    bytes += characterBytes
    end += character.length
  }
  return { value, truncated: false }
}

function preview(value: unknown): { value?: string; truncated: boolean } {
  if (value == null) return { truncated: false }
  let raw: string
  try { raw = typeof value === 'string' ? value : JSON.stringify(value) } catch { raw = '[unserializable]' }
  const result = truncateUtf8(raw, MAX_PREVIEW_BYTES)
  return { value: result.value, truncated: result.truncated }
}

const inputPreviewCache = new Map<string, { input: unknown; preview: { value?: string; truncated: boolean } }>()

function toolDisplay(tool: ToolCallRecord, identity: string): ToolCallDisplaySummary {
  const cacheKey = `${identity}:${tool.id}`
  const cached = summaryCache.get(cacheKey)
  const resultValue = tool.result?.data ?? tool.result?.error
  const resultSignature = tool.result ? `${tool.result.success}:${typeof resultValue === 'string' ? resultValue.length : resultValue && typeof resultValue === 'object' ? Object.keys(resultValue).length : String(resultValue ?? '')}` : ''
  if (cached && cached.status === tool.status && tool.status === 'completed' && cached.resultSignature === resultSignature) return cached.summary
  const cachedInput = inputPreviewCache.get(cacheKey)
  const input = cachedInput?.input === tool.input ? cachedInput.preview : preview(tool.input)
  if (!cachedInput || cachedInput.input !== tool.input) {
    inputPreviewCache.delete(cacheKey)
    inputPreviewCache.set(cacheKey, { input: tool.input, preview: input })
    while (inputPreviewCache.size > SUMMARY_CACHE_LIMIT) inputPreviewCache.delete(inputPreviewCache.keys().next().value as string)
  }
  const progress = preview(tool.progressOutput)
  const result = preview(tool.result?.data ?? tool.result?.error)
  const summary = {
    ...(input.value !== undefined ? { inputPreview: input.value } : {}), inputPreviewTruncated: input.truncated,
    ...(progress.value !== undefined ? { progressPreview: progress.value } : {}), progressPreviewTruncated: progress.truncated,
    ...(result.value !== undefined ? { resultPreview: result.value } : {}), resultPreviewTruncated: result.truncated,
    hasDetails: tool.input !== undefined || tool.result !== undefined || Boolean(tool.progressOutput),
    confirmRisk: tool.riskLevel,
    ...(tool.autoAnswerer ? { autoAnswerer: true as const } : {})
  }
  if (tool.status === 'completed') {
    summaryCache.delete(cacheKey)
    const bytes = utf8Length(JSON.stringify(summary))
    const old = summaryCache.get(cacheKey)
    if (old) summaryCacheBytes -= old.bytes
    summaryCache.delete(cacheKey)
    summaryCache.set(cacheKey, { status: tool.status, resultSignature, summary, bytes })
    summaryCacheBytes += bytes
    while (summaryCache.size > SUMMARY_CACHE_LIMIT || summaryCacheBytes > SUMMARY_CACHE_BYTES) {
      const oldest = summaryCache.keys().next().value as string
      const removed = summaryCache.get(oldest)
      if (removed) summaryCacheBytes -= removed.bytes
      summaryCache.delete(oldest)
    }
  }
  return summary
}

function effectForTool(toolName: string): ConfirmationDisplay['effect'] {
  if (toolName.includes('browser') || toolName.includes('navigate')) return 'navigate'
  if (toolName.includes('mcp') || toolName.includes('connect')) return 'connect'
  if (toolName.includes('write') || toolName.includes('edit') || toolName.includes('delete')) return 'write'
  if (toolName.includes('shell') || toolName.includes('script') || toolName.includes('run')) return 'execute'
  return 'read'
}

export function toConfirmationSnapshot(input: { sessionId: string; turnId: string; requestId: string; turnVersion: number; tool: ToolCallRecord }): ConfirmationSnapshot {
  const tool = input.tool
  return {
    sessionId: input.sessionId, turnId: input.turnId, requestId: input.requestId, turnVersion: input.turnVersion, toolCallId: tool.id,
    confirmation: {
      toolCallId: tool.id, input: tool.input, riskLevel: tool.riskLevel, effect: effectForTool(tool.toolName),
      memoryTiers: (tool.memoryTiers ?? []).map((tier, index) => ({ optionId: index + 1, label: tier.label })),
      ...(tool.shellSecurityHints ? { shellSecurityHints: tool.shellSecurityHints } : {}),
      browser: { ...(tool.currentPageUrl ? { currentPageUrl: tool.currentPageUrl } : {}), ...(tool.dangerInfo ? { dangerInfo: tool.dangerInfo } : {}), ...(tool.sessionTrustedHint ? { sessionTrustedHint: true as const } : {}) },
      ...(tool.mcp ? { mcp: { ...tool.mcp, mappedToolName: tool.toolName } } : {}),
      ...(tool.autoApproveFallback ? { autoApproveFallback: tool.autoApproveFallback } : {}),
      diff: tool.confirmDiff ? JSON.stringify(tool.confirmDiff) : '', complete: true
    }
  }
}

export function measureTurnDisplayBytes(display: TurnDisplay): TurnDisplayBytes {
  const payloadBytes = utf8Length(JSON.stringify(display))
  const activityIndexBytes = utf8Length(JSON.stringify(display.message.activity))
  return { payloadBytes, activityIndexBytes }
}

export function turnDisplayToMessage(display: TurnDisplay): Message {
  return {
    id: display.message.id, sessionId: display.sessionId, role: 'assistant', content: display.message.content,
    timestamp: Date.now(), status: display.lifecycle === 'completed' ? 'completed' : display.lifecycle === 'failed' ? 'failed' : 'streaming', schemaVersion: 1,
    ...(display.message.thinking ? { thinking: display.message.thinking } : {}), ...(display.message.skillHints ? { skillHints: display.message.skillHints } : {}),
    toolCalls: display.message.toolCalls.map((tool) => ({ id: tool.id, toolName: tool.toolName, input: {}, status: tool.status, riskLevel: tool.display.confirmRisk, ...(tool.display.autoAnswerer ? { autoAnswerer: true as const } : {}), ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}), ...(tool.completedAt !== undefined ? { completedAt: tool.completedAt } : {}), ...(tool.duration !== undefined ? { duration: tool.duration } : {}) }))
  }
}

export function toTurnDisplay(input: { turnId: string; requestId: string; version: number; lifecycle: TurnDisplay['lifecycle']; outcome?: TurnDisplay['outcome']; message: Message }): TurnDisplay {
  const { message } = input
  const segments = contentSegmentsForRender(message)
  let contentOffset = 0
  const contentRanges = segments.map((segment) => {
    const range = { start: contentOffset, end: contentOffset + segment.content.length }
    contentOffset = range.end
    return range
  })
  const activity = buildAssistantActivityTimeline(message).map((item): ActivityDisplayItem => {
    if (item.kind !== 'text') return item
    const range = contentRanges[item.segmentIndex]
    return { ...item, contentStart: range?.start ?? 0, contentEnd: range?.end ?? 0 }
  })
  return {
    turnId: input.turnId, sessionId: message.sessionId, requestId: input.requestId, version: input.version, lifecycle: input.lifecycle, ...(input.outcome ? { outcome: input.outcome } : {}),
    message: {
      id: message.id, content: message.content, ...(message.thinking ? { thinking: message.thinking } : {}), ...(message.skillHints ? { skillHints: message.skillHints } : {}),
      contentSegments: contentRanges.map((range, segmentIndex) => ({ segmentIndex, ...range })),
      toolCalls: (message.toolCalls ?? []).map((tool) => ({ id: tool.id, toolName: tool.toolName, status: tool.status, ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}), ...(tool.completedAt !== undefined ? { completedAt: tool.completedAt } : {}), ...(tool.duration !== undefined ? { duration: tool.duration } : {}), display: toolDisplay(tool, `${message.sessionId}:${input.turnId}`) })),
      activity
    }
  }
}

export function lifecycleForMessage(message: Message): TurnDisplay['lifecycle'] {
  if (message.status === 'completed') return 'completed'
  if (message.status === 'failed') return 'failed'
  if (message.toolCalls?.some((tool) => tool.status === 'confirming')) return 'awaiting-confirmation'
  return 'running'
}

export function turnToDisplay(turn: { turnId: string; requestId: string; version: number; assistantMessage: Message; outcome?: TurnDisplay['outcome'] }): TurnDisplay {
  return toTurnDisplay({ ...turn, lifecycle: lifecycleForMessage(turn.assistantMessage), message: turn.assistantMessage })
}
