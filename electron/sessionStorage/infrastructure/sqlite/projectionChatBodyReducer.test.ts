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
})
