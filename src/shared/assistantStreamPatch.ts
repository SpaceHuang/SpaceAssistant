import type { ContentState } from './contentSegments'
import { toThinkingData, type ThinkingState } from './thinkingSegments'

export function buildAssistantStreamPatch(thinkingState: ThinkingState, contentState: ContentState) {
  return {
    content: contentState.content,
    contentSegments: contentState.segments.length > 0 ? contentState.segments : undefined,
    ...(thinkingState.content ? { thinking: toThinkingData(thinkingState) } : {})
  }
}
