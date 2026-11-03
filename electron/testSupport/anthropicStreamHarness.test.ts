import { describe, expect, it } from 'vitest'
import { createAnthropicClient } from '../anthropicClientFactory'
import { createAnthropicStreamHarness } from './anthropicStreamHarness'

const messageStart = {
  type: 'message_start',
  message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } }
}

function streamFor(fetch: typeof globalThis.fetch) {
  const client = createAnthropicClient('test-key', 'https://model.test', { fetch, maxRetries: 0 })
  return client.messages.stream({ model: 'claude-test', max_tokens: 128, messages: [{ role: 'user', content: 'test' }] })
}

describe('anthropic stream harness', () => {
  it('drives text, thinking, and tool-use SSE events through the Anthropic SDK', async () => {
    const harness = createAnthropicStreamHarness()
    harness.enqueue({ kind: 'sse', events: [
      messageStart,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: 'sig' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'reason' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: 'message_stop' }
    ] })
    const stream = streamFor(harness.fetch)
    const events = []
    for await (const event of stream) events.push(event)
    const final = await stream.finalMessage()
    expect(events.map((event) => event.type)).toContain('content_block_delta')
    expect(final.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hello' }),
      expect.objectContaining({ type: 'thinking', thinking: 'reason' }),
      expect.objectContaining({ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } })
    ]))
    expect(harness.requests).toHaveLength(1)
  })

  it('surfaces an overloaded response as an API error', async () => {
    const harness = createAnthropicStreamHarness()
    harness.enqueue({ kind: 'http-error', status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } })
    await expect(async () => {
      for await (const _event of streamFor(harness.fetch)) { /* consume */ }
    }).rejects.toMatchObject({ status: 529 })
  })

  it('surfaces a network interruption', async () => {
    const harness = createAnthropicStreamHarness()
    harness.enqueue({ kind: 'network-error', message: 'connection reset' })
    try {
      for await (const _event of streamFor(harness.fetch)) { /* consume */ }
      throw new Error('expected provider request to fail')
    } catch (error) {
      expect(error).toMatchObject({ message: 'Connection error.', cause: { message: 'connection reset' } })
    }
  })

  it('rejects an SSE stream that ends before a terminal event', async () => {
    const harness = createAnthropicStreamHarness()
    harness.enqueue({ kind: 'sse', events: [messageStart], closePrematurely: true })
    await expect(async () => {
      for await (const _event of streamFor(harness.fetch)) { /* consume */ }
    }).rejects.toThrow()
  })
})
