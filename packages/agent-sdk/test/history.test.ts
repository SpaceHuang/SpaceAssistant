import { describe, expect, it } from 'vitest'
import { HistoryBatchError, HistoryIdempotencyConflict, InvocationHistoryWriter, MemoryHistory, HistorySequenceConflict, rebuildInvocationStates, type HistoryEvent } from '../src/history'

const event = (eventId: string, sequence: number, kind: HistoryEvent['kind'] = 'approval-updated', payload: unknown = { eventId }): HistoryEvent => ({
  eventId, idempotencyKey: `idem:${eventId}`, invocationId: 'inv-1', turnId: 'turn-1', sequence, schemaVersion: 1, kind, payload
})

describe('History Port semantics', () => {
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
