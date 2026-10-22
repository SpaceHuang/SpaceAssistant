import { describe, expect, it } from 'vitest'
import { createProjectionCanonicalHistoryReducer } from './projectionCanonicalHistoryReducer'
import type { ProjectionHistoryChunkEvent } from '../../domain/projectionSource'

const row = (patch: Partial<ProjectionHistoryChunkEvent> & Pick<ProjectionHistoryChunkEvent, 'invocationId' | 'sequence' | 'sessionSequence' | 'kind' | 'payloadJson'>): ProjectionHistoryChunkEvent => ({
  invocationId: patch.invocationId, sequence: patch.sequence, sessionSequence: patch.sessionSequence,
  eventId: patch.eventId ?? `event-${patch.sessionSequence}`, idempotencyKey: patch.idempotencyKey ?? `key-${patch.sessionSequence}`,
  turnId: patch.turnId ?? `turn-${patch.invocationId}`, schemaVersion: patch.schemaVersion ?? 1,
  kind: patch.kind, payloadJson: patch.payloadJson, commitOrder: patch.commitOrder ?? patch.sessionSequence,
  createdAt: patch.createdAt ?? patch.sessionSequence,
})

describe('projection canonical History reducer adapter', () => {
  it('round-trips checkpoint state between chunks and transitions only after a terminal invocation event', () => {
    const reducer = createProjectionCanonicalHistoryReducer()
    const first = reducer.fold(reducer.createState(), [row({ invocationId: 'inv-1', sequence: 1, sessionSequence: 1,
      kind: 'invocation-context-committed', payloadJson: '{"messages":[{"role":"user","content":"first"}]}' })])
    expect(JSON.parse(first.stateJson)).toMatchObject({ invocationId: 'inv-1', lastSequence: 1 })
    expect(first.outputOperations).toEqual([{ type: 'replace', messages: [{ role: 'user', content: 'first' }] }])

    const continued = reducer.fold(first.stateJson, [
      row({ invocationId: 'inv-1', sequence: 2, sessionSequence: 2, kind: 'model-response-committed',
        payloadJson: '{"message":{"role":"assistant","content":"answer"}}' }),
      row({ invocationId: 'inv-1', sequence: 3, sessionSequence: 3, kind: 'invocation-completed', payloadJson: '{"status":"completed"}' }),
    ])
    expect(JSON.parse(continued.stateJson)).toMatchObject({ invocationId: 'inv-1', lastSequence: 3, terminalEvent: true })
    expect(continued.outputOperations).toEqual([{ type: 'append', messages: [{ role: 'assistant', content: 'answer' }] }])

    const next = reducer.fold(continued.stateJson, [row({ invocationId: 'inv-2', sequence: 1, sessionSequence: 4,
      kind: 'invocation-context-committed', payloadJson: '{"messages":[{"role":"user","content":"second"}]}' })])
    expect(JSON.parse(next.stateJson)).toMatchObject({ invocationId: 'inv-2', lastSequence: 1, terminalEvent: false })
    expect(next.outputOperations).toEqual([{ type: 'replace', messages: [{ role: 'user', content: 'second' }] }])
  })

  it('fails closed when a different invocation starts before the current one is terminal', () => {
    const reducer = createProjectionCanonicalHistoryReducer()
    const first = reducer.fold(reducer.createState(), [row({ invocationId: 'inv-1', sequence: 1, sessionSequence: 1,
      kind: 'invocation-context-committed', payloadJson: '{"messages":[]}' })])
    expect(() => reducer.fold(first.stateJson, [row({ invocationId: 'inv-2', sequence: 1, sessionSequence: 2,
      kind: 'invocation-context-committed', payloadJson: '{"messages":[]}' })])).toThrow(/before a terminal event/)
  })

  it('flushes replay results that remain buffered at the final source chunk', () => {
    const reducer = createProjectionCanonicalHistoryReducer()
    const state = reducer.fold(reducer.createState(), [
      row({ invocationId: 'inv-tools', sequence: 1, sessionSequence: 1, kind: 'model-response-committed',
        payloadJson: '{"message":{"role":"assistant","toolCalls":[{"id":"tool-1","name":"lookup","input":{}}]}}' }),
      row({ invocationId: 'inv-tools', sequence: 2, sessionSequence: 2, kind: 'tool-call-finished',
        payloadJson: '{"toolCallId":"tool-1","replayContent":"done"}' }),
    ])
    expect(state.outputOperations).toEqual([{ type: 'append', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }] }] }])
    expect(reducer.finalize(state.stateJson).outputOperations).toEqual([{ type: 'append', messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }
    ] }] }])
  })
})
