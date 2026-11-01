import { describe, expect, it } from 'vitest'
import { advanceHistoryTransitionState, createHistoryTransitionState, HistoryBatchError, HistoryIdempotencyConflict, InvocationHistoryWriter, MemoryHistory, HistorySequenceConflict, rebuildInvocationStates, validateHistoryTransition, type HistoryEvent } from '../src/history'

const event = (eventId: string, sequence: number, kind: HistoryEvent['kind'] = 'approval-updated', payload: unknown = { eventId }): HistoryEvent => ({
  eventId, idempotencyKey: `idem:${eventId}`, invocationId: 'inv-1', turnId: 'turn-1', sequence, schemaVersion: 1, kind, payload
})

describe('History Port semantics', () => {
  it('reduces prior events into an immutable transition state and advances only the incoming batch', () => {
    const started = event('state-1', 1, 'tool-call-started', { toolCallId: 'call-a' })
    const state = createHistoryTransitionState([started])
    expect(state).toMatchObject({
      invocationId: 'inv-1',
      turnId: 'turn-1',
      terminalKind: null,
      pendingToolCalls: ['call-a'],
      pendingApprovals: [],
      approvalIdentityByPendingId: [],
      deferredTodoIds: [],
      unconsumedRetryApprovals: []
    })
    const next = advanceHistoryTransitionState(state, [event('state-2', 2, 'tool-call-finished', { toolCallId: 'call-a' })])
    expect(next.pendingToolCalls).toEqual([])
    expect(state.pendingToolCalls).toEqual(['call-a'])
  })

  it('carries one-time unknown retry approvals across batches and records terminal state', () => {
    const approval = event('retry-approval', 1, 'unknown-effect-retry-approved', {
      targetInvocationId: 'inv-1', unknownEffectId: 'origin:call', toolName: 'write_file', inputHash: 'a'.repeat(64), approvedAt: 10
    })
    const state = createHistoryTransitionState([approval])
    const consumed = advanceHistoryTransitionState(state, [
      event('retry-consumed', 2, 'unknown-effect-retry-consumed', { targetInvocationId: 'inv-1', approvalEventId: approval.eventId, consumedAt: 11 }),
      event('retry-started', 3, 'tool-call-started', { toolCallId: 'new-call', toolName: 'write_file', inputHash: 'a'.repeat(64) })
    ])
    const settled = advanceHistoryTransitionState(consumed, [event('retry-finished', 4, 'tool-call-finished', { toolCallId: 'new-call' })])
    const terminal = advanceHistoryTransitionState(settled, [event('terminal', 5, 'invocation-failed', { status: 'failed' })])
    expect(terminal.terminalKind).toBe('invocation-failed')
    expect(terminal.unconsumedRetryApprovals).toEqual([])
    expect(() => advanceHistoryTransitionState(terminal, [event('after-terminal', 5)])).toThrow(HistoryBatchError)
  })

  it('matches full-prefix reduction after every fixed-seed randomized event batch', () => {
    let seed = 20261031
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000 }
    const events: HistoryEvent[] = []
    let state = createHistoryTransitionState([])
    let sequence = 0
    const pendingTools: string[] = []
    const pendingApprovals: string[] = []
    const append = (batch: HistoryEvent[]) => {
      state = advanceHistoryTransitionState(state, batch)
      events.push(...batch)
      expect(state).toEqual(createHistoryTransitionState(events))
      for (const [kind, payload] of [
        ['approval-resolved', { approvalId: 'missing-approval', approved: true }],
        ['unknown-effect-retry-consumed', { targetInvocationId: 'inv-1', approvalEventId: 'missing-retry', consumedAt: sequence + 1 }]
      ] as const) {
        const invalid = event(`invalid-${events.length}-${kind}`, events.length + 1, kind, payload)
        const capture = (operation: () => unknown) => {
          try { operation(); return undefined } catch (error) { return error instanceof Error ? error.message : String(error) }
        }
        expect(capture(() => advanceHistoryTransitionState(state, [invalid])))
          .toEqual(capture(() => validateHistoryTransition(events, [invalid])))
        expect(capture(() => advanceHistoryTransitionState(state, [invalid]))).toBeTruthy()
      }
    }
    const next = (kind: HistoryEvent['kind'], payload: unknown, prefix: string): HistoryEvent =>
      event(`${prefix}-${++sequence}`, sequence, kind, payload)

    for (let step = 0; step < 48; step += 1) {
      const action = Math.floor(random() * 3)
      if (action === 0 && pendingTools.length > 0) {
        const index = Math.floor(random() * pendingTools.length)
        const [toolCallId] = pendingTools.splice(index, 1)
        append([next('tool-call-finished', { toolCallId }, 'tool-finished')])
      } else if (action === 1 && pendingApprovals.length > 0) {
        const index = Math.floor(random() * pendingApprovals.length)
        const [approvalId] = pendingApprovals.splice(index, 1)
        append([next('approval-resolved', { approvalId, approved: true, outcome: 'approved', settledAt: sequence + 1 }, 'approval-resolved')])
      } else if (action === 2) {
        const inputHash = (step + 1).toString(16).padStart(64, '0')
        const approval = next('unknown-effect-retry-approved', {
          targetInvocationId: 'inv-1', unknownEffectId: `unknown-${step}`, toolName: 'write_file', inputHash, approvedAt: step + 1
        }, 'retry-approved')
        append([approval])
        const toolCallId = `retry-call-${step}`
        append([
          next('unknown-effect-retry-consumed', { targetInvocationId: 'inv-1', approvalEventId: approval.eventId, consumedAt: step + 2 }, 'retry-consumed'),
          next('tool-call-started', { toolCallId, toolName: 'write_file', inputHash }, 'retry-started')
        ])
        pendingTools.push(toolCallId)
      } else if (pendingApprovals.length === 0 || random() < 0.5) {
        const approvalId = `approval-${step}`
        append([next('approval-waiting', { approvalId, answerer: 'user', reasonCode: 'fixed-seed', requestedAt: step + 1 }, 'approval-waiting')])
        pendingApprovals.push(approvalId)
      } else {
        const toolCallId = `tool-${step}`
        append([next('tool-call-started', { toolCallId }, 'tool-started')])
        pendingTools.push(toolCallId)
      }
    }
    for (const toolCallId of pendingTools) append([next('tool-call-finished', { toolCallId }, 'tool-finalized')])
    for (const approvalId of pendingApprovals) append([next('approval-resolved', { approvalId, approved: true }, 'approval-finalized')])
    append([next('invocation-completed', { status: 'completed' }, 'terminal')])

    const parkedEvents = [
      event('park-waiting', 1, 'approval-waiting', { toolCallId: 'park-call', approvalId: 'approval-identity', answerer: 'agent', reasonCode: 'defer', requestedAt: 1 }),
      event('park-deferred', 2, 'approval-deferred', { toolCallId: 'park-call', approvalId: 'approval-identity', todoId: 'todo-1', invocationId: 'inv-1', checkpointId: 'checkpoint-1', workflowRevision: 1 }),
      event('park-terminal', 3, 'invocation-parked', { status: 'parked', reason: 'deferred-approval', todoId: 'todo-1' })
    ]
    let parkedState = createHistoryTransitionState([])
    for (const parkedEvent of parkedEvents) {
      parkedState = advanceHistoryTransitionState(parkedState, [parkedEvent])
      expect(parkedState).toEqual(createHistoryTransitionState(parkedEvents.slice(0, parkedEvent.sequence)))
    }
  })

  it('keeps compact-state rejection equivalent to the full validator across pending obligations', () => {
    const retry = event('retry-approved', 1, 'unknown-effect-retry-approved', {
      targetInvocationId: 'inv-1', unknownEffectId: 'unknown-1', toolName: 'write_file', inputHash: 'a'.repeat(64), approvedAt: 1
    })
    const cases: Array<{ name: string; previous: HistoryEvent[]; incoming: HistoryEvent[] }> = [
      { name: 'terminal payload/status', previous: [], incoming: [event('bad-terminal', 1, 'invocation-completed', { status: 'failed' })] },
      { name: 'approval outcome/boolean', previous: [], incoming: [event('bad-outcome', 1, 'approval-resolved', { approvalId: 'a', approved: false, outcome: 'approved' })] },
      {
        name: 'approval identity',
        previous: [event('waiting', 1, 'approval-waiting', { toolCallId: 'call-a', approvalId: 'approval-a', answerer: 'user', reasonCode: 'test', requestedAt: 1 })],
        incoming: [event('resolved', 2, 'approval-resolved', { toolCallId: 'call-a', approvalId: 'approval-b', approved: true })]
      },
      {
        name: 'deferred approval binding',
        previous: [event('waiting', 1, 'approval-waiting', { toolCallId: 'call-a', approvalId: 'approval-a', answerer: 'agent', reasonCode: 'test', requestedAt: 1 })],
        incoming: [event('deferred', 2, 'approval-deferred', { toolCallId: 'call-a', approvalId: 'approval-a', todoId: 'todo-a', invocationId: 'inv-1', checkpointId: '', workflowRevision: 1 })]
      },
      { name: 'park requires settled deferred approval', previous: [], incoming: [event('parked', 1, 'invocation-parked', { status: 'parked', reason: 'deferred-approval', todoId: 'todo-missing' })] },
      {
        name: 'terminal cannot leave a tool pending',
        previous: [event('started', 1, 'tool-call-started', { toolCallId: 'call-a' })],
        incoming: [event('completed', 2, 'invocation-completed', { status: 'completed' })]
      },
      {
        name: 'retry consumption must match the approved tool input',
        previous: [retry],
        incoming: [
          event('consumed', 2, 'unknown-effect-retry-consumed', { targetInvocationId: 'inv-1', approvalEventId: retry.eventId, consumedAt: 2 }),
          event('started', 3, 'tool-call-started', { toolCallId: 'call-a', toolName: 'write_file', inputHash: 'b'.repeat(64) })
        ]
      },
      {
        name: 'retry approval is one-time',
        previous: [retry],
        incoming: [
          event('consumed', 2, 'unknown-effect-retry-consumed', { targetInvocationId: 'inv-1', approvalEventId: retry.eventId, consumedAt: 2 }),
          event('started', 3, 'tool-call-started', { toolCallId: 'call-a', toolName: 'write_file', inputHash: 'a'.repeat(64) }),
          event('consumed-again', 4, 'unknown-effect-retry-consumed', { targetInvocationId: 'inv-1', approvalEventId: retry.eventId, consumedAt: 4 }),
          event('started-again', 5, 'tool-call-started', { toolCallId: 'call-b', toolName: 'write_file', inputHash: 'a'.repeat(64) })
        ]
      },
      { name: 'unsupported context protocol', previous: [], incoming: [event('context', 1, 'invocation-context-committed', { contextProtocol: 3 })] }
    ]
    const capture = (operation: () => unknown) => {
      try { operation(); return undefined } catch (error) { return error instanceof Error ? error.message : String(error) }
    }
    for (const testCase of cases) {
      const state = createHistoryTransitionState(testCase.previous)
      expect(capture(() => advanceHistoryTransitionState(state, testCase.incoming)), testCase.name)
        .toEqual(capture(() => validateHistoryTransition(testCase.previous, testCase.incoming)))
      expect(capture(() => advanceHistoryTransitionState(state, testCase.incoming)), testCase.name).toBeTruthy()
    }
  })

  it('atomically consumes a one-time unknown retry with a matching tool start and rejects reuse', async () => {
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-1', turnId: 'turn-1' })
    await writer.append([{ kind: 'invocation-context-committed', payload: { messages: [] } }])
    const inputHash = 'a'.repeat(64)
    await writer.append([{ kind: 'unknown-effect-retry-approved', payload: {
      targetInvocationId: 'inv-1', unknownEffectId: 'origin:call', toolName: 'write_file', inputHash, approvedAt: 10
    } }])
    const approvalEventId = (await history.read('inv-1')).events.at(-1)!.eventId
    const pairedDispatch = [
      { kind: 'unknown-effect-retry-consumed' as const, payload: { targetInvocationId: 'inv-1', approvalEventId, consumedAt: 11 } },
      { kind: 'tool-call-started' as const, payload: { toolCallId: 'new-call', toolName: 'write_file', inputHash, executorEntry: 'unknown' } }
    ]
    await writer.append(pairedDispatch)
    await expect(writer.append(pairedDispatch)).rejects.toBeInstanceOf(HistoryBatchError)
  })

  it('serializes concurrent event producers into contiguous idempotent batches', async () => {
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-1', turnId: 'turn-1' })
    const results = await Promise.all([
      writer.append([{ kind: 'tool-call-started', payload: { toolCallId: 'a' } }]),
      writer.append([{ kind: 'tool-call-started', payload: { toolCallId: 'b' } }]),
      writer.append([{ kind: 'tool-call-finished', payload: { toolCallId: 'a' } }])
    ])
    expect(results.map(({ version }) => version)).toEqual([1, 2, 3])
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 3,
      events: [
        expect.objectContaining({ sequence: 1, payload: { toolCallId: 'a' } }),
        expect.objectContaining({ sequence: 2, payload: { toolCallId: 'b' } }),
        expect.objectContaining({ sequence: 3, kind: 'tool-call-finished', payload: { toolCallId: 'a' } })
      ]
    })
  })

  it('records the legacy adapter full-history read baseline before optimization', async () => {
    const backing = new MemoryHistory()
    const snapshotsRead: number[] = []
    const history = {
      read: async (invocationId: string) => {
        const snapshot = await backing.read(invocationId)
        snapshotsRead.push(snapshot.events.length)
        return snapshot
      },
      appendBatch: (...args: Parameters<MemoryHistory['appendBatch']>) => backing.appendBatch(...args)
    }
    const writer = new InvocationHistoryWriter(history, { invocationId: 'baseline-read-count', turnId: 'baseline-turn' })

    await writer.append([{ kind: 'approval-updated', payload: { revision: 1 } }])
    await writer.append([{ kind: 'approval-updated', payload: { revision: 2 } }])
    await writer.append([{ kind: 'approval-updated', payload: { revision: 3 } }])

    expect(snapshotsRead).toEqual([0])
  })

  it('prepares cold persisted history transition state once before the first append', async () => {
    const backing = new MemoryHistory()
    const prepared: string[] = []
    const history = {
      read: (invocationId: string) => backing.read(invocationId),
      appendBatch: (...args: Parameters<MemoryHistory['appendBatch']>) => backing.appendBatch(...args),
      prepareTransitionState: async (snapshot: { invocationId: string }) => { prepared.push(snapshot.invocationId) }
    }
    const writer = new InvocationHistoryWriter(history, { invocationId: 'cold-prepare', turnId: 'cold-turn' })
    await writer.append([{ kind: 'approval-updated', payload: {} }])
    await writer.append([{ kind: 'approval-updated', payload: {} }])
    expect(prepared).toEqual(['cold-prepare'])
  })

  it('uses writer version for consecutive appends without rereading event payloads', async () => {
    const backing = new MemoryHistory()
    let reads = 0
    const history = {
      read: async (invocationId: string) => { reads += 1; return backing.read(invocationId) },
      appendBatch: (...args: Parameters<MemoryHistory['appendBatch']>) => backing.appendBatch(...args)
    }
    const writer = new InvocationHistoryWriter(history, { invocationId: 'warm-writer', turnId: 'warm-turn' })

    await writer.append([{ kind: 'approval-updated', payload: { revision: 1 } }])
    await writer.append([{ kind: 'approval-updated', payload: { revision: 2 } }])
    await writer.append([{ kind: 'approval-updated', payload: { revision: 3 } }])

    expect(reads).toBe(1)
  })

  it('checks an exact expected version inside the shared writer queue', async () => {
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-1', turnId: 'turn-1' })
    const first = writer.appendAtVersion([{ kind: 'transcript-compacted', payload: { messages: [] } }], 0)
    const second = writer.appendAtVersion([{ kind: 'transcript-compacted', payload: { messages: [] } }], 0)

    await expect(first).resolves.toMatchObject({ version: 1 })
    await expect(second).rejects.toMatchObject({ code: 'version-conflict', expected: 0, actual: 1 })
    await expect(writer.appendAtVersion([{ kind: 'transcript-compacted', payload: { messages: [] } }], 1)).resolves.toMatchObject({ version: 2 })
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 2, events: [
      expect.objectContaining({ sequence: 1, kind: 'transcript-compacted' }),
      expect.objectContaining({ sequence: 2, kind: 'transcript-compacted' })
    ] })
  })

  it('waits for queued history writes before capturing the current version', async () => {
    const backing = new MemoryHistory()
    let releaseAppend!: () => void
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve })
    const history = {
      read: (invocationId: string) => backing.read(invocationId),
      appendBatch: async (...args: Parameters<MemoryHistory['appendBatch']>) => {
        await appendGate
        return backing.appendBatch(...args)
      }
    }
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-1', turnId: 'turn-1' })
    const queued = writer.append([{ kind: 'tool-call-started', payload: { toolCallId: 'queued' } }])
    let captured = false
    const current = writer.currentOrPersistedVersion().then((version) => { captured = true; return version })
    await Promise.resolve()
    expect(captured).toBe(false)
    releaseAppend()
    await queued
    await expect(current).resolves.toBe(1)
  })

  it('atomically appends one step batch with invocation sequence and schema version', async () => {
    const history = new MemoryHistory()
    const events = [event('e1', 1, 'tool-call-started'), event('e2', 2, 'tool-call-finished')]
    await expect(history.appendBatch(events, 0)).resolves.toEqual({ version: 2, duplicate: false })
    await expect(history.read('inv-1')).resolves.toEqual({ invocationId: 'inv-1', version: 2, schemaVersion: 1, events })
  })

  it('accepts provider attempt result facts as a first-class history event', async () => {
    const history = new MemoryHistory()
    const result = event('provider-attempt-1', 1, 'provider-attempt-result', {
      requestId: 'inv-1:round:1', attempt: 1, physical: true,
      attemptSource: { kind: 'initial' }, outcome: 'failed', errorClass: 'PROVIDER_NETWORK_ERROR',
      usage: { status: 'unreported' }
    })
    await expect(history.appendBatch([result], 0)).resolves.toEqual({ version: 1, duplicate: false })
    await expect(history.read('inv-1')).resolves.toMatchObject({ events: [result] })
  })

  it('deduplicates a replayed provider attempt result by request and attempt', async () => {
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-1', turnId: 'turn-1' })
    const payload = {
      requestId: 'inv-1:round:2', attempt: 3, physical: true,
      attemptSource: { kind: 'recovery', recoveryKind: 'transient' }, outcome: 'failed',
      errorClass: 'PROVIDER_SERVER_ERROR', usage: { status: 'unreported' }
    }
    await writer.append([{ kind: 'provider-attempt-result', payload }])
    const replay = await writer.append([{ kind: 'provider-attempt-result', payload }])
    expect(replay.duplicate).toBe(true)
    expect((await history.read('inv-1')).events).toHaveLength(1)
  })

  it('replays a matching idempotency batch without duplicating events', async () => {
    const history = new MemoryHistory()
    const events = [event('e1', 1), event('e2', 2)]
    await history.appendBatch(events, 0)
    await expect(history.appendBatch(events, 0)).resolves.toEqual({ version: 2, duplicate: true })
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 2, events })
  })

  it('rejects an idempotency key reused for different facts', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([event('e1', 1)], 0)
    await expect(history.appendBatch([event('e1', 1, 'approval-updated', { eventId: 'changed' })], 0)).rejects.toBeInstanceOf(HistoryIdempotencyConflict)
  })

  it('rejects a client event id reused under a different idempotency key', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([event('e1', 1)], 0)
    await expect(history.appendBatch([{ ...event('e1', 2), idempotencyKey: 'other-key' }], 1)).rejects.toBeInstanceOf(HistoryIdempotencyConflict)
  })

  it('rejects gaps and stale versions instead of silently overwriting facts', async () => {
    const history = new MemoryHistory()
    await expect(history.appendBatch([event('e2', 2)], 0)).rejects.toBeInstanceOf(HistorySequenceConflict)
    await history.appendBatch([event('e1', 1)], 0)
    await expect(history.appendBatch([event('e2', 2)], 0)).rejects.toMatchObject({ code: 'version-conflict' })
  })

  it('keeps one turn identity for the lifetime of an invocation stream', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([event('turn-owner', 1)], 0)

    await expect(history.appendBatch([{ ...event('wrong-turn', 2), turnId: 'another-turn' }], 1))
      .rejects.toThrow(/invocation.*turn/i)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ turnId: 'turn-1' })] })
  })

  it('rejects a completed terminal in the same batch as an unresolved tool proposal', async () => {
    const history = new MemoryHistory()
    await expect(history.appendBatch([
      event('proposal', 1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'call-1' }] } }),
      event('completed', 2, 'invocation-completed', { status: 'completed' })
    ], 0)).rejects.toThrow(/pending tool calls/)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 0 })
  })

  it('rejects a terminal in a later batch while an earlier tool or approval is still pending', async () => {
    const toolHistory = new MemoryHistory()
    await toolHistory.appendBatch([event('proposal', 1, 'model-response-committed', {
      message: { role: 'assistant', toolCalls: [{ id: 'call-1' }] }
    })], 0)
    await expect(toolHistory.appendBatch([event('completed', 2, 'invocation-completed', { status: 'completed' })], 1))
      .rejects.toThrow(/pending tool calls or approvals/)
    await expect(toolHistory.read('inv-1')).resolves.toMatchObject({ version: 1 })

    const approvalHistory = new MemoryHistory()
    await approvalHistory.appendBatch([event('approval-waiting', 1, 'approval-waiting', { toolCallId: 'call-approval' })], 0)
    await expect(approvalHistory.appendBatch([event('completed', 2, 'invocation-completed', { status: 'completed' })], 1))
      .rejects.toThrow(/pending tool calls or approvals/)
    await expect(approvalHistory.read('inv-1')).resolves.toMatchObject({ version: 1 })

    const dispatchHistory = new MemoryHistory()
    await dispatchHistory.appendBatch([event('started', 1, 'tool-call-started', { toolCallId: 'call-started' })], 0)
    await expect(dispatchHistory.appendBatch([event('completed', 2, 'invocation-completed', { status: 'completed' })], 1))
      .rejects.toThrow(/pending tool calls or approvals/)
    await expect(dispatchHistory.read('inv-1')).resolves.toMatchObject({ version: 1 })
  })

  it('allows an interrupted terminal to preserve unresolved dispatch and approval work', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([
      event('started', 1, 'tool-call-started', { toolCallId: 'call-started' }),
      event('approval', 2, 'approval-waiting', { toolCallId: 'call-approval' })
    ], 0)

    await expect(history.appendBatch([event('interrupted', 3, 'invocation-interrupted', {
      status: 'interrupted', reason: 'process-restart'
    })], 2)).resolves.toMatchObject({ version: 3, duplicate: false })
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 3,
      events: expect.arrayContaining([expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })])
    })
  })

  it('rejects duplicate approval waits and resolutions without a matching wait', async () => {
    const duplicate = new MemoryHistory()
    await expect(duplicate.appendBatch([
      event('wait-1', 1, 'approval-waiting', { toolCallId: 'call-1' }),
      event('wait-2', 2, 'approval-waiting', { toolCallId: 'call-1' })
    ], 0)).rejects.toThrow(/approval.*already pending/i)
    await expect(duplicate.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })

    const orphanResolution = new MemoryHistory()
    await expect(orphanResolution.appendBatch([
      event('resolved-without-wait', 1, 'approval-resolved', { toolCallId: 'call-unknown', approved: true })
    ], 0)).rejects.toThrow(/approval.*not pending/i)
    await expect(orphanResolution.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })

    const missingOutcome = new MemoryHistory()
    await expect(missingOutcome.appendBatch([
      event('wait-for-outcome', 1, 'approval-waiting', { toolCallId: 'call-outcome' }),
      event('resolve-without-outcome', 2, 'approval-resolved', { toolCallId: 'call-outcome' })
    ], 0)).rejects.toThrow(/approval resolution.*approved/i)
    await expect(missingOutcome.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })

    const conflictingOutcome = new MemoryHistory()
    await expect(conflictingOutcome.appendBatch([
      event('wait-for-conflict', 1, 'approval-waiting', { toolCallId: 'call-conflict', approvalId: 'approval-conflict', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }),
      event('resolve-conflict', 2, 'approval-resolved', { toolCallId: 'call-conflict', approvalId: 'approval-conflict', approved: false, outcome: 'approved', settledAt: 2 })
    ], 0)).rejects.toThrow(/approval outcome.*approved/i)
    await expect(conflictingOutcome.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })

    const duplicateResolution = new MemoryHistory()
    await expect(duplicateResolution.appendBatch([
      event('wait-for-duplicate-resolution', 1, 'approval-waiting', { toolCallId: 'call-duplicate-resolution', approvalId: 'approval-duplicate-resolution', answerer: 'user', reasonCode: 'confirm', requestedAt: 1 }),
      event('first-resolution', 2, 'approval-resolved', { toolCallId: 'call-duplicate-resolution', approvalId: 'approval-duplicate-resolution', approved: false, outcome: 'denied', settledAt: 2 }),
      event('second-resolution', 3, 'approval-resolved', { toolCallId: 'call-duplicate-resolution', approvalId: 'approval-duplicate-resolution', approved: true, outcome: 'approved', settledAt: 3 })
    ], 0)).rejects.toThrow(/approval.*not pending/i)
    await expect(duplicateResolution.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('allows a terminal after the pending tool call has a result', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([event('proposal', 1, 'model-response-committed', {
      message: { role: 'assistant', toolCalls: [{ id: 'call-1' }] }
    })], 0)
    await history.appendBatch([
      event('started', 2, 'tool-call-started', { toolCallId: 'call-1' }),
      event('finished', 3, 'tool-call-finished', { toolCallId: 'call-1' }),
      event('completed', 4, 'invocation-completed', { status: 'completed' })
    ], 1)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 4 })
  })

  it('settles both a proposed tool call and its richer approval lifecycle before invocation completion', async () => {
    const history = new MemoryHistory()
    const toolCallId = 'legacy-call'
    const approvalId = 'inv-1:approval:legacy-call'
    await history.appendBatch([
      event('proposal', 1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: toolCallId }] } }),
      event('wait', 2, 'approval-waiting', { toolCallId, approvalId, answerer: 'user', reasonCode: 'confirm', requestedAt: 10 })
    ], 0)
    await history.appendBatch([
      event('resolution', 3, 'approval-resolved', { toolCallId, approvalId, approved: false, outcome: 'denied', settledAt: 11 }),
      event('not-dispatched', 4, 'tool-call-not-dispatched', { toolCallId, reason: 'confirm_denied' }),
      event('completed', 5, 'invocation-completed', { status: 'completed' })
    ], 2)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 5 })
  })

  it('rejects payloads that cannot survive canonical JSON persistence', async () => {
    const history = new MemoryHistory()
    await expect(history.appendBatch([{ ...event('e1', 1), payload: undefined }], 0)).rejects.toBeInstanceOf(HistoryBatchError)
    await expect(history.appendBatch([event('e2', 1, 'approval-updated', { sessionLedger: { location: undefined } })], 0))
      .rejects.toThrow(/payload\.sessionLedger\.location/)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(history.appendBatch([event('e3', 1, 'approval-updated', cyclic)], 0)).rejects.toBeInstanceOf(HistoryBatchError)
  })

  it('rejects payload object shapes that JSON would invoke or silently normalize', async () => {
    const history = new MemoryHistory()
    let getterCalls = 0
    const accessorPayload = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { getterCalls += 1; return 'value' }
    })
    const shared = { value: 'shared' }
    const sparse = new Array(1)

    await expect(history.appendBatch([event('accessor', 1, 'approval-updated', accessorPayload)], 0)).rejects.toBeInstanceOf(HistoryBatchError)
    await expect(history.appendBatch([event('shared', 1, 'approval-updated', { left: shared, right: shared })], 0)).resolves.toMatchObject({ version: 1 })
    await expect(history.appendBatch([event('sparse', 2, 'approval-updated', { values: sparse })], 1)).rejects.toBeInstanceOf(HistoryBatchError)
    expect(getterCalls).toBe(0)
  })

  it('isolates sequence/version by invocation and rebuilds parked invocations as interrupted', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([event('park-1', 1, 'invocation-parked', { invocationId: 'inv-1' })], 0)
    await expect(history.appendBatch([event('after-park', 2, 'approval-updated', { late: true })], 1))
      .rejects.toThrow(/terminal invocation event/i)
    const other = { ...event('other-1', 1), invocationId: 'inv-2', turnId: 'turn-2' }
    await history.appendBatch([other], 0)
    expect(await history.read('inv-2')).toMatchObject({ version: 1, events: [other] })
    const rebuilt = rebuildInvocationStates(await history.read('inv-1'))
    expect(rebuilt.get('inv-1')).toMatchObject({ state: 'interrupted', invocationId: 'inv-1' })
  })

  it('requires a deferred approval to be settled before a typed parked terminal is committed', async () => {
    const history = new MemoryHistory()
    await expect(history.appendBatch([event('bad-park-terminal', 1, 'invocation-parked', { status: 'parked', reason: 'deferred-approval' })], 0))
      .rejects.toThrow(/parked invocation payload/i)
    await history.appendBatch([
      event('park-response', 1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'park-call', name: 'write_file', input: {} }] } }),
      event('park-wait', 2, 'approval-waiting', { toolCallId: 'park-call', approvalId: 'park-approval', answerer: 'agent', reasonCode: 'policy', requestedAt: 10 }),
      event('park-deferred', 3, 'approval-deferred', { toolCallId: 'park-call', approvalId: 'park-approval', todoId: 'park-todo', invocationId: 'inv-1', checkpointId: 'checkpoint-1', workflowRevision: 2 })
    ], 0)
    await expect(history.appendBatch([event('park-terminal', 4, 'invocation-parked', { status: 'parked', reason: 'deferred-approval', todoId: 'park-todo' })], 3))
      .resolves.toMatchObject({ version: 4 })
  })

  it('rebuilds every invocation terminal status, including denied and cancelled payloads', () => {
    const snapshot = (kind: HistoryEvent['kind'], payload: unknown) => ({
      invocationId: 'inv-terminal', version: 1, schemaVersion: 1,
      events: [event(`terminal-${String((payload as { status?: unknown }).status)}`, 1, kind, payload)]
    })
    expect(rebuildInvocationStates(snapshot('invocation-completed', { status: 'completed' })).get('inv-terminal')).toMatchObject({ state: 'completed' })
    expect(rebuildInvocationStates(snapshot('invocation-failed', { status: 'failed' })).get('inv-terminal')).toMatchObject({ state: 'failed' })
    expect(rebuildInvocationStates(snapshot('invocation-failed', { status: 'denied', reason: 'POLICY_DENY' })).get('inv-terminal')).toMatchObject({ state: 'denied' })
    expect(rebuildInvocationStates(snapshot('invocation-interrupted', { status: 'cancelled' })).get('inv-terminal')).toMatchObject({ state: 'cancelled' })
    expect(rebuildInvocationStates(snapshot('invocation-interrupted', { status: 'interrupted' })).get('inv-terminal')).toMatchObject({ state: 'interrupted' })
  })

  it.each([
    ['approval', 'approval-waiting', { approvalId: 'approval-before-interrupt' }, 'interrupted'],
    ['approval', 'approval-waiting', { approvalId: 'approval-before-cancel' }, 'cancelled'],
    ['tool proposal', 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'proposal-before-interrupt' }] } }, 'interrupted'],
    ['tool proposal', 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'proposal-before-cancel' }] } }, 'cancelled'],
    ['dispatch', 'tool-call-started', { toolCallId: 'dispatch-before-interrupt' }, 'interrupted'],
    ['dispatch', 'tool-call-started', { toolCallId: 'dispatch-before-cancel' }, 'cancelled']
  ] as const)('keeps unresolved %s interrupted for either terminal status', (_label, pendingKind, pendingPayload, terminalStatus) => {
    const events = [
      event('pending-before-interrupt', 1, pendingKind, pendingPayload),
      event('interrupted-with-pending-work', 2, 'invocation-interrupted', {
        status: terminalStatus, reason: terminalStatus === 'cancelled' ? 'user-cancelled' : 'process-restart'
      })
    ]
    expect(rebuildInvocationStates({ invocationId: 'inv-1', version: 2, schemaVersion: 1, events }).get('inv-1'))
      .toMatchObject({ state: 'interrupted', lastEventId: 'pending-before-interrupt' })
  })

  it.each(['invocation-completed', 'invocation-failed', 'invocation-interrupted'] as const)(
    'rejects appending new facts after %s', async (terminalKind) => {
      const history = new MemoryHistory()
      const status = terminalKind === 'invocation-completed'
        ? 'completed'
        : terminalKind === 'invocation-failed' ? 'failed' : 'interrupted'
      await history.appendBatch([event('terminal-event', 1, terminalKind, { status })], 0)

      await expect(history.appendBatch([event('after-terminal', 2, 'model-response-committed', {
        message: { role: 'assistant', content: 'must not continue' }
      })], 1)).rejects.toThrow(/terminal invocation event/)
      await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ eventId: 'terminal-event' })] })
    }
  )

  it('requires a terminal event to be last in its append batch', async () => {
    const history = new MemoryHistory()
    await expect(history.appendBatch([
      event('batch-terminal', 1, 'invocation-completed', { status: 'completed' }),
      event('batch-after-terminal', 2, 'approval-updated', { late: true })
    ], 0)).rejects.toThrow(/terminal invocation event/)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('keeps concurrent unresolved approvals interrupted independently', () => {
    const concurrentApprovals = {
      invocationId: 'inv-approvals', version: 3, schemaVersion: 1,
      events: [
        event('approval-a-wait', 1, 'approval-waiting', { toolCallId: 'tool-a' }),
        event('approval-b-wait', 2, 'approval-waiting', { toolCallId: 'tool-b' }),
        event('approval-a-resolved', 3, 'approval-resolved', { toolCallId: 'tool-a', approved: true })
      ]
    }
    expect(rebuildInvocationStates(concurrentApprovals).get('inv-approvals')).toMatchObject({
      state: 'interrupted', lastEventId: 'approval-b-wait'
    })
    expect(rebuildInvocationStates({
      invocationId: 'inv-legacy-approval', version: 1, schemaVersion: 1,
      events: [event('legacy-approval-wait', 1, 'approval-waiting', {})]
    }).get('inv-legacy-approval')).toMatchObject({ state: 'interrupted', lastEventId: 'legacy-approval-wait' })
  })

  it('never rebuilds a possibly dispatched tool or pending approval as executable work', async () => {
    const approvalSnapshot = { invocationId: 'inv-1', version: 1, schemaVersion: 1, events: [event('approval', 1, 'approval-waiting', { approvalId: 'approval-1' })] }
    expect(rebuildInvocationStates(approvalSnapshot).get('inv-1')).toMatchObject({ state: 'interrupted', lastEventId: 'approval' })
    const dispatchSnapshot = { invocationId: 'inv-1', version: 1, schemaVersion: 1, events: [event('start-tool', 1, 'tool-call-started', { toolCallId: 'tc-1' })] }
    expect(rebuildInvocationStates(dispatchSnapshot).get('inv-1')).toMatchObject({ state: 'interrupted', lastEventId: 'start-tool' })
    const completedDispatch = { ...dispatchSnapshot, version: 2, events: [dispatchSnapshot.events[0], event('finish-tool', 2, 'tool-call-finished', { toolCallId: 'tc-1' })] }
    expect(rebuildInvocationStates(completedDispatch).has('inv-1')).toBe(false)
  })

  it('recovers committed but not yet dispatched model tool declarations as interrupted', () => {
    const responseSnapshot = {
      invocationId: 'inv-1', version: 1, schemaVersion: 1,
      events: [event('response', 1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [
        { id: 'tc-proposed', name: 'write_file', input: { path: 'a.txt' } }
      ] } })]
    }
    expect(rebuildInvocationStates(responseSnapshot).get('inv-1')).toMatchObject({
      state: 'interrupted', lastEventId: 'response'
    })
    const declined = {
      ...responseSnapshot, version: 2,
      events: [...responseSnapshot.events, event('declined', 2, 'tool-call-not-dispatched', { toolCallId: 'tc-proposed', reason: 'user_rejected' })]
    }
    expect(rebuildInvocationStates(declined).get('inv-1')).toMatchObject({ state: 'interrupted', lastEventId: 'response' })
  })

  it('marks a committed compacted transcript interrupted if its invocation has no terminal event', () => {
    const snapshot = {
      invocationId: 'inv-1', version: 1, schemaVersion: 1,
      events: [event('compacted', 1, 'transcript-compacted', { messages: [{ role: 'user', content: 'current' }] })]
    }
    expect(rebuildInvocationStates(snapshot).get('inv-1')).toMatchObject({ state: 'interrupted', lastEventId: 'compacted' })
  })
})
