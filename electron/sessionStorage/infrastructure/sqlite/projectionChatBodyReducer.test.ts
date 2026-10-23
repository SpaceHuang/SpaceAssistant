import { describe, expect, it } from 'vitest'
import { createProjectionChatBodyReducer } from './projectionChatBodyReducer'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'

describe('ProjectionSpec.chatBodyV1 reducer', () => {
  it('materializes only body fields from canonical History using same-snapshot authority facts', () => {
    const reducer = createProjectionChatBodyReducer()
    const event: ProjectionHistoryChunkEvent = {
      invocationId: 'body-inv', sequence: 1, eventId: 'body-context', idempotencyKey: 'body-context', turnId: 'body-turn',
      schemaVersion: 1, kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
      payloadJson: JSON.stringify({ messages: [
        { id: 'legacy-row', role: 'user', content: 'legacy text', timestamp: 1 },
        { id: 'canonical-row', role: 'assistant', content: 'canonical text', timestamp: 2 },
      ] }),
    }
    const facts: ProjectionMessageFact[] = [
      { id: 'legacy-row', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'legacy text' },
      { id: 'canonical-row', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
    ]
    const folded = reducer.fold(reducer.createState(), [event], facts)
    expect(folded.outputOperations).toEqual([{ type: 'replace', messages: [
      { id: 'legacy-row', role: 'user', content: 'legacy text', timestamp: 1 },
      { id: 'canonical-row', role: 'assistant', content: 'canonical text', timestamp: 2 },
    ] }])
    expect(JSON.stringify(folded.outputOperations)).not.toContain('queueScope')
    expect(JSON.stringify(folded.outputOperations)).not.toContain('storedContent')
  })

  it('rejects incomplete body authority facts instead of emitting a valid body', () => {
    const reducer = createProjectionChatBodyReducer()
    const event: ProjectionHistoryChunkEvent = {
      invocationId: 'body-inv', sequence: 1, eventId: 'body-context', idempotencyKey: 'body-context', turnId: 'body-turn',
      schemaVersion: 1, kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
      payloadJson: JSON.stringify({ messages: [{ id: 'missing-row', role: 'user', content: 'text', timestamp: 1 }] }),
    }
    expect(() => reducer.fold(reducer.createState(), [event], [])).toThrow('CHAT_BODY_SOURCE_FACT_MISSING')
  })

  it('coalesces incremental assistant response chunks before checking the durable body', () => {
    const reducer = createProjectionChatBodyReducer()
    const events: ProjectionHistoryChunkEvent[] = [
      { invocationId: 'chunk-inv', sequence: 1, eventId: 'chunk-context', idempotencyKey: 'chunk-context', turnId: 'chunk-turn',
        schemaVersion: 1, kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
        payloadJson: JSON.stringify({ messages: [{ id: 'chunk-user', role: 'user', content: 'question' }] }) },
      { invocationId: 'chunk-inv', sequence: 2, eventId: 'chunk-response-1', idempotencyKey: 'chunk-response-1', turnId: 'chunk-turn',
        schemaVersion: 1, kind: 'model-response-committed', sessionSequence: 2, commitOrder: 2, createdAt: 2,
        payloadJson: JSON.stringify({ message: { id: 'chunk-assistant', role: 'assistant', content: [{ type: 'text', text: 'part one' }] } }) },
      { invocationId: 'chunk-inv', sequence: 3, eventId: 'chunk-response-2', idempotencyKey: 'chunk-response-2', turnId: 'chunk-turn',
        schemaVersion: 1, kind: 'model-response-committed', sessionSequence: 3, commitOrder: 3, createdAt: 3,
        payloadJson: JSON.stringify({ message: { id: 'chunk-assistant', role: 'assistant', content: [{ type: 'text', text: ' part two' }] } }) },
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'chunk-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'question' },
      { id: 'chunk-assistant', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'part one part two' },
    ]

    expect(reducer.fold(reducer.createState(), events, facts).outputOperations).toEqual([
      { type: 'replace', messages: [{ id: 'chunk-user', role: 'user', content: 'question', timestamp: 1 }] },
      { type: 'append', messages: [{ id: 'chunk-assistant', role: 'assistant', content: 'part one part two', timestamp: 2 }] },
    ])
  })

  it('keeps one final legacy assistant body when History splits response chunks across reads', () => {
    const reducer = createProjectionChatBodyReducer()
    const first: ProjectionHistoryChunkEvent = {
      invocationId: 'split-inv', sequence: 1, eventId: 'split-response-1', idempotencyKey: 'split-response-1', turnId: 'split-turn',
      schemaVersion: 1, kind: 'model-response-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
      payloadJson: JSON.stringify({ message: { id: 'split-assistant', role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }),
    }
    const second: ProjectionHistoryChunkEvent = {
      ...first, sequence: 2, eventId: 'split-response-2', idempotencyKey: 'split-response-2', sessionSequence: 2, commitOrder: 2,
      payloadJson: JSON.stringify({ message: { id: 'split-assistant', role: 'assistant', content: [{ type: 'text', text: ' response' }] } }),
    }
    const facts: ProjectionMessageFact[] = [
      { id: 'split-assistant', role: 'assistant', timestamp: 2, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'partial response' },
    ]

    const firstSlice = reducer.fold(reducer.createState(), [first], facts)
    expect(firstSlice.outputOperations).toEqual([{ type: 'append', messages: [
      { id: 'split-assistant', role: 'assistant', content: 'partial response', timestamp: 2 },
    ] }])
    const secondSlice = reducer.fold(firstSlice.stateJson, [second], facts)
    expect(secondSlice.outputOperations).toEqual([])
  })
})
