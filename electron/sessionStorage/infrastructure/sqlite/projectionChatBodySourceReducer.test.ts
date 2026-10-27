import { describe, expect, it } from 'vitest'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { reduceProjectionInvocationChatBodySources } from './projectionChatBodySourceReducer'

function event(invocationId: string, sequence: number, kind: string, payload: unknown): ProjectionHistoryChunkEvent {
  return { invocationId, turnId: invocationId, sequence, eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`,
    schemaVersion: 1, kind, sessionSequence: sequence, commitOrder: sequence, createdAt: sequence, payloadJson: JSON.stringify(payload) }
}

describe('projection chat body source reducer', () => {
  it('uses the authoritative reducer for compaction, assistant chunks and required-user IDs', () => {
    const events = [
      event('invocation-a', 1, 'invocation-context-committed', { messages: [
        { id: 'user-a', role: 'user', content: 'prompt', timestamp: 1 }, { role: 'user', content: 'required task', timestamp: 2 },
      ], requiredUserMessage: { id: 'required-a', message: { role: 'user', content: 'required task', timestamp: 2 } } }),
      event('invocation-a', 2, 'model-response-committed', { message: { id: 'assistant-a', role: 'assistant', content: 'partial ', timestamp: 3 } }),
      event('invocation-a', 3, 'model-response-committed', { message: { id: 'assistant-a', role: 'assistant', content: 'response', timestamp: 3 } }),
      event('invocation-a', 4, 'invocation-completed', { status: 'completed' }),
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'user-a', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'prompt' },
      { id: 'required-a', role: 'user', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'required task' },
      { id: 'assistant-a', role: 'assistant', timestamp: 3, sequence: 2, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'partial response' },
    ]
    const output = reduceProjectionInvocationChatBodySources(events, facts)
    expect(output.messages.map(({ id, content, sequence }) => [id, content, sequence])).toEqual([
      ['user-a', 'prompt', 0], ['required-a', 'required task', 1], ['assistant-a', 'partial response', 2],
    ])
    expect(output.dependenciesByMessage.get('assistant-a')?.map(({ eventId }) => eventId)).toEqual(events.map(({ eventId }) => eventId))
    expect(output.manifestDigestByMessage.get('assistant-a')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('preserves image and tool-use messages from canonical History during source locator reduction', () => {
    const rows = [
      event('rich-content', 1, 'invocation-context-committed', { messages: [
        { id: 'image-user', role: 'user', content: [{ type: 'text', text: 'inspect this' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], timestamp: 1 },
      ] }),
      event('rich-content', 2, 'model-response-committed', { message: { id: 'tool-assistant', role: 'assistant', content: [
        { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'lookup-1', name: 'lookup', input: { q: 'status' } },
      ], timestamp: 2 } }),
      event('rich-content', 3, 'invocation-completed', { status: 'completed' }),
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'image-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'inspect this' },
      { id: 'tool-assistant', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'checking' },
    ]

    const output = reduceProjectionInvocationChatBodySources(rows, facts)

    expect(output.messages.map(({ id, role, content, sequence }) => [id, role, content, sequence])).toEqual([
      ['image-user', 'user', 'inspect this', 0], ['tool-assistant', 'assistant', 'checking', 1],
    ])
    expect(output.dependenciesByMessage.get('image-user')?.map(({ eventId }) => eventId)).toEqual(rows.map(({ eventId }) => eventId))
    expect(output.dependenciesByMessage.get('tool-assistant')?.map(({ eventId }) => eventId)).toEqual(rows.map(({ eventId }) => eventId))
  })

  it('matches the canonical reducer for replay, tool lifecycle, assistant chunks and compaction dependencies', () => {
    const firstInvocation = [
      event('turn-1', 1, 'invocation-context-committed', { messages: [
        { id: 'u1', role: 'user', content: 'prompt', timestamp: 1 },
      ] }),
      event('turn-1', 2, 'model-response-committed', { message: { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: 'new ' },
      ], timestamp: 2 } }),
      event('turn-1', 3, 'model-response-committed', { message: { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: 'answer' },
      ], timestamp: 2 } }),
      event('turn-1', 4, 'invocation-completed', { status: 'completed' }),
    ]
    const firstFacts: ProjectionMessageFact[] = [
      { id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'prompt' },
      { id: 'a1', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'new answer' },
    ]
    const secondInvocation = [
      event('turn-2', 1, 'invocation-context-committed', { messages: [
        { id: 'u1', role: 'user', content: 'prompt', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'new answer' }], timestamp: 2 },
        { id: 'u2', role: 'user', content: 'next prompt', timestamp: 3 },
      ] }),
      event('turn-2', 2, 'transcript-compacted', { messages: [
        { id: 'u1', role: 'user', content: 'summary of prompt', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'summary answer' }], timestamp: 2 },
        { id: 'u2', role: 'user', content: 'next prompt', timestamp: 3 },
      ] }),
      event('turn-2', 3, 'replay-message-committed', { message: { id: 'u3', role: 'user', content: [
        { type: 'text', text: 'image prompt' }, { type: 'image', mimeType: 'image/png', data: 'YQ==' },
      ], timestamp: 4 } }),
      event('turn-2', 4, 'model-response-committed', { message: { id: 'a2', role: 'assistant', content: [
        { type: 'image', mimeType: 'image/png', data: 'YQ==' }, { type: 'text', text: 'final answer' },
      ], toolCalls: [{ id: 'call-1', name: 'lookup', input: { q: 'x' } }], timestamp: 5 } }),
      event('turn-2', 5, 'tool-call-started', { toolCallId: 'call-1', toolName: 'lookup' }),
      event('turn-2', 6, 'tool-call-finished', { toolCallId: 'call-1', replayContent: 'lookup result' }),
      event('turn-2', 7, 'invocation-completed', { status: 'completed' }),
    ]
    const secondFacts: ProjectionMessageFact[] = [
      { id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'summary of prompt' },
      { id: 'a1', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'canonical-backed-only',
        writeMode: 'canonical', storedContent: '' },
      { id: 'u2', role: 'user', timestamp: 3, sequence: 2, queueScope: 'desktop', contentStorageState: 'canonical-backed-dual-write',
        writeMode: 'canonical', storedContent: 'next prompt' },
      { id: 'u3', role: 'user', timestamp: 4, sequence: 3, queueScope: 'desktop', contentStorageState: 'legacy',
        writeMode: null, storedContent: 'image prompt' },
      { id: 'a2', role: 'assistant', timestamp: 5, sequence: 4, queueScope: 'desktop', contentStorageState: 'canonical-backed-only',
        writeMode: 'canonical', storedContent: '' },
    ]

    const first = reduceProjectionInvocationChatBodySources(firstInvocation, firstFacts)
    const second = reduceProjectionInvocationChatBodySources(secondInvocation, secondFacts)

    expect(first.messages.map(({ id, content }) => [id, content])).toEqual([['u1', 'prompt'], ['a1', 'new answer']])
    expect(second.replacesPriorMessages).toBe(true)
    expect(second.messages.map(({ id, content }) => [id, content])).toEqual([
      ['u1', 'summary of prompt'], ['a1', 'summary answer'], ['u2', 'next prompt'], ['u3', 'image prompt'], ['a2', 'final answer'],
    ])
    expect(second.dependenciesByMessage.get('a1')?.map(({ eventId }) => eventId)).toEqual(secondInvocation.map(({ eventId }) => eventId))
    expect(second.dependenciesByMessage.get('a2')?.map(({ eventId }) => eventId)).toEqual(secondInvocation.map(({ eventId }) => eventId))
  })

  it('rejects missing message facts, duplicate sequences and incomplete invocation event order', () => {
    const rows = [event('invalid', 1, 'invocation-context-committed', { messages: [{ id: 'one', role: 'user', content: 'body', timestamp: 1 }] }),
      event('invalid', 2, 'invocation-completed', { status: 'completed' })]
    expect(() => reduceProjectionInvocationChatBodySources(rows, [])).toThrow('CHAT_BODY_SOURCE_FACT_MISSING')
    const duplicateFacts = [
      { id: 'one', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy' as const, writeMode: null, storedContent: 'body' },
      { id: 'two', role: 'user', timestamp: 2, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy' as const, writeMode: null, storedContent: 'other' },
    ]
    expect(() => reduceProjectionInvocationChatBodySources([
      event('invalid', 1, 'invocation-context-committed', { messages: [
        { id: 'one', role: 'user', content: 'body', timestamp: 1 }, { id: 'two', role: 'user', content: 'other', timestamp: 2 },
      ] }), event('invalid', 2, 'invocation-completed', { status: 'completed' }),
    ], duplicateFacts)).toThrow('CHAT_BODY_SOURCE_SEQUENCE_DUPLICATE')
    expect(() => reduceProjectionInvocationChatBodySources([rows[1]!, rows[0]!], [duplicateFacts[0]!]))
      .toThrow('CHAT_BODY_SOURCE_EVENT_ORDER_INVALID')
  })
})
