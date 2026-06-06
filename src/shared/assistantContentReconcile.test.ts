import { describe, expect, it } from 'vitest'
import { appendContentDelta as appendContent, closeOpenContentSegment, createContentState as createContent } from './contentSegments'
import {
  appendThinkingDelta,
  closeOpenThinkingSegment,
  createThinkingState
} from './thinkingSegments'
import {
  promoteLastThinkingSegmentToContent,
  reconcileAssistantStreamOnComplete,
  shouldPromoteFinalThinkingToContent
} from './assistantContentReconcile'

describe('assistantContentReconcile', () => {
  it('promotes only the last thinking segment on end_turn with thinking-only api blocks', () => {
    let thinkingState = createThinkingState(1)
    thinkingState = appendThinkingDelta(thinkingState, 'round1 plan', 2)
    thinkingState = closeOpenThinkingSegment(thinkingState, 3)

    let contentState = createContent(4)
    contentState = appendContent(contentState, 'short ack', 5)
    contentState = closeOpenContentSegment(contentState, 6)

    thinkingState = appendThinkingDelta(thinkingState, 'formal reply body', 7)

    const apiContent = [{ type: 'thinking', thinking: 'formal reply body' }]
    expect(shouldPromoteFinalThinkingToContent('end_turn', apiContent, contentState, thinkingState)).toBe(true)

    const reconciled = reconcileAssistantStreamOnComplete({
      stopReason: 'end_turn',
      apiContent,
      contentState,
      thinkingState
    })

    expect(reconciled.thinkingState.content).toBe('round1 plan')
    expect(reconciled.textOut).toBe('short ackformal reply body')
    expect(reconciled.contentState.segments).toHaveLength(2)
  })

  it('does not promote when final api response includes text', () => {
    const thinkingState = createThinkingState(1)
    const contentState = createContent(1)
    const apiContent = [
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: 'visible reply' }
    ]
    expect(shouldPromoteFinalThinkingToContent('end_turn', apiContent, contentState, thinkingState)).toBe(false)
  })

  it('does not promote on tool_use stop reason', () => {
    let thinkingState = createThinkingState(1)
    let contentState = createContent(1)
    thinkingState = appendThinkingDelta(thinkingState, 'plan', 2)
    contentState = appendContent(contentState, 'ack', 3)
    const apiContent = [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }]
    expect(shouldPromoteFinalThinkingToContent('tool_use', apiContent, contentState, thinkingState)).toBe(false)
  })

  it('promotes entire thinking when no segments exist (legacy stream state)', () => {
    const thinkingState = { content: 'only thinking reply', segments: [], startTime: 1 }
    const contentState = createContent(1)
    const promoted = promoteLastThinkingSegmentToContent(thinkingState, contentState, 2)
    expect(promoted.thinkingState.content).toBe('')
    expect(promoted.contentState.content).toBe('only thinking reply')
  })
})
