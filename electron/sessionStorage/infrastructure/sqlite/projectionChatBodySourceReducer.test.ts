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
