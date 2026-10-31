import { describe, expect, it } from 'vitest'
import { applyContextEvent, beginContextTurn, commitContextTurn, createApprovalSystemMessage, createContextSelectionIntent, restoreLegacySessionContextSnapshot, restoreLegacySessionContextEvents, restoreSessionContext, selectContextCommit } from '../src/sessionContext'
import type { CanonicalModelMessage } from '../src/model'

const user = (id: string, content: string): CanonicalModelMessage => ({ role: 'user', id, content })
const assistant = (id: string, content: string): CanonicalModelMessage => ({ role: 'assistant', id, content })

describe('shared session context rules', () => {
  it('promotes only the committed selection to the next immutable session context version', () => {
    const prior = [user('prior-user', 'prior question'), assistant('prior-assistant', 'prior answer')]
    const seed = restoreLegacySessionContextSnapshot({ invocationId: 'prior-invocation', turnId: 'prior-turn', committedVersion: 4, messages: prior })
    const current = beginContextTurn(seed, { invocationId: 'current-invocation', baseVersion: 4,
      inputMessages: [user('current-user', 'current question')], failureInputMessages: [], requestSystem: '' })
    const withAnswer = applyContextEvent(current, { kind: 'model-response-committed', message: assistant('current-assistant', 'current answer') })

    const committed = commitContextTurn(withAnswer, { kind: 'completed' }, 5)

    expect(committed.committedVersion).toBe(5)
    expect(committed.committed).toEqual([...prior, user('current-user', 'current question'), assistant('current-assistant', 'current answer')])
    expect(committed.working).toEqual(committed.committed)
    expect(committed.activeInvocationId).toBeUndefined()
    const next = beginContextTurn(committed, { invocationId: 'next-invocation', baseVersion: 5,
      inputMessages: [user('next-user', 'next question')], failureInputMessages: [], requestSystem: '' })
    expect(selectContextCommit(next, { kind: 'completed' }).messages).toEqual([...committed.committed, user('next-user', 'next question')])
  })

  it('adapts a legacy transcript seed once into committed shared context without changing message order or tool pairing', () => {
    const legacy = [user('legacy-user', 'question'), {
      role: 'assistant' as const, id: 'legacy-assistant', content: 'call',
      toolCalls: [{ id: 'legacy-call', name: 'lookup', input: { q: 'x' } }]
    }, { role: 'tool' as const, toolCallId: 'legacy-call', content: 'found', isError: false }]
    const restored = restoreLegacySessionContextSnapshot({
      invocationId: 'legacy-seed-invocation', turnId: 'legacy-seed-turn', committedVersion: 7, messages: legacy
    })
    expect(restored.committedVersion).toBe(7)
    expect(restored.committed).toEqual(legacy)
    expect(restored.working).toEqual(legacy)
  })

  it('adapts successive legacy full snapshots through shared context actions with exact message order', () => {
    const firstMessages = [user('legacy-u1', 'first'), assistant('legacy-a1', 'answer')]
    const secondMessages = [...firstMessages, user('legacy-u2', 'second'), assistant('legacy-a2', 'reply')]
    const seed = restoreLegacySessionContextSnapshot({ invocationId: 'legacy-i1', turnId: 'legacy-t1', committedVersion: 1, messages: firstMessages })
    const restored = restoreSessionContext({ committedVersion: 2, events: [
      { eventId: 'seed', idempotencyKey: 'seed', invocationId: 'legacy-i1', turnId: 'legacy-t1', sequence: 1, schemaVersion: 1, kind: 'session-input-committed', payload: { messages: firstMessages } },
      { eventId: 'context', idempotencyKey: 'context', invocationId: 'legacy-i2', turnId: 'legacy-t2', sequence: 1, schemaVersion: 1, kind: 'invocation-context-committed', payload: { messages: secondMessages } },
      { eventId: 'done', idempotencyKey: 'done', invocationId: 'legacy-i2', turnId: 'legacy-t2', sequence: 2, schemaVersion: 1, kind: 'invocation-completed', payload: {} }
    ] })
    expect(seed.committed).toEqual(firstMessages)
    expect(restored.working).toEqual(secondMessages)
    expect(restored.committed).toEqual(secondMessages)
  })

  it('converts old canonical full snapshots into shared context events preserving tool pairing and compression replacement', () => {
    const snapshots = [
      { invocationId: 'old-i1', turnId: 'old-t1', sequence: 1, messages: [user('u1', 'one'), assistant('a1', 'answer')] },
      { invocationId: 'old-i2', turnId: 'old-t2', sequence: 1, messages: [user('u1', 'one'), assistant('a1', 'answer'), user('u2', 'two')] },
      { invocationId: 'old-i3', turnId: 'old-t3', sequence: 1, messages: [user('summary', 'compressed'), assistant('a3', 'new answer')] }
    ]
    const events = restoreLegacySessionContextEvents(snapshots.map((snapshot) => ({
      ...snapshot, kind: 'invocation-context-committed' as const
    })))
    expect(events.committed).toEqual(snapshots[2]!.messages)
    expect(events.working).toEqual(snapshots[2]!.messages)
    expect(events.committed.map((message) => 'id' in message ? message.id : undefined)).toEqual(['summary', 'a3'])
  })

  it.each([
    [{ kind: 'completed' as const }, 'working'],
    [{ kind: 'failed' as const }, 'failure'],
    [{ kind: 'cancelled' as const }, 'failure'],
    [{ kind: 'timed-out' as const }, 'failure'],
    [{ kind: 'park' as const }, 'park-baseline']
  ])('encodes %o as a finite protocol 2 selection without message bodies', (outcome, target) => {
    expect(createContextSelectionIntent(outcome)).toEqual({ contextProtocol: 2, target })
  })

  it('keeps the turn-entry park baseline immutable across compaction and failed tool facts', () => {
    const committed = [user('u0', 'earlier')]
    const restored = restoreSessionContext({ committedVersion: 4, events: [{ eventId: 'seed', idempotencyKey: 'seed', invocationId: 'inv-seed', turnId: 'turn-seed', sequence: 1, schemaVersion: 1, kind: 'session-input-committed', payload: { messages: committed } }] })
    const state = beginContextTurn(restored, {
      invocationId: 'inv-1', baseVersion: 4, inputMessages: [user('u1', 'current')],
      failureInputMessages: [], requiredUserMessage: { id: 'u1', message: user('u1', 'current') }, requestSystem: 'dynamic'
    })
    expect(state.committed).toEqual(committed)
    const compacted = [assistant('summary', 'checkpoint'), user('u1', 'current')]
    const afterFirstCompact = applyContextEvent(state, { kind: 'transcript-compacted', messages: compacted, requiredUserMessageId: 'u1' })
    const twiceCompacted = [assistant('summary-2', 'newer checkpoint'), user('u1', 'current')]
    const afterCompact = applyContextEvent(afterFirstCompact, { kind: 'transcript-compacted', messages: twiceCompacted, requiredUserMessageId: 'u1' })
    const afterFailureFact = applyContextEvent(afterCompact, { kind: 'model-response-committed', message: assistant('partial', 'partial output') })

    expect(selectContextCommit(afterFailureFact, { kind: 'park' }).messages).toEqual(committed)
    expect(selectContextCommit(afterFailureFact, { kind: 'failed' }).messages).toEqual(twiceCompacted)
    expect(selectContextCommit(afterFailureFact, { kind: 'completed' }).messages).toEqual([
      ...twiceCompacted, assistant('partial', 'partial output')
    ])
    expect(afterFailureFact.parkBaseline).toEqual(committed)
    expect(Object.isFrozen(afterFailureFact.parkBaseline)).toBe(true)
  })

  it('marks failure selection unavailable when required user cannot be matched without blocking park or success', () => {
    const state = beginContextTurn(restoreSessionContext({ committedVersion: 0, events: [] }), {
      invocationId: 'inv-2', baseVersion: 0, inputMessages: [user('u1', 'current')],
      failureInputMessages: [], requiredUserMessage: { id: 'u1', message: user('u1', 'current') }, requestSystem: ''
    })
    const invalid = applyContextEvent(state, { kind: 'transcript-compacted', messages: [assistant('summary', 'no required user')], requiredUserMessageId: 'u1' })

    expect(selectContextCommit(invalid, { kind: 'park' }).messages).toEqual([])
    expect(selectContextCommit(invalid, { kind: 'completed' }).messages).toEqual([assistant('summary', 'no required user')])
    expect(() => selectContextCommit(invalid, { kind: 'failed' })).toThrow('CONTEXT_FAILURE_SELECTION_UNAVAILABLE')
  })

  it('rejects a persisted failure cut that does not point at the exact required user', () => {
    const state = beginContextTurn(restoreSessionContext({ committedVersion: 0, events: [] }), {
      invocationId: 'inv-cut', baseVersion: 0, inputMessages: [user('u1', 'current')], failureInputMessages: [],
      requiredUserMessage: { id: 'u1', message: user('u1', 'current') }, requestSystem: ''
    })
    expect(() => applyContextEvent(state, { kind: 'transcript-compacted', messages: [user('different', 'other')], failureCut: 0 }))
      .toThrow('CONTEXT_FAILURE_CUT_INVALID')
  })

  it('pairs tool results in model call order and exposes immutable message state', () => {
    const state = beginContextTurn(restoreSessionContext({ committedVersion: 0, events: [] }), {
      invocationId: 'inv-tools', baseVersion: 0, inputMessages: [user('u1', 'run')], failureInputMessages: [], requestSystem: ''
    })
    const calls = [
      { id: 'call-a', name: 'a', input: {} },
      { id: 'call-b', name: 'b', input: {} }
    ]
    let next = applyContextEvent(state, { kind: 'model-response-committed', message: { role: 'assistant', content: '', toolCalls: calls } })
    for (const toolCall of calls) next = applyContextEvent(next, { kind: 'tool-call-started', toolCall })
    next = applyContextEvent(next, { kind: 'tool-call-finished', toolCallId: 'call-b', message: { role: 'tool', toolCallId: 'call-b', content: 'B', isError: false } })
    expect(next.working.at(-1)).toMatchObject({ role: 'assistant', toolCalls: calls })
    next = applyContextEvent(next, { kind: 'tool-call-finished', toolCallId: 'call-a', message: { role: 'tool', toolCallId: 'call-a', content: 'A', isError: false } })

    expect(next.working.slice(-2)).toEqual([
      { role: 'tool', toolCallId: 'call-a', content: 'A', isError: false },
      { role: 'tool', toolCallId: 'call-b', content: 'B', isError: false }
    ])
    expect(Object.isFrozen(next.working.at(-1))).toBe(true)
    expect('set' in next.pendingTools).toBe(false)
    next.pendingTools.forEach((_value, _key, exposed) => {
      expect('set' in exposed).toBe(false)
    })
    next.approvedToolCallIds.forEach((_value, _sameValue, exposed) => {
      expect('add' in exposed).toBe(false)
    })
  })

  it('adds the trusted approval note through the same pure message rule', () => {
    let state = beginContextTurn(restoreSessionContext({ committedVersion: 0, events: [] }), {
      invocationId: 'inv-approval', baseVersion: 0, inputMessages: [user('u1', 'run')], failureInputMessages: [], requestSystem: ''
    })
    const call = { id: 'approved-call', name: 'write', input: {} }
    state = applyContextEvent(state, { kind: 'model-response-committed', message: { role: 'assistant', content: '', toolCalls: [call] } })
    state = applyContextEvent(state, { kind: 'tool-call-started', toolCall: call })
    state = applyContextEvent(state, { kind: 'approval-resolved', toolCallId: call.id, approved: true })
    state = applyContextEvent(state, { kind: 'tool-call-finished', toolCallId: call.id, message: { role: 'tool', toolCallId: call.id, content: 'ok', isError: false } })
    state = applyContextEvent(state, { kind: 'model-response-committed', message: createApprovalSystemMessage() })

    expect(state.working.at(-1)).toEqual(createApprovalSystemMessage())
    expect('add' in state.approvedToolCallIds).toBe(false)
  })

  it('restores a legacy invocation stream through the same ordered context reducer', () => {
    const call = { id: 'restore-call', name: 'write', input: {} }
    const restored = restoreSessionContext({ committedVersion: 6, events: [
      { eventId: 'e1', idempotencyKey: 'e1', invocationId: 'inv-restore', turnId: 'turn', sequence: 1, schemaVersion: 1, kind: 'invocation-context-committed', payload: {
        messages: [user('u1', 'run')], requiredUserMessage: { id: 'u1', message: user('u1', 'run') }
      } },
      { eventId: 'e2', idempotencyKey: 'e2', invocationId: 'inv-restore', turnId: 'turn', sequence: 2, schemaVersion: 1, kind: 'model-response-committed', payload: {
        message: { role: 'assistant', content: '', toolCalls: [call] }
      } },
      { eventId: 'e3', idempotencyKey: 'e3', invocationId: 'inv-restore', turnId: 'turn', sequence: 3, schemaVersion: 1, kind: 'approval-resolved', payload: {
        toolCallId: call.id, approved: true, outcome: 'approved', answerer: 'user'
      } },
      { eventId: 'e4', idempotencyKey: 'e4', invocationId: 'inv-restore', turnId: 'turn', sequence: 4, schemaVersion: 1, kind: 'tool-call-finished', payload: {
        toolCallId: call.id, replayContent: 'done', result: 'private detail', isError: false
      } }
    ] })

    expect(restored.working).toEqual([
      user('u1', 'run'),
      { role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', toolCallId: call.id, content: 'done', isError: false },
      createApprovalSystemMessage()
    ])
    expect(selectContextCommit(restored, { kind: 'park' }).messages).toEqual([user('u1', 'run')])
  })

  it('restores an explicit manual-review replacement as the next committed context', () => {
    const reviewed = [user('reviewed-user', 'approved transcript'), assistant('reviewed-answer', 'reviewed')]
    const restored = restoreSessionContext({ committedVersion: 12, events: [{
      eventId: 'review-seed', idempotencyKey: 'review-seed', invocationId: 'inv-review', turnId: 'turn-review', sequence: 1, schemaVersion: 1,
      kind: 'invocation-context-committed', payload: { replacement: { reason: 'manual-review', messages: reviewed }, scope: { kind: 'session', sessionId: 's1' } }
    }] })

    expect(restored.committed).toEqual(reviewed)
    expect(selectContextCommit(restored, { kind: 'park' }).messages).toEqual(reviewed)
    expect(() => restoreSessionContext({ committedVersion: 1, events: [{
      eventId: 'unknown-review', idempotencyKey: 'unknown-review', invocationId: 'inv-review', turnId: 'turn-review', sequence: 1, schemaVersion: 1,
      kind: 'invocation-context-committed', payload: { replacement: { reason: 'guess-latest', messages: reviewed } }
    }] })).toThrow('CONTEXT_REPLACEMENT_REASON_UNKNOWN')
  })

  it('restores protocol 2 incremental inputs from a scoped committed base', () => {
    const prior = [user('prior', 'committed')]
    const current = user('current', 'incremental')
    const state = restoreSessionContext({ committedVersion: 8, events: [
      { eventId: 'seed', idempotencyKey: 'seed', invocationId: 'old', turnId: 'old', sequence: 1, schemaVersion: 1,
        kind: 'session-input-committed', payload: { messages: prior, scope: { kind: 'session', sessionId: 's1' } } },
      { eventId: 'protocol-2', idempotencyKey: 'protocol-2', invocationId: 'new', turnId: 'new', sequence: 2, schemaVersion: 1,
        kind: 'invocation-context-committed', payload: { contextProtocol: 2, baseVersion: 7, inputMessages: [current], failureInputMessages: [current], scope: { kind: 'session', sessionId: 's1' }, requiredUserMessage: { id: 'current', message: current } } }
    ] })

    expect(state.committed).toEqual(prior)
    expect(state.working).toEqual([...prior, current])
    expect(state.failure).toEqual([...prior, current])
  })

  it('rejects unknown context protocol and scope drift', () => {
    const makeEvent = (contextProtocol: number, sessionId: string) => ({ eventId: `e-${contextProtocol}-${sessionId}`, idempotencyKey: `e-${contextProtocol}-${sessionId}`, invocationId: 'inv', turnId: 'turn', sequence: 1, schemaVersion: 1,
      kind: 'invocation-context-committed' as const, payload: { contextProtocol, inputMessages: [], failureInputMessages: [], scope: { kind: 'session', sessionId } } })
    expect(() => restoreSessionContext({ committedVersion: 0, events: [makeEvent(3, 's1')] })).toThrow('CONTEXT_PROTOCOL_UNKNOWN')
    expect(() => restoreSessionContext({ committedVersion: 0, events: [makeEvent(2, 's1'), { ...makeEvent(2, 's2'), sequence: 2 }] })).toThrow('CONTEXT_SCOPE_MISMATCH')
  })

  it('promotes only the selected terminal context into the next restored turn baseline', () => {
    const input = user('turn-user', 'new request')
    const response = assistant('turn-answer', 'answer')
    const restored = restoreSessionContext({ committedVersion: 3, events: [
      { eventId: 'ctx', idempotencyKey: 'ctx', invocationId: 'inv-terminal', turnId: 'turn-terminal', sequence: 1, schemaVersion: 1,
        kind: 'invocation-context-committed', payload: { messages: [input], requiredUserMessage: { id: 'turn-user', message: input } } },
      { eventId: 'response', idempotencyKey: 'response', invocationId: 'inv-terminal', turnId: 'turn-terminal', sequence: 2, schemaVersion: 1,
        kind: 'model-response-committed', payload: { message: response } },
      { eventId: 'terminal', idempotencyKey: 'terminal', invocationId: 'inv-terminal', turnId: 'turn-terminal', sequence: 3, schemaVersion: 1,
        kind: 'invocation-completed', payload: { status: 'completed', contextSelection: { contextProtocol: 2, target: 'working', baseVersion: 2 } } }
    ] })

    expect(restored.committed).toEqual([input, response])
    const nextTurn = beginContextTurn(restored, { invocationId: 'next', baseVersion: 3, inputMessages: [user('next-user', 'next')], failureInputMessages: [], requestSystem: '' })
    expect(nextTurn.working).toEqual([input, response, user('next-user', 'next')])
  })

  it('keeps independently restored session scopes isolated', () => {
    const restore = (invocationId: string, sessionId: string, content: string) => restoreSessionContext({ committedVersion: 1, events: [{
      eventId: `${invocationId}-seed`, idempotencyKey: `${invocationId}-seed`, invocationId, turnId: `${invocationId}-turn`, sequence: 1, schemaVersion: 1,
      kind: 'session-input-committed', payload: { sessionId, messages: [user(`${sessionId}-user`, content)] }
    }] })
    const first = restore('inv-a', 'session-a', 'A')
    const second = restore('inv-b', 'session-b', 'B')

    expect(selectContextCommit(first, { kind: 'completed' }).messages).toEqual([user('session-a-user', 'A')])
    expect(selectContextCommit(second, { kind: 'completed' }).messages).toEqual([user('session-b-user', 'B')])
    expect(first.committed).not.toEqual(second.committed)
  })

  it('preserves image payloads, thinking signatures, and tool signatures through immutable selection', () => {
    const image = { role: 'user' as const, content: [{ type: 'image' as const, mimeType: 'image/png' as const, data: 'base64-payload' }] }
    const signedCall = { id: 'signed-call', name: 'lookup', input: {}, thoughtSignature: 'signature-bytes' }
    let state = beginContextTurn(restoreSessionContext({ committedVersion: 0, events: [] }), {
      invocationId: 'inv-media', baseVersion: 0, inputMessages: [image], failureInputMessages: [], requestSystem: ''
    })
    state = applyContextEvent(state, { kind: 'model-response-committed', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', thinkingSignature: 'thinking-signature' }], toolCalls: [signedCall] } })
    const selected = selectContextCommit(state, { kind: 'completed' }).messages

    expect(selected).toEqual([image, { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', thinkingSignature: 'thinking-signature' }], toolCalls: [signedCall] }])
    expect(Object.isFrozen((selected[1] as Extract<CanonicalModelMessage, { role: 'assistant' }>).toolCalls?.[0])).toBe(true)
  })
})
