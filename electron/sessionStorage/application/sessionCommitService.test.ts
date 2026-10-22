import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent, HistoryPort, SessionTranscriptCommitIntent } from '../../../packages/agent-sdk/src/history'
import { createSessionCommitService } from './sessionCommitService'

function event(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return { eventId: 'event-1', idempotencyKey: 'idem-1', invocationId: 'inv-1', turnId: 'turn-1', sequence: 1,
    schemaVersion: 1, kind: 'model-request-started', payload: {}, ...overrides }
}

function fakeHistory(): HistoryPort {
  return { appendBatch: vi.fn(async (_events, expectedVersion) => ({ version: expectedVersion + 1, duplicate: false })),
    read: vi.fn(async (invocationId) => ({ invocationId, version: 0, schemaVersion: 1, events: [] })) }
}

describe('SessionCommitService', () => {
  it('rejects acceptance identities outside the bound session, invocation, and turn before storage', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const participant = vi.fn((candidate) => candidate)
    const accepted = { sessionId: 'session-other', requestId: 'inv-1', turnId: 'turn-1', lane: 'desktop' as const,
      startToken: 'start', currentUserMessageId: 'user-1', transcriptVersion: 0, config: {} }

    expect(() => service.acceptTurn(accepted, participant)).toThrow('SESSION_COMMIT_ACCEPTANCE_IDENTITY_MISMATCH')
    expect(participant).not.toHaveBeenCalled()
  })

  it('delegates a matching first acceptance exactly once and returns the participant receipt', () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const accepted = { sessionId: 'session-1', requestId: 'inv-1', turnId: 'turn-1', lane: 'desktop' as const,
      startToken: 'start', currentUserMessageId: 'user-1', transcriptVersion: 0, config: {} }
    const participant = vi.fn((candidate) => ({ ...candidate, transcriptVersion: 1 }))

    expect(service.acceptTurn(accepted, participant)).toEqual({ ...accepted, transcriptVersion: 1 })
    expect(participant).toHaveBeenCalledExactlyOnceWith(accepted)
  })

  it('rejects a prepared-turn command outside the bound session and turn before storage', () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const participant = vi.fn()
    const command = {
      user: { id: 'user-1', sessionId: 'session-other', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const },
      assistant: { id: 'assistant-1', sessionId: 'session-other', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const },
      turn: { turnId: 'turn-1', requestId: 'inv-1', sessionId: 'session-other', assistantMessageId: 'assistant-1', state: 'prepared' }
    }

    expect(() => service.prepareTurn(command, participant)).toThrow('SESSION_COMMIT_PREPARE_IDENTITY_MISMATCH')
    expect(participant).not.toHaveBeenCalled()
  })

  it('rejects a queued-turn claim outside the bound session, request, and turn before storage', () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const participant = vi.fn()

    expect(() => service.claimQueuedTurn({ sessionId: 'session-1', requestId: 'inv-other', turnId: 'turn-1',
      userMessageId: 'user-1', assistantMessageId: 'assistant-1' }, participant))
      .toThrow('SESSION_COMMIT_CLAIM_IDENTITY_MISMATCH')
    expect(participant).not.toHaveBeenCalled()
  })

  it('delegates matching prepare and queued-claim commands exactly once', () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const preparedCommand = {
      user: { id: 'user-1', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const },
      assistant: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const },
      turn: { turnId: 'turn-1', requestId: 'inv-1', sessionId: 'session-1', assistantMessageId: 'assistant-1', state: 'prepared' }
    }
    const prepareParticipant = vi.fn(() => ({ user: {} as never, assistant: {} as never }))
    const claimCommand = { sessionId: 'session-1', requestId: 'inv-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' }
    const claimParticipant = vi.fn(() => ({ user: {} as never, assistant: {} as never }))

    expect(service.prepareTurn(preparedCommand, prepareParticipant)).toEqual({ user: {}, assistant: {} })
    expect(service.claimQueuedTurn(claimCommand, claimParticipant)).toEqual({ user: {}, assistant: {} })
    expect(prepareParticipant).toHaveBeenCalledExactlyOnceWith(preparedCommand)
    expect(claimParticipant).toHaveBeenCalledExactlyOnceWith(claimCommand)
  })

  it('commits a canonical body revision as a bound context replacement and completion pair', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })

    await expect(service.reviseCanonicalMessage({
      messages: [{ id: 'message-1', role: 'user', content: 'edited', timestamp: 10 }],
      canonicalWriteFence: { sessionGeneration: 'generation-1', sessionSeq: 4, commitOrder: 2,
        watermarkEventId: 'event-4', watermarkInvocationId: 'inv-before' },
      completedAt: 20
    }, 0)).resolves.toEqual({ version: 1, duplicate: false })

    const [events, expectedVersion] = vi.mocked(history.appendBatch).mock.calls[0]!
    expect(expectedVersion).toBe(0)
    expect(events).toHaveLength(2)
    expect(events.map((item) => item.kind)).toEqual(['invocation-context-committed', 'invocation-completed'])
    expect(events.map(({ invocationId, turnId, sequence }) => ({ invocationId, turnId, sequence }))).toEqual([
      { invocationId: 'inv-1', turnId: 'turn-1', sequence: 1 },
      { invocationId: 'inv-1', turnId: 'turn-1', sequence: 2 }
    ])
    expect(events[0]?.payload).toMatchObject({
      messages: [{ id: 'message-1', role: 'user', content: 'edited', timestamp: 10 }],
      canonicalWriteFence: { sessionGeneration: 'generation-1', sessionSeq: 4, commitOrder: 2,
        watermarkEventId: 'event-4', watermarkInvocationId: 'inv-before' }
    })
  })

  it('rejects events outside its bound invocation and turn before storage', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })

    await expect(service.commitHistory([event({ invocationId: 'inv-other' })], 0)).rejects.toThrow('SESSION_COMMIT_EVENT_IDENTITY_MISMATCH')
    await expect(service.commitHistory([event({ turnId: 'turn-other' })], 0)).rejects.toThrow('SESSION_COMMIT_EVENT_IDENTITY_MISMATCH')
    expect(history.appendBatch).not.toHaveBeenCalled()
  })

  it('requires terminal intent and execution lease to match its bound session and turn', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const intent: SessionTranscriptCommitIntent = { sessionId: 'session-other', baseVersion: 0, outcome: 'completed', messages: [],
      executionLease: { sessionId: 'session-1', turnId: 'turn-1', ownerId: 'owner-1', generation: 1 } }

    await expect(service.commitTerminal([event()], 0, intent)).rejects.toThrow('SESSION_COMMIT_SESSION_MISMATCH')
    await expect(service.commitTerminal([event()], 0, { ...intent, sessionId: 'session-1', executionLease: {
      ...intent.executionLease!, turnId: 'turn-other'
    } })).rejects.toThrow('SESSION_COMMIT_LEASE_MISMATCH')
    expect(history.appendBatch).not.toHaveBeenCalled()
  })

  it('delegates valid history and terminal commits through the same bound port', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })
    const intent: SessionTranscriptCommitIntent = { sessionId: 'session-1', baseVersion: 0, outcome: 'completed', messages: [],
      executionLease: { sessionId: 'session-1', turnId: 'turn-1', ownerId: 'owner-1', generation: 1 } }

    await expect(service.commitHistory([event()], 0)).resolves.toEqual({ version: 1, duplicate: false })
    await expect(service.commitTerminal([event({ eventId: 'event-2', sequence: 2 })], 1, intent)).resolves.toEqual({ version: 2, duplicate: false })
    expect(history.appendBatch).toHaveBeenNthCalledWith(2, [event({ eventId: 'event-2', sequence: 2 })], 1, intent)
  })

  it('rejects empty event batches before the storage participant is touched', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })

    await expect(service.commitHistory([], 0)).rejects.toThrow('SESSION_COMMIT_EVENTS_REQUIRED')
    await expect(service.commitTerminal([], 0, { sessionId: 'session-1', baseVersion: 0, outcome: 'completed', messages: [] })).rejects.toThrow('SESSION_COMMIT_EVENTS_REQUIRED')
    expect(history.appendBatch).not.toHaveBeenCalled()
  })

  it('rejects malformed event identity metadata before the storage participant is touched', async () => {
    const history = fakeHistory()
    const service = createSessionCommitService({ sessionId: 'session-1', invocationId: 'inv-1', turnId: 'turn-1', history })

    await expect(service.commitHistory([event({ sequence: 0 })], 0)).rejects.toThrow('SESSION_COMMIT_EVENT_IDENTITY_MISMATCH')
    await expect(service.commitHistory([event({ schemaVersion: 0 })], 0)).rejects.toThrow('SESSION_COMMIT_EVENT_IDENTITY_MISMATCH')
    await expect(service.commitHistory([event({ idempotencyKey: '  ' })], 0)).rejects.toThrow('SESSION_COMMIT_EVENT_IDENTITY_MISMATCH')
    expect(history.appendBatch).not.toHaveBeenCalled()
  })
})
