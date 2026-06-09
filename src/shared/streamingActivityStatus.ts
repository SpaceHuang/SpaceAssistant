import type { Message, ToolCallRecord } from './domainTypes'
import { thinkingSegmentsForRender } from './thinkingSegments'

const IN_PROGRESS_TOOL_STATUSES = new Set<ToolCallRecord['status']>(['calling', 'confirming', 'executing'])

export type StreamingActivityStatus = {
  /** Short label for status pill / composer strip */
  label: string
  /** Optional progress line (e.g. shell tail) */
  detail?: string
  /** Whether to show elapsed timer */
  showElapsed: boolean
}

export type StreamingActivityT = (key: string, options?: Record<string, unknown>) => string

export function formatStreamingElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

function firstProgressLine(text: string | undefined): string | undefined {
  const line = text?.trim().split(/\r?\n/).find((l) => l.trim())
  if (!line) return undefined
  const trimmed = line.trim()
  return trimmed.length > 72 ? `${trimmed.slice(0, 71)}…` : trimmed
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

export function resolveStreamingActivityStatus(args: {
  message: Message
  formatToolLabel: (toolName: string, input: Record<string, unknown>) => string
  t: StreamingActivityT
  now?: number
}): StreamingActivityStatus | null {
  const { message, formatToolLabel, t, now = Date.now() } = args
  if (message.status !== 'streaming') return null

  const activeTool = findActiveTool(message.toolCalls ?? [])
  const elapsedMs = now - message.timestamp

  if (activeTool?.status === 'confirming') {
    return {
      label: t('streaming.awaitingConfirm', { action: formatToolLabel(activeTool.toolName, activeTool.input) }),
      showElapsed: true
    }
  }

  if (activeTool?.status === 'executing' || activeTool?.status === 'calling') {
    const label = formatToolLabel(activeTool.toolName, activeTool.input)
    const detail =
      firstProgressLine(activeTool.progressOutput) ??
      (activeTool.status === 'calling' ? t('streaming.preparing') : undefined)
    return { label, detail, showElapsed: true }
  }

  if (hasActiveThinking(message)) {
    return { label: t('streaming.thinking'), showElapsed: true }
  }

  void elapsedMs
  return { label: t('streaming.inProgress'), showElapsed: true }
}
