import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent, HistoryPort, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { createTurnTerminalBus, createRuntimeTriggerSourceScanner, evaluateRuntimeTriggerSource, readPersistedTurnTerminal, readSessionSettledStepFacts, readSettledStepFacts, reduceSettledStepFacts, SettledStepFactsTracker, runWithPersistedTurnTerminalNotification, turnTerminalBusForExecution, runtimeTriggerCandidate } from './sources'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { beginManagedProcess, finishManagedProcess, managedProcessRuntimeGeneration, resetManagedProcessSourceForTests } from './processSource'

function snapshot(specs: Array<{ kind: HistoryEvent['kind']; payload: unknown }>, invocationId = 'inv'): HistorySnapshot {
  const events = specs.map((spec, index) => ({
    eventId: `${invocationId}:history:${index + 1}`, idempotencyKey: `${invocationId}:key:${index + 1}`,
    invocationId, turnId: 'turn', sequence: index + 1, schemaVersion: 1, ...spec
  })) as HistoryEvent[]
  return { invocationId, version: events.length, schemaVersion: 1, events }
}

const response = (modelTurn: number, toolIds: string[] = []) => ({
  kind: 'model-response-committed' as const,
  payload: { requestId: `inv:turn:${modelTurn}`, modelTurn, message: { role: 'assistant', toolCalls: toolIds.map((id) => ({ id, name: 'lookup', input: {} })) } }
})
const settled = (kind: 'tool-call-finished' | 'tool-call-not-dispatched' | 'tool-call-deferred', toolCallId: string, modelTurn: number, outcome?: string) => ({
  kind, payload: { toolCallId, modelTurn, ...(outcome ? { executionOutcome: outcome } : {}) }
})

function trigger(condition: RuntimeTriggerRecord['definition']['condition'], expiresAt = Date.parse('2030-01-02T00:00:00Z')): RuntimeTriggerRecord {
  return { id: 'trigger', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'key', definition: { version: 1, condition, sourceBaseline: { settledCount: 2 } },
    state: 'waiting', createdAt: 0, expiresAt, attempts: 0, revision: 1, updatedAt: 0 }
}

describe('runtime trigger History source facts', () => {
  it('uses complete session history in durable invocation order for a step baseline', async () => {
    const histories = new Map([['inv-a', snapshot([response(1, ['tool-a']), settled('tool-call-finished', 'tool-a', 1)], 'inv-a')],
      ['inv-b', snapshot([response(1, ['tool-b']), settled('tool-call-finished', 'tool-b', 1)], 'inv-b')]])
    const execution = { historyFor: () => ({ listInvocationIds: () => ['inv-a', 'inv-b'], read: async (id: string) => histories.get(id)! }) }
    await expect(readSessionSettledStepFacts(execution as never, 'session-a')).resolves.toEqual({ ok: true, settledCount: 2,
      settledStepIds: ['inv-a:inv-a:history:1', 'inv-b:inv-b:history:1'], pendingStepIds: [] })
  })
  it('incrementally appends new durable step events without rebuilding the existing History prefix', () => {
    const first = snapshot([response(1, ['tool-a'])], 'incremental')
    const tracker = new SettledStepFactsTracker()
    expect(tracker.update(first)).toMatchObject({ ok: true, settledCount: 0, pendingStepIds: [first.events[0]!.eventId] })
    const appended = settled('tool-call-finished', 'tool-a', 1)
    expect(tracker.appendEvents({ invocationId: 'incremental', fromVersion: 1, version: 2,
      events: [{ ...appended, eventId: 'incremental:history:2', idempotencyKey: 'incremental:key:2', invocationId: 'incremental',
        turnId: 'turn', sequence: 2, schemaVersion: 1 } as HistoryEvent] })).toMatchObject({ ok: true, settledCount: 1, pendingStepIds: [] })
    expect(tracker.appendEvents({ invocationId: 'incremental', fromVersion: 0, version: 2, events: [] })).toMatchObject({ ok: false, case: 'history-incremental-cursor-mismatch' })
  })
  it('resolves the exact registered completed Turn and never matches another Turn', async () => {
    const record = trigger({ type: 'turn_completed', targetSessionId: 'target', turnId: 'registered-turn' })
    const readTurnCompletion = vi.fn(async () => ({ kind: 'terminal' as const, sessionId: 'target', turnId: 'registered-turn', outcome: 'completed' as const, occurredAt: 500 }))
    await expect(evaluateRuntimeTriggerSource(record, { now: 600, readTurnCompletion })).resolves.toMatchObject({ kind: 'candidate', event: { turnId: 'registered-turn' } })
    await expect(evaluateRuntimeTriggerSource(record, { now: 600, readTurnCompletion: async () => ({
      kind: 'terminal', sessionId: 'target', turnId: 'registered-turn', outcome: 'failed', occurredAt: 500
    }) })).resolves.toMatchObject({ kind: 'candidate', event: { turnId: 'registered-turn', outcome: 'failed' } })
    await expect(evaluateRuntimeTriggerSource(record, { now: 600, readTurnCompletion: async () => ({
      kind: 'terminal', sessionId: 'target', turnId: 'other-turn', outcome: 'completed', occurredAt: 500
    }) })).resolves.toMatchObject({ kind: 'source-gap', case: 'turn-fact-identity-invalid' })
  })

  it('resolves only managed process exits from the registration runtime generation', async () => {
    resetManagedProcessSourceForTests()
    const process = beginManagedProcess({ sessionId: 'owner', toolName: 'run_shell' })
    finishManagedProcess(process, { exitCode: 4, signal: null, reason: 'process_exit', occurredAt: 500 })
    const base = trigger({ type: 'process_exit', managedProcessId: process.managedProcessId })
    const record = { ...base, definition: { ...base.definition, sourceBaseline: { runtimeGeneration: process.runtimeGeneration } } }
    await expect(evaluateRuntimeTriggerSource(record, { now: 600 })).resolves.toMatchObject({ kind: 'candidate', event: { exitCode: 4, runtimeGeneration: managedProcessRuntimeGeneration() } })
    const stale = { ...record, definition: { ...record.definition, sourceBaseline: { runtimeGeneration: 'old-generation' } } }
    await expect(evaluateRuntimeTriggerSource(stale, { now: 600 })).resolves.toMatchObject({ kind: 'source-gap', case: 'runtime-generation-mismatch' })
    resetManagedProcessSourceForTests()
  })

  it('treats absolute time as due at equality, retains offset meaning and permits offline delivery only within expiry', () => {
    const record = trigger({ type: 'time', at: '2030-01-01T08:00:00+08:00', taskPrompt: 'do task' })
    const due = Date.parse('2030-01-01T00:00:00Z')
    expect(runtimeTriggerCandidate(record, due - 1)).toEqual({ kind: 'none' })
    expect(runtimeTriggerCandidate(record, due)).toMatchObject({ kind: 'candidate', event: { occurredAt: due, taskPrompt: 'do task' } })
    expect(runtimeTriggerCandidate(record, record.expiresAt + 1000)).toMatchObject({ kind: 'candidate', event: { occurredAt: due } })
    expect(runtimeTriggerCandidate(trigger({ type: 'time', at: '2030-01-03T00:00:00Z', taskPrompt: 'late' }), due))
      .toEqual({ kind: 'expired', case: 'time-after-expiry' })
  })

  it('matches async step threshold by settled delta and never lets a source scan accept sync pause', () => {
    const asyncRecord = trigger({ type: 'session_steps', targetSessionId: 'target', origin: 'registration', threshold: 2, mode: 'async' })
    expect(runtimeTriggerCandidate(asyncRecord, 100, { ok: true, settledCount: 3, settledStepIds: ['step-1', 'step-2', 'step-3'], pendingStepIds: [] })).toEqual({ kind: 'none' })
    expect(runtimeTriggerCandidate(asyncRecord, 100, { ok: true, settledCount: 4, settledStepIds: ['step-1', 'step-2', 'step-3', 'step-4'], pendingStepIds: [] }))
      .toMatchObject({ kind: 'candidate', event: { baseline: 2, actual: 4, threshold: 2 } })
    const syncRecord = trigger({ type: 'session_steps', targetSessionId: 'target', origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: 1000, onPauseTimeout: 'continue' })
    expect(runtimeTriggerCandidate(syncRecord, 100, { ok: true, settledCount: 9, settledStepIds: [], pendingStepIds: [] })).toEqual({ kind: 'none' })
  })

  it('runs a one-second scanner and CAS removes a candidate from subsequent scans', async () => {
    vi.useFakeTimers()
    try {
      const record = trigger({ type: 'time', at: '2030-01-01T00:00:00Z', taskPrompt: 'wake' })
      let waiting = true
      const match = vi.fn(() => { waiting = false })
      const scanner = createRuntimeTriggerSourceScanner({ listWaiting: () => waiting ? [record] : [], match, expire: vi.fn(), fail: vi.fn(), now: () => Date.parse('2030-01-01T00:00:00Z') })
      scanner.start()
      await vi.advanceTimersByTimeAsync(3000)
      scanner.stop()
      expect(match).toHaveBeenCalledOnce()
      expect(match).toHaveBeenCalledWith('trigger', 1, expect.objectContaining({ occurredAt: Date.parse('2030-01-01T00:00:00Z') }))
    } finally { vi.useRealTimers() }
  })

  it('counts one accepted no-tool response as one settled step', () => {
    expect(reduceSettledStepFacts(snapshot([response(1)]) )).toMatchObject({ ok: true, settledCount: 1, settledStepIds: ['inv:history:1'], pendingStepIds: [] })
  })

  it('counts parallel tools as one step only after every tool has a terminal fact', () => {
    const partial = reduceSettledStepFacts(snapshot([response(1, ['a', 'b']), settled('tool-call-finished', 'a', 1)]))
    expect(partial).toMatchObject({ ok: true, settledCount: 0, settledStepIds: [], pendingStepIds: ['inv:history:1'] })
    expect(reduceSettledStepFacts(snapshot([response(1, ['a', 'b']), settled('tool-call-finished', 'a', 1), settled('tool-call-not-dispatched', 'b', 1)])))
      .toMatchObject({ ok: true, settledCount: 1, settledStepIds: ['inv:history:1'], pendingStepIds: [] })
  })

  it('treats provider retry/discard facts as non-steps and settled failure/defer facts as terminal', () => {
    expect(reduceSettledStepFacts(snapshot([
      { kind: 'provider-retry-scheduled', payload: { modelTurn: 1 } },
      { kind: 'model-attempt-discarded', payload: { modelTurn: 1 } },
      response(1, ['failed', 'deferred']),
      settled('tool-call-finished', 'failed', 1, 'known-failure'),
      settled('tool-call-deferred', 'deferred', 1)
    ]))).toMatchObject({ ok: true, settledCount: 1, settledStepIds: ['inv:history:3'], pendingStepIds: [] })
  })

  it('settles a recovery not-dispatched fact that lacks optional modelTurn using its exact tool identity', () => {
    const noModelTurn = { kind: 'tool-call-not-dispatched' as const, payload: { toolCallId: 'recovered', executionOutcome: 'not-dispatched' } }
    expect(reduceSettledStepFacts(snapshot([response(1, ['recovered']), noModelTurn])))
      .toMatchObject({ ok: true, settledCount: 1, pendingStepIds: [] })
  })

  it('keeps stable response identity when a provider reuses a tool call ID on a later response', () => {
    expect(reduceSettledStepFacts(snapshot([
      response(1, ['same-id']), settled('tool-call-finished', 'same-id', 1),
      response(2, ['same-id']), settled('tool-call-not-dispatched', 'same-id', 2)
    ]))).toMatchObject({ ok: true, settledCount: 2, settledStepIds: ['inv:history:1', 'inv:history:3'] })
  })

  it('does not count a finished tool whose execution outcome is unknown', () => {
    expect(reduceSettledStepFacts(snapshot([response(1, ['uncertain']), settled('tool-call-finished', 'uncertain', 1, 'unknown-after-dispatch')])))
      .toMatchObject({ ok: true, settledCount: 0, pendingStepIds: ['inv:history:1'] })
  })

  it('fails closed on an unsupported tool outcome instead of treating it as settled', () => {
    expect(reduceSettledStepFacts(snapshot([response(1, ['bad']), settled('tool-call-finished', 'bad', 1, 'maybe')])))
      .toMatchObject({ ok: false, code: 'SOURCE_GAP', case: 'tool-terminal-outcome-invalid' })
  })

  it('fails closed when a terminal tool fact conflicts with its accepted model turn', () => {
    expect(reduceSettledStepFacts(snapshot([response(1, ['tool']), settled('tool-call-finished', 'tool', 2)])))
      .toMatchObject({ ok: false, code: 'SOURCE_GAP', case: 'tool-terminal-turn-mismatch' })
  })

  it('fails closed on a History version/sequence gap instead of resetting the baseline', () => {
    const incomplete = { ...snapshot([response(1)]), version: 2 }
    expect(reduceSettledStepFacts(incomplete)).toMatchObject({ ok: false, code: 'SOURCE_GAP', case: 'history-incomplete' })
  })

  it('incrementally settles new events, ignores repeated scans, and rebuilds the same facts after restart', () => {
    const first = snapshot([response(1, ['a'])])
    const complete = snapshot([response(1, ['a']), settled('tool-call-finished', 'a', 1)])
    const tracker = new SettledStepFactsTracker()
    expect(tracker.update(first)).toMatchObject({ settledCount: 0, pendingStepIds: ['inv:history:1'] })
    const settledFacts = tracker.update(complete)
    expect(settledFacts).toMatchObject({ settledCount: 1, settledStepIds: ['inv:history:1'] })
    expect(tracker.update(complete)).toEqual(settledFacts)
    expect(new SettledStepFactsTracker().update(complete)).toEqual(settledFacts)
  })

  it('detects a rewritten prefix even when the event IDs and version are unchanged', () => {
    const tracker = new SettledStepFactsTracker()
    const original = snapshot([response(1)])
    tracker.update(original)
    const rewritten = snapshot([{ ...response(1), payload: { ...response(1).payload, modelTurn: 2 } }])
    expect(tracker.update(rewritten)).toMatchObject({ ok: false, code: 'SOURCE_GAP', case: 'history-prefix-changed' })
  })

  it('maps public History read failures to SOURCE_GAP', async () => {
    const history = { read: vi.fn().mockRejectedValue(new Error('unavailable')) } as unknown as HistoryPort
    expect(await readSettledStepFacts(history, 'inv')).toMatchObject({ ok: false, code: 'SOURCE_GAP', case: 'history-unavailable' })
  })

  it('rejects a public History read that returns another invocation identity', async () => {
    const history = { read: vi.fn().mockResolvedValue(snapshot([response(1)], 'other')) } as unknown as HistoryPort
    expect(await readSettledStepFacts(history, 'inv')).toMatchObject({ ok: false, case: 'history-identity-mismatch' })
  })

  it('requires an exact persisted terminal Turn and preserves its outcome', () => {
    expect(readPersistedTurnTerminal({ sessionId: 's', turnId: 't', state: 'executing' }, 's', 't')).toEqual({ kind: 'pending' })
    expect(readPersistedTurnTerminal({ sessionId: 'other', turnId: 't', state: 'terminal', outcome: 'completed' }, 's', 't')).toMatchObject({ kind: 'source-gap' })
    expect(readPersistedTurnTerminal({ sessionId: 's', turnId: 't', state: 'terminal', outcome: 'interrupted' }, 's', 't'))
      .toEqual({ kind: 'terminal', sessionId: 's', turnId: 't', outcome: 'interrupted' })
    expect(readPersistedTurnTerminal({ sessionId: 's', turnId: 't', state: 'terminal', outcome: 'timed-out' }, 's', 't'))
      .toEqual({ kind: 'terminal', sessionId: 's', turnId: 't', outcome: 'timed-out' })
    expect(readPersistedTurnTerminal({ sessionId: 's', turnId: 't', state: 'terminal', outcome: 'unknown' }, 's', 't'))
      .toMatchObject({ kind: 'source-gap', case: 'turn-terminal-outcome-invalid' })
  })

  it('notifies subscribers only after rereading the authoritative persisted Turn terminal', async () => {
    let record: unknown = { sessionId: 's', turnId: 't', state: 'executing' }
    const bus = createTurnTerminalBus((sessionId, turnId) => sessionId === 's' && turnId === 't' ? record : undefined)
    const listener = vi.fn()
    bus.subscribe('s', 't', listener)
    await bus.notify('s', 't')
    expect(listener).not.toHaveBeenCalled()
    record = { sessionId: 's', turnId: 't', state: 'terminal', outcome: 'failed' }
    await bus.notify('s', 't')
    await bus.notify('s', 't')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ kind: 'terminal', sessionId: 's', turnId: 't', outcome: 'failed' })
    const lateSubscriber = vi.fn()
    bus.subscribe('s', 't', lateSubscriber)
    await bus.notify('s', 't')
    expect(lateSubscriber).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies after coordinator persistence settles and preserves source failures', async () => {
    let record: unknown = { sessionId: 's', turnId: 't', state: 'executing' }
    const execution = { readTurn: vi.fn(() => record) }
    const listener = vi.fn()
    turnTerminalBusForExecution(execution as never).subscribe('s', 't', listener)
    const result = await runWithPersistedTurnTerminalNotification(execution as never, { sessionId: 's', turnId: 't' }, async () => {
      expect(listener).not.toHaveBeenCalled()
      record = { sessionId: 's', turnId: 't', state: 'terminal', outcome: 'failed' }
      return 'source-failed'
    })
    expect(result).toBe('source-failed')
    expect(listener).toHaveBeenCalledWith({ kind: 'terminal', sessionId: 's', turnId: 't', outcome: 'failed' })
    record = { sessionId: 's', turnId: 't', state: 'terminal', outcome: 'cancelled' }
    await expect(runWithPersistedTurnTerminalNotification(execution as never, { sessionId: 's', turnId: 't' }, async () => { throw new Error('source failed') }))
      .rejects.toThrow('source failed')
    expect(listener).toHaveBeenCalledWith({ kind: 'terminal', sessionId: 's', turnId: 't', outcome: 'cancelled' })
  })
})
