import { describe, expect, it, vi } from 'vitest'
import { AgentTurnPauseTimedOutError, type AgentTurnLifecycleLimits } from '../../packages/agent-sdk/src/turn'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { createRuntimeTriggerLifecycleAssembly, createRuntimeTriggerSyncWaitRegistry, createSyncCheckpointLifecycleHooks, failOrphanedRuntimeSyncTriggers } from './syncCheckpoint'
import { RUNTIME_TRIGGER_LIMITS } from './limits'

const limits: AgentTurnLifecycleLimits = { callbackTimeoutMs: 5000, maxPauseMs: 60000 }
function syncRecord(): RuntimeTriggerRecord {
  return { id: 'sync-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'key', definition: { version: 1,
    condition: { type: 'session_steps', targetSessionId: 'target', origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: 60_000, onPauseTimeout: 'continue' },
    sourceBaseline: { settledCount: 0 } }, state: 'waiting', createdAt: 1, expiresAt: 100_000, attempts: 0, revision: 1, updatedAt: 1 }
}

describe('sync runtime trigger checkpoint', () => {
  it('cancels every active SDK waiter at shutdown and releases the registry', () => {
    const waiters = createRuntimeTriggerSyncWaitRegistry()
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = waiters.register('one', first)
    waiters.register('two', second)
    expect(waiters.size()).toBe(2)
    waiters.cancelAll()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(waiters.size()).toBe(0)
    unregisterFirst()
    waiters.cancelAll()
    expect(first).toHaveBeenCalledOnce()
  })

  it('publishes the user-confirmed runtime lifecycle limits in milliseconds', () => {
    expect(RUNTIME_TRIGGER_LIMITS).toEqual({ callbackTimeoutMs: 5000, maxPauseMs: 60000 })
  })

  it('only fails matched sync waiters at startup; unmatched registrations survive restart', () => {
    const sync = syncRecord()
    const matchedSync = { ...sync, id: 'sync-matched', state: 'matched' as const, revision: 3, result: { pauseAcceptedBySdk: true } }
    const ordinary = { ...sync, id: 'async-1', definition: { ...sync.definition, condition: { ...sync.definition.condition, mode: 'async' as const } } }
    const update = vi.fn((id: string, revision: number, patch: { state: string; result: Record<string, unknown>; updatedAt: number }) => {
      const record = id === sync.id && revision === sync.revision ? sync : id === matchedSync.id && revision === matchedSync.revision ? matchedSync : null
      return record && patch.result.case === 'sync-waiter-lost-on-restart' ? ({ ...record, ...patch }) as RuntimeTriggerRecord : null
    })
    const commands = { runtimeTriggers: { listByState: vi.fn((state: string) => state === 'waiting' ? [sync, ordinary] : [matchedSync]), update } }
    expect(failOrphanedRuntimeSyncTriggers(commands as never, 1234)).toBe(1)
    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(matchedSync.id, matchedSync.revision, { state: 'failed', result: { pauseAcceptedBySdk: true,
      code: 'TRIGGER_SOURCE_GAP', case: 'sync-waiter-lost-on-restart' }, updatedAt: 1234 })
    expect(update).not.toHaveBeenCalledWith(sync.id, expect.anything(), expect.anything())
  })

  it('assembles production hooks with the confirmed bounds, without fixture defaults', () => {
    const assembled = createRuntimeTriggerLifecycleAssembly({
      sessionId: 'receiver', listWaitingSync: () => [], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 0, facts: { ok: true, settledCount: 0, settledStepIds: [], pendingStepIds: [] } }),
      match: () => null, expire: () => null, read: () => null, acceptPause: () => null,
      activateDelivery: async () => ({ sessionId: 'receiver', turnId: 'receiver-turn' }),
      subscribeReceiver: () => () => undefined, readReceiver: async () => ({ kind: 'terminal', sessionId: 'receiver', turnId: 'receiver-turn', outcome: 'completed' }),
      fail: () => undefined
    })
    expect(assembled.limits).toEqual({ callbackTimeoutMs: 5000, maxPauseMs: 60000 })
    expect(assembled.hooks.postStep).toBeTypeOf('function')
  })

  it('matches only at the current postStep and gates activation on SDK wait acceptance', async () => {
    const order: string[] = []
    let record = syncRecord()
    let terminalListener: ((value: unknown) => void) | undefined
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => record.state === 'waiting' ? [record] : [],
      listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['step-event'], pendingStepIds: [] } }),
      match: vi.fn((id, revision, event) => { order.push('match'); record = { ...record, state: 'matched', revision: revision + 1, matchedAt: 1000, event }; return record }),
      expire: () => null,
      read: () => record,
      acceptPause: vi.fn((id, revision, checkpoint) => { order.push('accept'); record = { ...record, revision: revision + 1, result: { pauseAcceptedBySdk: true } }; return record }),
      activateDelivery: vi.fn(async () => { order.push('activate'); return { sessionId: 'receiver', turnId: 'receiver-turn' } }),
      subscribeReceiver: vi.fn((sessionId, turnId, listener) => { order.push('subscribe'); terminalListener = listener; return () => { order.push('unsubscribe') } }),
      readReceiver: vi.fn(async () => { order.push('reread'); return { kind: 'terminal', sessionId: 'receiver', turnId: 'receiver-turn', outcome: 'completed' } }),
      fail: vi.fn()
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:1', modelTurn: 1, historyVersion: 5,
      hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
    expect(order).toEqual(['match'])
    expect(record.event).toMatchObject({ targetTurnId: 'source-turn', checkpointKey: 'inv:turn:1', executionGeneration: 7, pauseDeadlineAt: 61_000 })
    expect(pause).toMatchObject({ timeoutMs: 60_000, onTimeout: 'continue' })
    let settled = false
    const waiting = pause!.wait(new AbortController().signal).then(() => { settled = true })
    await vi.waitFor(() => expect(settled).toBe(true))
    await waiting
    expect(order).toEqual(['match', 'accept', 'activate', 'subscribe', 'reread', 'unsubscribe'])
    expect(terminalListener).toBeTypeOf('function')
    expect(record.result).toEqual({ pauseAcceptedBySdk: true })
  })

  it('counts only steps after registration and matches at the threshold', async () => {
    const base = syncRecord()
    let record: RuntimeTriggerRecord = { ...base, definition: { ...base.definition,
      condition: { ...base.definition.condition, threshold: 3 }, sourceBaseline: { settledCount: 5, settledCountByInvocation: { 'old-invocation': 5 } } } }
    let settledCount = 1
    const match = vi.fn((_id: string, _revision: number, event: Readonly<Record<string, unknown>>) => { record = { ...record, state: 'matched', revision: record.revision + 1, event }; return record })
    const expire = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => record.state === 'waiting' ? [record] : [], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 6, facts: { ok: true, settledCount, settledStepIds: Array.from({ length: settledCount }, (_, index) => `new-step-${index + 1}`), pendingStepIds: [] } }),
      saveProgress: (_id, revision, progress) => { record = { ...record, revision: revision + 1, result: { ...record.result, syncStepProgress: progress } }; return record },
      match, expire, read: () => record, acceptPause: () => null, activateDelivery: vi.fn(),
      subscribeReceiver: () => () => undefined, readReceiver: async () => ({ kind: 'pending' }), fail: vi.fn()
    })
    const postStep = (modelTurn: number) => hooks.postStep!({ invocationId: 'new-invocation', turnId: 'turn', stepKey: `new-invocation:turn:${modelTurn}`, modelTurn,
      historyVersion: 6, hasNextStep: true, executionGeneration: 1, signal: new AbortController().signal })
    await postStep(1)
    expect(match).not.toHaveBeenCalled()
    settledCount = 2
    await postStep(2)
    expect(match).not.toHaveBeenCalled()
    settledCount = 3
    await postStep(3)
    expect(match).toHaveBeenCalledOnce()
    expect(match.mock.calls[0]![2]).toMatchObject({ baseline: 5, actual: 3, threshold: 3, settledStepIds: ['new-step-1', 'new-step-2', 'new-step-3'] })
    expect(expire).not.toHaveBeenCalled()
  })

  it('accumulates settled steps across invocations after registration', async () => {
    const base = syncRecord()
    let record: RuntimeTriggerRecord = { ...base, definition: { ...base.definition, condition: { ...base.definition.condition, threshold: 3 } } }
    const match = vi.fn((_id: string, _revision: number, event: Readonly<Record<string, unknown>>) => { record = { ...record, state: 'matched', revision: record.revision + 1, event }; return record })
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => record.state === 'waiting' ? [record] : [], listMatchedForExecution: () => [],
      readStepFacts: async (invocationId) => ({ historyVersion: 1, facts: { ok: true, settledCount: 1, settledStepIds: [`${invocationId}-step`], pendingStepIds: [] } }),
      saveProgress: (_id, revision, progress) => { record = { ...record, revision: revision + 1, result: { ...record.result, syncStepProgress: progress } }; return record },
      match, expire: () => null, read: () => record, acceptPause: () => null, activateDelivery: vi.fn(),
      subscribeReceiver: () => () => undefined, readReceiver: async () => ({ kind: 'pending' }), fail: vi.fn()
    })
    for (const [index, invocationId] of ['inv-a', 'inv-b', 'inv-c'].entries()) {
      await hooks.postStep!({ invocationId, turnId: 'turn', stepKey: `${invocationId}:turn:1`, modelTurn: 1, historyVersion: 1,
        hasNextStep: true, executionGeneration: index + 1, signal: new AbortController().signal })
      if (index < 2) expect(match).not.toHaveBeenCalled()
    }
    expect(match).toHaveBeenCalledOnce()
    expect(match.mock.calls[0]![2]).toMatchObject({ actual: 3, threshold: 3, settledStepIds: ['inv-a-step', 'inv-b-step', 'inv-c-step'] })
  })

  it('expires a sync trigger at its deadline without matching or returning an SDK pause', async () => {
    const record = { ...syncRecord(), expiresAt: 1000 }
    const match = vi.fn()
    const expire = vi.fn()
    const activateDelivery = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1001,
      listWaitingSync: () => [record], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match, expire, read: () => record, acceptPause: () => null, activateDelivery,
      subscribeReceiver: () => () => undefined, readReceiver: async () => ({ kind: 'pending' }), fail: vi.fn()
    })
    await expect(hooks.postStep!({ invocationId: 'inv', turnId: 'turn', stepKey: 'inv:turn:1', modelTurn: 1,
      historyVersion: 5, hasNextStep: true, executionGeneration: 1, signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(expire).toHaveBeenCalledWith(record.id, record.revision)
    expect(match).not.toHaveBeenCalled()
    expect(activateDelivery).not.toHaveBeenCalled()
  })

  it('expires a pre-deadline sync match before SDK pause acceptance if wait starts late', async () => {
    let timestamp = 999
    let record: RuntimeTriggerRecord = { ...syncRecord(), expiresAt: 1000 }
    const acceptPause = vi.fn()
    const activateDelivery = vi.fn()
    const expire = vi.fn((_id: string, _revision: number) => { record = { ...record, state: 'expired', revision: record.revision + 1 }; return record })
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => timestamp,
      listWaitingSync: () => record.state === 'waiting' ? [record] : [], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match: (_id, _revision, event) => { record = { ...record, state: 'matched', revision: record.revision + 1, matchedAt: timestamp, event }; return record },
      expire, read: () => record, acceptPause, activateDelivery, subscribeReceiver: () => () => undefined,
      readReceiver: async () => ({ kind: 'pending' }), fail: vi.fn()
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'turn', stepKey: 'inv:turn:1', modelTurn: 1,
      historyVersion: 5, hasNextStep: true, executionGeneration: 1, signal: new AbortController().signal })
    timestamp = 1001
    await expect(pause!.wait(new AbortController().signal)).rejects.toThrow('sync trigger expired before SDK pause acceptance')
    expect(expire).toHaveBeenCalledWith(record.id, 2)
    expect(acceptPause).not.toHaveBeenCalled()
    expect(activateDelivery).not.toHaveBeenCalled()
  })

  it('does not allow an old checkpoint or execution generation to activate delivery', async () => {
    const record = syncRecord()
    const fail = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => [record], readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      listMatchedForExecution: () => [],
      match: () => null, expire: () => null, read: () => null, acceptPause: () => null, activateDelivery: vi.fn(),
      subscribeReceiver: () => () => {}, readReceiver: async () => ({ kind: 'pending' }), fail
    })
    await expect(hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:2', modelTurn: 1, historyVersion: 4,
      hasNextStep: true, executionGeneration: 8, signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(fail).toHaveBeenCalledWith(record.id, record.revision, 'TRIGGER_HANDLING_FAILED', 'checkpoint-unavailable')
  })

  it('propagates explicit trigger cancellation to the active receiver wait and releases its registration', async () => {
    let record = syncRecord()
    let cancelWait: (() => void) | undefined
    const fail = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => [record], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match: (_id, _revision, event) => { record = { ...record, state: 'matched', revision: record.revision + 1, matchedAt: 1000, event }; return record },
      expire: () => null,
      read: () => record,
      acceptPause: ({ trigger }) => { record = { ...trigger, revision: trigger.revision + 1, result: { pauseAcceptedBySdk: true } }; return record },
      activateDelivery: async () => ({ sessionId: 'receiver', turnId: 'receiver-turn' }),
      subscribeReceiver: () => () => undefined,
      readReceiver: () => new Promise(() => undefined),
      registerWaiter: (_id, cancel) => { cancelWait = cancel; return () => { cancelWait = undefined } },
      fail
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:1', modelTurn: 1,
      historyVersion: 5, hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
    const waiting = pause!.wait(new AbortController().signal)
    await vi.waitFor(() => expect(cancelWait).toBeTypeOf('function'))
    record = { ...record, state: 'cancelled', revision: record.revision + 1 }
    cancelWait!()
    await expect(waiting).rejects.toThrow('sync wait cancelled')
    expect(fail).not.toHaveBeenCalled()
    expect(cancelWait).toBeUndefined()
  })

  it('keeps a busy receiver delivery matched until recovery starts its queued Turn', async () => {
    let record = syncRecord()
    let resolveTurn!: (value: { sessionId: string; turnId: string }) => void
    const waitForReceiverTurn = vi.fn(() => new Promise<{ sessionId: string; turnId: string }>((resolve) => { resolveTurn = resolve }))
    const fail = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => record.state === 'waiting' ? [record] : [], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match: (_id, _revision, event) => { record = { ...record, state: 'matched', revision: record.revision + 1, matchedAt: 1000, event }; return record },
      expire: () => null, read: () => record,
      acceptPause: ({ trigger }) => { record = { ...trigger, revision: trigger.revision + 1, result: { pauseAcceptedBySdk: true } }; return record },
      activateDelivery: async () => 'busy', waitForReceiverTurn,
      subscribeReceiver: () => () => undefined,
      readReceiver: async () => ({ kind: 'terminal', sessionId: 'receiver', turnId: 'receiver-turn', outcome: 'completed' }),
      fail
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:1', modelTurn: 1,
      historyVersion: 5, hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
    const waiting = pause!.wait(new AbortController().signal)
    await vi.waitFor(() => expect(waitForReceiverTurn).toHaveBeenCalledOnce())
    expect(record.state).toBe('matched')
    expect(fail).not.toHaveBeenCalled()
    resolveTurn({ sessionId: 'receiver', turnId: 'receiver-turn' })
    await expect(waiting).resolves.toBeUndefined()
    expect(fail).not.toHaveBeenCalled()
  })

  it('cancels queued delivery and does not fail the trigger when cancellation interrupts busy recovery wait', async () => {
    let record = syncRecord()
    let cancelWait: (() => void) | undefined
    let waitingSignal: AbortSignal | undefined
    const cancelPendingDelivery = vi.fn()
    const fail = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => [record], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match: (_id, _revision, event) => { record = { ...record, state: 'matched', revision: record.revision + 1, matchedAt: 1000, event }; return record },
      expire: () => null, read: () => record,
      acceptPause: ({ trigger }) => { record = { ...trigger, revision: trigger.revision + 1, result: { pauseAcceptedBySdk: true } }; return record },
      activateDelivery: async () => 'busy', waitForReceiverTurn: (_trigger, { signal }) => {
        waitingSignal = signal
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(String(signal.reason))), { once: true }))
      }, cancelPendingDelivery,
      subscribeReceiver: () => () => undefined, readReceiver: async () => ({ kind: 'pending' }),
      registerWaiter: (_id, cancel) => { cancelWait = cancel; return () => undefined }, fail
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:1', modelTurn: 1,
      historyVersion: 5, hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
    const waiting = pause!.wait(new AbortController().signal)
    await vi.waitFor(() => expect(waitingSignal).toBeDefined())
    record = { ...record, state: 'cancelled', revision: record.revision + 1 }
    cancelWait!()
    await expect(waiting).rejects.toThrow('sync wait cancelled')
    expect(waitingSignal!.aborted).toBe(true)
    expect(cancelPendingDelivery).toHaveBeenCalledOnce()
    expect(fail).not.toHaveBeenCalled()
  })

  it('cleans up a busy queued marker when the SDK pause deadline expires', async () => {
    let record = syncRecord()
    let waitingSignal: AbortSignal | undefined
    const cancelPendingDelivery = vi.fn()
    const fail = vi.fn()
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => [record], listMatchedForExecution: () => [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match: (_id, _revision, event) => { record = { ...record, state: 'matched', revision: record.revision + 1, matchedAt: 1000, event }; return record },
      expire: () => null, read: () => record,
      acceptPause: ({ trigger }) => { record = { ...trigger, revision: trigger.revision + 1, result: { pauseAcceptedBySdk: true } }; return record },
      activateDelivery: async () => 'busy', waitForReceiverTurn: (_trigger, { signal }) => {
        waitingSignal = signal
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new AgentTurnPauseTimedOutError()), { once: true }))
      }, cancelPendingDelivery,
      subscribeReceiver: () => () => undefined, readReceiver: async () => ({ kind: 'pending' }), fail
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:1', modelTurn: 1,
      historyVersion: 5, hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
    const signal = new AbortController()
    const waiting = pause!.wait(signal.signal)
    await vi.waitFor(() => expect(waitingSignal).toBeDefined())
    signal.abort('lifecycle-pause-timeout')
    await expect(waiting).rejects.toBeInstanceOf(AgentTurnPauseTimedOutError)
    expect(cancelPendingDelivery).toHaveBeenCalledOnce()
    expect(fail).toHaveBeenCalledWith(record.id, record.revision, 'TRIGGER_HANDLING_FAILED', 'pause-timeout')
  })

  it('settles pause timeout and cleans up an unaccepted matched checkpoint at Turn terminal', async () => {
    let record = syncRecord()
    const fail = vi.fn()
    const subscribeReceiver = vi.fn(() => () => {})
    const hooks = createSyncCheckpointLifecycleHooks({
      sessionId: 'target', limits, now: () => 1000,
      listWaitingSync: () => record.state === 'waiting' ? [record] : [],
      listMatchedForExecution: () => record.state === 'matched' ? [record] : [],
      readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['s'], pendingStepIds: [] } }),
      match: (id, revision, event) => { record = { ...record, state: 'matched', revision: revision + 1, event, matchedAt: 1000 }; return record },
      expire: () => null,
      read: () => record,
      acceptPause: ({ trigger }) => { record = { ...trigger, revision: trigger.revision + 1, result: { pauseAcceptedBySdk: true } }; return record },
      activateDelivery: async () => ({ sessionId: 'receiver', turnId: 'receiver-turn' }), subscribeReceiver,
      readReceiver: async () => ({ kind: 'pending' }), fail
    })
    const pause = await hooks.postStep!({ invocationId: 'inv', turnId: 'source-turn', stepKey: 'inv:turn:1', modelTurn: 1, historyVersion: 5,
      hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
    const controller = new AbortController()
    const waiting = pause!.wait(controller.signal)
    await vi.waitFor(() => expect(subscribeReceiver).toHaveBeenCalledOnce())
    controller.abort('lifecycle-pause-timeout')
    await expect(waiting).rejects.toThrow('lifecycle-pause-timeout')
    expect(fail).toHaveBeenCalledWith(record.id, record.revision, 'TRIGGER_HANDLING_FAILED', 'pause-timeout')

    record = { ...record, state: 'matched', result: undefined, event: { invocationId: 'inv', targetTurnId: 'source-turn' } }
    await hooks.postTurn!({ invocationId: 'inv', turnId: 'source-turn', terminalKey: 'terminal', status: 'completed', historyVersion: 6, signal: new AbortController().signal })
    expect(fail).toHaveBeenLastCalledWith(record.id, record.revision, 'TRIGGER_HANDLING_FAILED', 'checkpoint-not-accepted')
  })
})
