import { describe, expect, it } from 'vitest'
import { appendContentDelta as appendContent, createContentState as createContent } from './contentSegments'
import { appendThinkingDelta, createThinkingState } from './thinkingSegments'
import { reconcileAssistantStreamOnComplete } from './assistantContentReconcile'

describe('assistantContentReconcile', () => {
  it('promotes thinking-only normal end_turn content for gateway compatibility', () => {
    const thinkingState = appendThinkingDelta(createThinkingState(1), 'internal reply', 2)
    const contentState = createContent(1)
    const reconciled = reconcileAssistantStreamOnComplete({ stopReason: 'end_turn', apiContent: [{ type: 'thinking', thinking: 'internal reply' }], contentState, thinkingState })
    expect(reconciled.textOut).toBe('internal reply')
    expect(reconciled.contentState.content).toBe('internal reply')
    expect(reconciled.thinkingState.content).toBe('')
  })

  it('does not promote incomplete thinking on max_tokens', () => {
    const thinkingState = appendThinkingDelta(createThinkingState(1), 'incomplete', 2)
    const reconciled = reconcileAssistantStreamOnComplete({ stopReason: 'max_tokens', apiContent: [{ type: 'thinking', thinking: 'incomplete' }], contentState: createContent(1), thinkingState })
    expect(reconciled.textOut).toBe('')
    expect(reconciled.thinkingState.content).toBe('incomplete')
  })

  it('promotes thinking-only content when stop reason is missing', () => {
    const thinkingState = { content: 'only thinking', segments: [], startTime: 1 }
    const reconciled = reconcileAssistantStreamOnComplete({ apiContent: [], contentState: createContent(1), thinkingState })
    expect(reconciled.textOut).toBe('only thinking')
    expect(reconciled.contentState.content).toBe('only thinking')
    expect(reconciled.thinkingState.content).toBe('')
  })

  it('uses explicit text blocks as the only API answer text', () => {
    const reconciled = reconcileAssistantStreamOnComplete({ stopReason: 'end_turn', apiContent: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'visible reply' }], contentState: createContent(1), thinkingState: createThinkingState(1) })
    expect(reconciled.textOut).toBe('visible reply')
  })
})
