import {
  appendContentDelta,
  closeOpenContentSegment,
  hasOpenContentSegment,
  type ContentState
} from './contentSegments'
import type { ThinkingState } from './thinkingSegments'

export function extractAssistantTextFromApiContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string') {
      s += (b as { text: string }).text
    }
  }
  return s
}

export function extractThinkingFromApiContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const type = (b as { type?: string }).type
    if (type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string') {
      s += (b as { thinking: string }).thinking
    }
  }
  return s
}

/** 兼容部分网关在正常完成时把正式回复放进 thinking 块的行为。 */
export function shouldPromoteFinalThinkingToContent(
  stopReason: string | undefined,
  apiContent: unknown[],
  contentState: ContentState,
  thinkingState: ThinkingState
): boolean {
  if (stopReason && stopReason !== 'end_turn') return false
  if (apiContent.length > 0) {
    if (extractAssistantTextFromApiContent(apiContent).trim()) return false
    return extractThinkingFromApiContent(apiContent).trim().length > 0
  }
  if (contentState.content.trim()) return false
  return Boolean(thinkingState.content.trim())
}

/** 将最后一轮 thinking 提升为正文，并保留更早的 thinking 段落。 */
export function promoteLastThinkingSegmentToContent(
  thinkingState: ThinkingState,
  contentState: ContentState,
  now = Date.now()
): { thinkingState: ThinkingState; contentState: ContentState } {
  const segments = thinkingState.segments
  if (segments.length === 0) {
    if (!thinkingState.content.trim()) return { thinkingState, contentState }
    let nextContent = contentState
    if (hasOpenContentSegment(nextContent)) nextContent = closeOpenContentSegment(nextContent, now)
    nextContent = appendContentDelta(nextContent, thinkingState.content, now)
    return { thinkingState: { ...thinkingState, content: '', segments: [] }, contentState: nextContent }
  }
  const last = segments[segments.length - 1]!
  if (!last.content.trim()) return { thinkingState, contentState }
  let nextContent = contentState
  if (hasOpenContentSegment(nextContent)) nextContent = closeOpenContentSegment(nextContent, now)
  nextContent = appendContentDelta(nextContent, last.content, now)
  return {
    thinkingState: { ...thinkingState, content: segments.slice(0, -1).map((s) => s.content).join(''), segments: segments.slice(0, -1) },
    contentState: nextContent
  }
}

export function reconcileAssistantStreamOnComplete(args: {
  stopReason?: string
  apiContent?: unknown[]
  contentState: ContentState
  thinkingState: ThinkingState
  now?: number
}): { contentState: ContentState; thinkingState: ThinkingState; textOut: string } {
  let { contentState, thinkingState } = args
  const apiContent = args.apiContent ?? []
  if (shouldPromoteFinalThinkingToContent(args.stopReason, apiContent, contentState, thinkingState)) {
    const promoted = promoteLastThinkingSegmentToContent(thinkingState, contentState, args.now)
    return { contentState: promoted.contentState, thinkingState: promoted.thinkingState, textOut: promoted.contentState.content }
  }
  const apiText = extractAssistantTextFromApiContent(apiContent)
  const textOut = apiText || contentState.content
  if (apiText && apiText !== contentState.content) {
    contentState = { ...contentState, content: apiText }
  }
  return { contentState, thinkingState, textOut }
}
