import type { ContentSegment } from './domainTypes'

export type ContentState = {
  content: string
  segments: ContentSegment[]
  startTime: number
}

export function createContentState(startTime: number): ContentState {
  return { content: '', segments: [], startTime }
}

export function appendContentDelta(state: ContentState, delta: string, now = Date.now()): ContentState {
  const content = state.content + delta
  const segments = [...state.segments]
  const last = segments[segments.length - 1]
  if (!last || last.endTime !== undefined) {
    segments.push({ content: delta, startTime: now })
  } else {
    segments[segments.length - 1] = { ...last, content: last.content + delta }
  }
  return { ...state, content, segments }
}

export function closeOpenContentSegment(state: ContentState, now = Date.now()): ContentState {
  const segments = [...state.segments]
  const last = segments[segments.length - 1]
  if (!last || last.endTime !== undefined) return state
  segments[segments.length - 1] = { ...last, endTime: now }
  return { ...state, segments }
}

export function hasOpenContentSegment(state: ContentState): boolean {
  const last = state.segments[state.segments.length - 1]
  return Boolean(last && last.endTime === undefined)
}

export function finalizeContentSegments(state: ContentState, now = Date.now()): ContentSegment[] | undefined {
  if (!state.content) return undefined
  const closed = closeOpenContentSegment(state, now)
  return closed.segments.length > 0 ? closed.segments : undefined
}

export function contentSegmentsForRender(message: {
  content: string
  contentSegments?: ContentSegment[]
  timestamp: number
}): ContentSegment[] {
  if (message.contentSegments?.length) return message.contentSegments
  if (!message.content) return []
  return [{ content: message.content, startTime: Number.MAX_SAFE_INTEGER - 1 }]
}
