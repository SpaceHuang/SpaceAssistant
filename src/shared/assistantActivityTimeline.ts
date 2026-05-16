import type { ContentSegment, ThinkingData, ToolCallRecord } from './domainTypes'
import { contentSegmentsForRender } from './contentSegments'
import { thinkingSegmentsForRender } from './thinkingSegments'

export type AssistantActivityItem =
  | { kind: 'thinking'; segmentIndex: number }
  | { kind: 'text'; segmentIndex: number }
  | { kind: 'tool'; toolId: string }

const KIND_ORDER = { thinking: 0, text: 1, tool: 2 } as const

function zipInterleaveLegacy(
  thinkingSegs: ReturnType<typeof thinkingSegmentsForRender>,
  tools: ToolCallRecord[],
  textSegs: ContentSegment[]
): AssistantActivityItem[] {
  const out: AssistantActivityItem[] = []
  const n = Math.max(thinkingSegs.length, tools.length)
  for (let i = 0; i < n; i++) {
    if (i < thinkingSegs.length) out.push({ kind: 'thinking', segmentIndex: i })
    if (i < tools.length) out.push({ kind: 'tool', toolId: tools[i]!.id })
  }
  textSegs.forEach((_, i) => out.push({ kind: 'text', segmentIndex: i }))
  return out
}

/** 按发生顺序交错思考、正文与工具调用，供助手消息活动流渲染 */
export function buildAssistantActivityTimeline(message: {
  content: string
  contentSegments?: ContentSegment[]
  thinking?: ThinkingData
  toolCalls?: ToolCallRecord[]
  timestamp: number
}): AssistantActivityItem[] {
  const thinkingSegs = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
  const textSegs = contentSegmentsForRender(message)
  const tools = message.toolCalls ?? []
  if (thinkingSegs.length === 0 && textSegs.length === 0 && tools.length === 0) return []

  const toolsHaveTimeline = tools.some((t) => t.startedAt != null)
  const textHasTimeline = Boolean(message.contentSegments?.length)
  if (!toolsHaveTimeline && !textHasTimeline) {
    return zipInterleaveLegacy(thinkingSegs, tools, textSegs)
  }

  type Sortable = AssistantActivityItem & { sortAt: number; order: number }
  const items: Sortable[] = []
  thinkingSegs.forEach((seg, i) => {
    items.push({
      kind: 'thinking',
      segmentIndex: i,
      sortAt: seg.startTime,
      order: i * 3 + KIND_ORDER.thinking
    })
  })
  textSegs.forEach((seg, i) => {
    items.push({
      kind: 'text',
      segmentIndex: i,
      sortAt: seg.startTime,
      order: i * 3 + KIND_ORDER.text
    })
  })
  tools.forEach((tc, i) => {
    items.push({
      kind: 'tool',
      toolId: tc.id,
      sortAt: tc.startedAt ?? tc.completedAt ?? i * 1000 + 999,
      order: i * 3 + KIND_ORDER.tool
    })
  })
  items.sort((a, b) => {
    if (a.sortAt !== b.sortAt) return a.sortAt - b.sortAt
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    return a.order - b.order
  })
  return items.map((item) => {
    if (item.kind === 'thinking') return { kind: 'thinking', segmentIndex: item.segmentIndex }
    if (item.kind === 'text') return { kind: 'text', segmentIndex: item.segmentIndex }
    return { kind: 'tool', toolId: item.toolId }
  })
}
