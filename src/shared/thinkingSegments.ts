import type { ThinkingData, ThinkingSegment } from './domainTypes'

export type ThinkingState = {
  content: string
  segments: ThinkingSegment[]
  startTime: number
}

export function createThinkingState(startTime: number): ThinkingState {
  return { content: '', segments: [], startTime }
}

export function appendThinkingDelta(state: ThinkingState, delta: string, now = Date.now()): ThinkingState {
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

export function closeOpenThinkingSegment(state: ThinkingState, now = Date.now()): ThinkingState {
  const segments = [...state.segments]
  const last = segments[segments.length - 1]
  if (!last || last.endTime !== undefined) return state
  segments[segments.length - 1] = { ...last, endTime: now }
  return { ...state, segments }
}

export function hasOpenThinkingSegment(state: ThinkingState): boolean {
  const last = state.segments[state.segments.length - 1]
  return Boolean(last && last.endTime === undefined)
}

export function toThinkingData(state: ThinkingState, isVisible = true): ThinkingData {
  const last = state.segments[state.segments.length - 1]
  return {
    content: state.content,
    isVisible,
    startTime: state.startTime,
    endTime: last?.endTime,
    segments: state.segments.length > 0 ? state.segments : undefined
  }
}

export function finalizeThinking(state: ThinkingState, now = Date.now()): ThinkingData | undefined {
  if (!state.content) return undefined
  return toThinkingData(closeOpenThinkingSegment(state, now))
}

export function thinkingSegmentsForRender(thinking: ThinkingData): ThinkingSegment[] {
  if (thinking.segments?.length) return thinking.segments
  if (!thinking.content) return []
  return [{ content: thinking.content, startTime: thinking.startTime, endTime: thinking.endTime }]
}
