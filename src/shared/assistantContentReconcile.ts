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

/** 末轮仅有 thinking、无 text 时（部分网关会把正式回复写进 thinking 块） */
export function shouldPromoteFinalThinkingToContent(
  stopReason: string | undefined,
  apiContent: unknown[],
  contentState: ContentState,
  thinkingState: ThinkingState
): boolean {
  if (stopReason && stopReason !== 'end_turn') return false

  if (apiContent.length > 0) {
    const apiText = extractAssistantTextFromApiContent(apiContent).trim()
    if (apiText) return false
    return extractThinkingFromApiContent(apiContent).trim().length > 0
  }

  if (contentState.content.trim()) return false
  return Boolean(thinkingState.content.trim())
}

/** 将最后一轮 thinking 段落提升为助手正文，保留更早的 thinking 段落在思考块内 */
export function promoteLastThinkingSegmentToContent(
  thinkingState: ThinkingState,
  contentState: ContentState,
  now = Date.now()
): { thinkingState: ThinkingState; contentState: ContentState } {
  const segments = thinkingState.segments
  if (segments.length === 0) {
    if (!thinkingState.content.trim()) return { thinkingState, contentState }
    let nextContent = contentState
    if (hasOpenContentSegment(nextContent)) {
      nextContent = closeOpenContentSegment(nextContent, now)
    }
    nextContent = appendContentDelta(nextContent, thinkingState.content, now)
    return {
      thinkingState: { ...thinkingState, content: '', segments: [] },
      contentState: nextContent
    }
  }

  const last = segments[segments.length - 1]!
  if (!last.content.trim()) return { thinkingState, contentState }

  const remainingSegments = segments.slice(0, -1)
  const remainingContent = remainingSegments.map((s) => s.content).join('')

  let nextContent = contentState
  if (hasOpenContentSegment(nextContent)) {
    nextContent = closeOpenContentSegment(nextContent, now)
  }
  nextContent = appendContentDelta(nextContent, last.content, now)

  return {
    thinkingState: {
      ...thinkingState,
      content: remainingContent,
      segments: remainingSegments
    },
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
  const now = args.now ?? Date.now()

  if (shouldPromoteFinalThinkingToContent(args.stopReason, apiContent, contentState, thinkingState)) {
    const promoted = promoteLastThinkingSegmentToContent(thinkingState, contentState, now)
    thinkingState = promoted.thinkingState
    contentState = promoted.contentState
    return { contentState, thinkingState, textOut: contentState.content }
  }

  const apiText = extractAssistantTextFromApiContent(apiContent)
  const textOut = apiText || contentState.content
  if (apiText && apiText !== contentState.content) {
    contentState = { ...contentState, content: apiText }
  }
  return { contentState, thinkingState, textOut }
}
