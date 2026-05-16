import { describe, expect, it } from 'vitest'
import {
  appendThinkingDelta,
  closeOpenThinkingSegment,
  createThinkingState,
  finalizeThinking,
  hasOpenThinkingSegment,
  thinkingSegmentsForRender,
  toThinkingData
} from './thinkingSegments'
import type { ThinkingData } from './domainTypes'

describe('thinkingSegments', () => {
  it('opens a new segment after the previous one closes', () => {
    let state = createThinkingState(100)
    state = appendThinkingDelta(state, 'a', 101)
    expect(state.segments).toHaveLength(1)
    state = closeOpenThinkingSegment(state, 102)
    state = appendThinkingDelta(state, 'b', 103)
    expect(state.segments).toHaveLength(2)
    expect(state.segments[0]?.endTime).toBe(102)
    expect(state.segments[1]?.content).toBe('b')
  })

  it('closes open segment on text output', () => {
    let state = createThinkingState(1)
    state = appendThinkingDelta(state, 'plan', 2)
    expect(hasOpenThinkingSegment(state)).toBe(true)
    state = closeOpenThinkingSegment(state, 3)
    expect(hasOpenThinkingSegment(state)).toBe(false)
    expect(toThinkingData(state).endTime).toBe(3)
  })

  it('finalizes all open segments', () => {
    let state = createThinkingState(1)
    state = appendThinkingDelta(state, 'x', 2)
    const data = finalizeThinking(state, 9)
    expect(data?.segments?.[0]?.endTime).toBe(9)
  })

  it('falls back to single segment for legacy thinking data', () => {
    const legacy: ThinkingData = {
      content: 'legacy',
      isVisible: true,
      startTime: 1,
      endTime: 2
    }
    expect(thinkingSegmentsForRender(legacy)).toEqual([{ content: 'legacy', startTime: 1, endTime: 2 }])
  })
})
