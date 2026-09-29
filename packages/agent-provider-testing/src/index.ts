import type { ModelProvider, PreparedModelCall, StreamChunk } from '@spaceassistant/agent-sdk/model'

/** Canonical in-memory provider for protocol-independent SDK contract tests. */
export class CanonicalFakeProvider implements ModelProvider {
  readonly providerId = 'canonical-fake'
  readonly calls: PreparedModelCall[] = []
  private consumed = false

  constructor(private readonly fixture: readonly StreamChunk[]) {}

  async *stream(call: PreparedModelCall): AsyncIterable<StreamChunk> {
    if (this.consumed) throw new Error('fake stream already consumed')
    this.consumed = true
    const snapshot: PreparedModelCall = Object.freeze({
      route: Object.freeze({ ...call.route }),
      request: Object.freeze({
        messages: deepFreeze(structuredClone(call.request.messages)),
        maxTokens: call.request.maxTokens,
        ...(call.request.signal ? { signal: call.request.signal } : {})
      })
    })
    this.calls.push(snapshot)
    for (const chunk of this.fixture) {
      if (call.request.signal?.aborted) throw new Error('fake stream aborted')
      yield structuredClone(chunk)
    }
  }
}

/** Explicit canonical fake fixtures for both OpenAI protocols; no wire parser is involved. */
export function createOpenAiProtocolFixtures(): Readonly<Record<'openai-chat-completions' | 'openai-responses', readonly StreamChunk[]>> {
  return Object.freeze({
    'openai-chat-completions': Object.freeze([
      { type: 'text-delta', text: 'chat-completions' },
      { type: 'tool-call', toolCallId: 'chat-call-1', toolName: 'lookup', input: { query: 'x' } },
      { type: 'usage', inputTokens: 5, outputTokens: 3 },
      { type: 'finish', reason: 'tool-calls' }
    ] as const),
    'openai-responses': Object.freeze([
      { type: 'thinking-delta', text: 'responses-reasoning' },
      { type: 'text-delta', text: 'responses' },
      { type: 'usage', inputTokens: 7, outputTokens: 4 },
      { type: 'finish', reason: 'stop' }
    ] as const)
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}
