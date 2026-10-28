import type { ContentSegment, SkillHintRecord, ThinkingData, ToolCallRecord } from './domainTypes'
import { contentSegmentsForRender } from './contentSegments'
import { thinkingSegmentsForRender } from './thinkingSegments'

export type AssistantActivityItem =
  | { kind: 'thinking'; segmentIndex: number }
  | { kind: 'text'; segmentIndex: number }
  | { kind: 'tool'; toolId: string }
  | { kind: 'skill'; hintId: string }
  | { kind: 'system-operation'; operationId: string }

const KIND_ORDER = { thinking: 0, skill: 1, text: 2, 'system-operation': 3, tool: 4 } as const

function zipInterleaveLegacy(
  thinkingSegs: ReturnType<typeof thinkingSegmentsForRender>,
  tools: ToolCallRecord[],
  textSegs: ContentSegment[],
  skills: SkillHintRecord[]
): AssistantActivityItem[] {
  const out: AssistantActivityItem[] = []
  skills.forEach((hint) => out.push({ kind: 'skill', hintId: hint.id }))
  const n = Math.max(thinkingSegs.length, tools.length)
  for (let i = 0; i < n; i++) {
    if (i < thinkingSegs.length) out.push({ kind: 'thinking', segmentIndex: i })
    if (i < tools.length) out.push({ kind: 'tool', toolId: tools[i]!.id })
  }
  textSegs.forEach((_, i) => out.push({ kind: 'text', segmentIndex: i }))
  return out
}

/** 按发生顺序交错思考、Skill 提示、正文与工具调用，供助手消息活动流渲染 */
export function buildAssistantActivityTimeline(message: {
  content: string
  contentSegments?: ContentSegment[]
  thinking?: ThinkingData
  toolCalls?: ToolCallRecord[]
  skillHints?: SkillHintRecord[]
  systemOperations?: import('./domainTypes').SystemOperationRecord[]
  timestamp: number
}): AssistantActivityItem[] {
  const thinkingSegs = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
  const textSegs = contentSegmentsForRender(message)
  const tools = message.toolCalls ?? []
  const skills = message.skillHints ?? []
  const systemOperations = message.systemOperations ?? []
  if (thinkingSegs.length === 0 && textSegs.length === 0 && tools.length === 0 && skills.length === 0 && systemOperations.length === 0) return []

  const toolsHaveTimeline = tools.some((t) => t.startedAt != null)
  const textHasTimeline = Boolean(message.contentSegments?.length)
  const hasTimeline = skills.length > 0 || systemOperations.length > 0
  if (!toolsHaveTimeline && !textHasTimeline && !hasTimeline) {
    return zipInterleaveLegacy(thinkingSegs, tools, textSegs, skills)
  }

  type Sortable = AssistantActivityItem & { sortAt: number; order: number }
  const items: Sortable[] = []
  thinkingSegs.forEach((seg, i) => {
    items.push({
      kind: 'thinking',
      segmentIndex: i,
      sortAt: seg.startTime,
      order: i * 4 + KIND_ORDER.thinking
    })
  })
  skills.forEach((hint, i) => {
    items.push({
      kind: 'skill',
      hintId: hint.id,
      sortAt: hint.shownAt,
      order: i * 4 + KIND_ORDER.skill
    })
  })
  systemOperations.forEach((operation, i) => {
    items.push({ kind: 'system-operation', operationId: operation.id, sortAt: operation.startedAt, order: i * 4 + KIND_ORDER['system-operation'] })
  })
  textSegs.forEach((seg, i) => {
    items.push({
      kind: 'text',
      segmentIndex: i,
      sortAt: seg.startTime,
      order: i * 4 + KIND_ORDER.text
    })
  })
  tools.forEach((tc, i) => {
    items.push({
      kind: 'tool',
      toolId: tc.id,
      // 排序时间戳必须是「发起序」：主进程工具记录不携带 startedAt，completedAt（真实
      // 时间）只在终态出现——若参与排序，工具进入终态瞬间会从 fallback 跳到真实值，
      // 时间线全局重排 → 活动批次拆分/成员换位 → 批次整块重建闪动。
      sortAt: tc.startedAt ?? message.timestamp + i + 1,
      order: i * 4 + KIND_ORDER.tool
    })
  })
  items.sort((a, b) => {
    if (a.sortAt !== b.sortAt) return a.sortAt - b.sortAt
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    return a.order - b.order
  })
  return items.map((item) => {
    if (item.kind === 'thinking') return { kind: 'thinking', segmentIndex: item.segmentIndex }
    if (item.kind === 'skill') return { kind: 'skill', hintId: item.hintId }
    if (item.kind === 'text') return { kind: 'text', segmentIndex: item.segmentIndex }
    if (item.kind === 'system-operation') return { kind: 'system-operation', operationId: item.operationId }
    return { kind: 'tool', toolId: item.toolId }
  })
}
