import type { ContentSegment, Message, ToolCallRecord } from './domainTypes'
import { contentSegmentsForRender } from './contentSegments'
import { thinkingSegmentsForRender } from './thinkingSegments'
import type { RemoteProgressSnapshot } from './remoteProgressTypes'

export type RemoteProgressT = (key: string, options?: Record<string, unknown>) => string

const ACTIVE_TOOL_STATUSES = new Set<ToolCallRecord['status']>(['calling', 'executing'])
const IN_PROGRESS_TOOL_STATUSES = new Set<ToolCallRecord['status']>(['calling', 'confirming', 'executing'])

export function firstProgressLine(text: string | undefined, maxLen = 72): string | undefined {
  const line = text?.trim().split(/\r?\n/).find((l) => l.trim())
  if (!line) return undefined
  const trimmed = line.trim()
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed
}

function findActiveTool(tools: ToolCallRecord[]): ToolCallRecord | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tc = tools[i]!
    if (IN_PROGRESS_TOOL_STATUSES.has(tc.status)) return tc
  }
  return undefined
}

function hasActiveThinking(message: Message): boolean {
  if (!message.thinking) return false
  const segs = thinkingSegmentsForRender(message.thinking)
  return segs.some((seg) => seg.endTime === undefined)
}

function hasOpenContentSegment(message: Message): boolean {
  const segs = contentSegmentsForRender(message)
  const last = segs[segs.length - 1]
  return Boolean(last && last.endTime === undefined)
}

function latestClosedTextSegment(message: Message): ContentSegment | undefined {
  const segs = contentSegmentsForRender(message)
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]!
    if (seg.endTime !== undefined && seg.content.trim()) return seg
  }
  return undefined
}

function textSnapshotFromSegment(
  segment: ContentSegment,
  maxLineLen = 72
): Pick<RemoteProgressSnapshot, 'label' | 'detail'> {
  const lines = segment.content.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const first = lines[0] ?? ''
  const label =
    first.length > maxLineLen ? `${first.slice(0, maxLineLen - 1)}…` : first
  const secondLine = lines.slice(1).find((l) => l.trim())
  const detail = secondLine ? firstProgressLine(secondLine, maxLineLen) : undefined
  return { label, detail }
}

export function resolveRemoteProgressSnapshot(args: {
  message: Message
  formatToolLabel: (toolName: string, input: Record<string, unknown>) => string
  t: RemoteProgressT
}): RemoteProgressSnapshot {
  const { message, formatToolLabel, t } = args
  const idle: RemoteProgressSnapshot = { kind: 'idle', label: '', publishable: false }

  if (message.status !== 'streaming') return idle

  const activeTool = findActiveTool(message.toolCalls ?? [])

  if (activeTool?.status === 'confirming') {
    const action = formatToolLabel(activeTool.toolName, activeTool.input)
    return {
      kind: 'confirm',
      label: t('streaming.awaitingConfirm', { action }),
      publishable: true
    }
  }

  if (activeTool && ACTIVE_TOOL_STATUSES.has(activeTool.status)) {
    const label = formatToolLabel(activeTool.toolName, activeTool.input)
    const detail =
      firstProgressLine(activeTool.progressOutput) ??
      (activeTool.status === 'calling' ? t('streaming.preparing') : undefined)
    return { kind: 'tool', label, detail, publishable: true }
  }

  if (hasActiveThinking(message)) {
    return { kind: 'idle', label: t('streaming.thinking'), publishable: false }
  }

  if (hasOpenContentSegment(message)) {
    return { kind: 'idle', label: t('streaming.inProgress'), publishable: false }
  }

  const closedText = latestClosedTextSegment(message)
  if (closedText) {
    const { label, detail } = textSnapshotFromSegment(closedText)
    if (label) return { kind: 'text', label, detail, publishable: true }
  }

  return idle
}

export function shouldUpdateLastPublishable(snapshot: RemoteProgressSnapshot): boolean {
  return snapshot.publishable
}
