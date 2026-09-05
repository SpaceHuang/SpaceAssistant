import { describe, expect, it } from 'vitest'
import { normalizeAnthropicEvent } from './anthropicStreamDelta'

describe('normalizeAnthropicEvent', () => {
  it.each([
    [{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'block_start', index: 0, blockType: 'text' }],
    [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }, { type: 'text_delta', index: 0, text: 'hi' }],
    [{ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm' } }, { type: 'reasoning_delta', index: 1, text: 'hmm' }],
    [{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{' } }, { type: 'tool_call_delta', index: 2, partialJson: '{' }],
    [{ type: 'message_delta', message_delta: { stop_reason: 'end_turn' } }, { type: 'finish', stopReason: 'end_turn' }]
  ])('maps SDK event', (input, expected) => {
    const types = new Map<number, string>()
    expect(normalizeAnthropicEvent(input, types)).toEqual(expected)
  })
})
