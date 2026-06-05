import type { AssistantActivityItem } from './assistantActivityTimeline'
import type { ContentSegment, SkillHintRecord, ThinkingData, ToolCallRecord } from './domainTypes'
import { contentSegmentsForRender } from './contentSegments'
import { thinkingSegmentsForRender } from './thinkingSegments'

export const ACTIVITY_BATCH_IDLE_GAP_MS = 180_000
export const ACTIVITY_BATCH_AUTO_COLLAPSE_DELAY_MS = 5_000

export type ActivityTrackSegment =
  | { kind: 'batch'; items: AssistantActivityItem[] }
  | { kind: 'standalone'; item: AssistantActivityItem }

function isBatchItem(item: AssistantActivityItem): boolean {
  return item.kind === 'thinking' || item.kind === 'tool'
}

function flushBatch(batch: AssistantActivityItem[], out: ActivityTrackSegment[]) {
  if (batch.length > 0) {
    out.push({ kind: 'batch', items: [...batch] })
    batch.length = 0
  }
}

/** 将 activity timeline 切分为批次（thinking+tool）与独立条目（text/skill） */
export function groupActivityTimeline(
  timeline: AssistantActivityItem[],
  getTimestamp: (item: AssistantActivityItem) => number,
  options?: { idleGapMs?: number }
): ActivityTrackSegment[] {
  const idleGapMs = options?.idleGapMs ?? ACTIVITY_BATCH_IDLE_GAP_MS
  const segments: ActivityTrackSegment[] = []
  const currentBatch: AssistantActivityItem[] = []
  let lastBatchTimestamp: number | null = null

  for (const item of timeline) {
    if (!isBatchItem(item)) {
      flushBatch(currentBatch, segments)
      lastBatchTimestamp = null
      segments.push({ kind: 'standalone', item })
      continue
    }

    const ts = getTimestamp(item)
    if (currentBatch.length > 0 && lastBatchTimestamp != null && ts - lastBatchTimestamp >= idleGapMs) {
      flushBatch(currentBatch, segments)
    }

    currentBatch.push(item)
    lastBatchTimestamp = ts
  }

  flushBatch(currentBatch, segments)
  return segments
}

export function buildActivityItemTimestampResolver(message: {
  timestamp: number
  content: string
  contentSegments?: ContentSegment[]
  thinking?: ThinkingData
  toolCalls?: ToolCallRecord[]
  skillHints?: SkillHintRecord[]
}): (item: AssistantActivityItem) => number {
  const thinkingSegs = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
  const textSegs = contentSegmentsForRender(message)
  const tools = message.toolCalls ?? []
  const skills = message.skillHints ?? []
  const toolIndexById = new Map(tools.map((tc, i) => [tc.id, i]))

  return (item) => {
    if (item.kind === 'thinking') {
      const seg = thinkingSegs[item.segmentIndex]
      return seg?.startTime ?? message.timestamp
    }
    if (item.kind === 'text') {
      const seg = textSegs[item.segmentIndex]
      return seg?.startTime ?? message.timestamp
    }
    if (item.kind === 'skill') {
      const hint = skills.find((h) => h.id === item.hintId)
      return hint?.shownAt ?? message.timestamp
    }
    const tc = tools.find((t) => t.id === item.toolId)
    const idx = toolIndexById.get(item.toolId) ?? 0
    return tc?.startedAt ?? tc?.completedAt ?? idx * 1000 + 999
  }
}

const IN_PROGRESS_TOOL_STATUSES = new Set<ToolCallRecord['status']>(['calling', 'confirming', 'executing'])

/** 批次是否仍在进行中（streaming 且含未结束思考或非终态工具） */
export function isActivityBatchInProgress(
  items: AssistantActivityItem[],
  ctx: {
    streaming: boolean
    thinkingSegments: ReturnType<typeof thinkingSegmentsForRender>
    toolById: Map<string, ToolCallRecord>
  }
): boolean {
  if (!ctx.streaming) return false
  return items.some((item) => {
    if (item.kind === 'thinking') {
      const seg = ctx.thinkingSegments[item.segmentIndex]
      return seg?.endTime === undefined
    }
    if (item.kind === 'tool') {
      const tc = ctx.toolById.get(item.toolId)
      return tc != null && IN_PROGRESS_TOOL_STATUSES.has(tc.status)
    }
    return false
  })
}

export function getLastBatchItemTimestamp(
  timeline: AssistantActivityItem[],
  getTimestamp: (item: AssistantActivityItem) => number
): number | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!
    if (item.kind === 'thinking' || item.kind === 'tool') {
      return getTimestamp(item)
    }
  }
  return null
}
