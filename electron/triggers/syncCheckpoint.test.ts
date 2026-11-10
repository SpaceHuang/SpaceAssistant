import { describe, expect, it, vi } from 'vitest'
import { AgentTurnPauseTimedOutError, type AgentTurnLifecycleLimits } from '../../packages/agent-sdk/src/turn'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { createRuntimeTriggerLifecycleAssembly, createRuntimeTriggerSyncWaitRegistry, createSyncCheckpointLifecycleHooks, failOrphanedRuntimeSyncTriggers } from './syncCheckpoint'
import { RUNTIME_TRIGGER_LIMITS } from './limits'
import { createMemoryAppDb } from '../database/testHelpers'
import { claimQueuedTurnAtomicallyInScope, createSession, deleteQueuedUserMessageInScope, enqueueAgentSessionMessageInScope,
  enqueueQueuedUserMessageInScope, getNextDesktopQueueInput } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { createSessionCommands } from '../sessionStorage/commands'
import { insertRuntimeTrigger } from './store'
import { createOutboundDrainer } from '../outbound/outboundAcceptor'

const limits: AgentTurnLifecycleLimits = { callbackTimeoutMs: 5000, maxPauseMs: 60000 }
function syncRecord(): RuntimeTriggerRecord {
  return { id: 'sync-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'key', definition: { version: 1,
    condition: { type: 'session_steps', targetSessionId: 'target', origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: 60_000, onPauseTimeout: 'continue' },
    sourceBaseline: { settledCount: 0 } }, state: 'waiting', createdAt: 1, expiresAt: 100_000, attempts: 0, revision: 1, updatedAt: 1 }
}

function orphanedSyncQueueFixture() {
  const db = createMemoryAppDb()
  const commands = createSessionCommands(db)
  const owner = createSession(db, { name: 'orphaned sync owner' })
  const receiver = createSession(db, { name: 'orphaned sync receiver' })
  const now = 1234
  const scope = { kind: 'desktop' } as const
  const triggerId = 'orphaned-sync'
  const requestId = `runtime-trigger:${triggerId}`
  const condition = { type: 'session_steps' as const, targetSessionId: receiver.id, origin: 'registration' as const, threshold: 1,
    mode: 'sync' as const, pauseTimeoutMs: 60_000, onPauseTimeout: 'continue' as const }
  const binding = { bindingVersion: 1, requestId, ownerSessionId: owner.id, receiverSessionId: receiver.id, queueScope: scope,
    sourceIdentity: condition, payloadDigest: 'source-digest', policyRevision: 'policy',
    authorizationGeneration: 'auth', runtimeGeneration: 'runtime' }
  insertRuntimeTrigger(commands, { id: triggerId, ownerSessionId: owner.id, receiverSessionId: receiver.id, clientKey: triggerId,
    definition: { version: 1, condition, sourceBaseline: { settledCount: 0 } },
    state: 'matched', createdAt: now, expiresAt: now + 60_000, matchedAt: now,
    event: { type: 'session_steps', occurredAt: now, targetSessionId: receiver.id, pauseDeadlineAt: now + 60_000 }, attempts: 0,
    result: { pauseAcceptedBySdk: true, authorization: binding }, revision: 1, updatedAt: now })
  const marker = commands.scopedQueue.enqueue({ sessionId: receiver.id, requestId, content: `运行时事件待处理：${triggerId}`, queueScope: scope })
  const stored = commands.runtimeTriggers.read(triggerId)!
  commands.runtimeTriggers.update(triggerId, stored.revision, { messageId: marker.persisted.message.id })
  const laterInput = enqueueQueuedUserMessageInScope(db, { sessionId: receiver.id, requestId: 'later-desktop-input',
    content: 'must run after orphan cleanup', queueScope: scope })
  const wake = vi.fn()
  const recover = () => failOrphanedRuntimeSyncTriggers(commands, now, {
    resolveQueueScope: () => scope,
    onQueueReleased: wake
  })
  return { db, commands, receiver, requestId, laterInput, wake, recover }
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
    const recover = vi.fn(({ triggerId }: { triggerId: string }) => triggerId === matchedSync.id
      ? { kind: 'failed' as const, markerRemoved: false }
      : { kind: 'not-eligible' as const, markerRemoved: false })
    const commands = { runtimeTriggers: { listByState: vi.fn((state: string) => state === 'matched' ? [matchedSync] : []), recoverOrphanedSyncTrigger: recover } }
    expect(failOrphanedRuntimeSyncTriggers(commands as never, 1234, { resolveQueueScope: () => ({ kind: 'desktop' }) })).toBe(1)
    expect(recover).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledWith({ triggerId: matchedSync.id, expectedRevision: matchedSync.revision, now: 1234,
      queueScope: { kind: 'desktop' } })
  })

  it('removes an orphaned sync trigger notification before marking it failed', () => {
    const fixture = orphanedSyncQueueFixture()
    try {
      expect(fixture.recover()).toBe(1)
      expect(fixture.commands.scopedQueue.readReceipt({ sessionId: fixture.receiver.id, requestId: fixture.requestId,
        queueScope: { kind: 'desktop' } })).toMatchObject({ state: 'cancelled' })
      expect(getNextDesktopQueueInput(fixture.db, fixture.receiver.id)?.requestId).toBe('later-desktop-input')
    } finally { fixture.db.close() }
  })

  it('wakes the desktop drainer after orphan cleanup exposes the next queued input', () => {
    const fixture = orphanedSyncQueueFixture()
    try {
      expect(fixture.recover()).toBe(1)
      expect(fixture.wake).toHaveBeenCalledExactlyOnceWith(fixture.receiver.id)
      expect(getNextDesktopQueueInput(fixture.db, fixture.receiver.id)?.message.id).toBe(fixture.laterInput.persisted.message.id)
    } finally { fixture.db.close() }
  })

  it('rolls back queue cleanup if writing the trigger terminal state fails', () => {
    const fixture = orphanedSyncQueueFixture()
    try {
      getDbConnection(fixture.db).exec(`CREATE TRIGGER reject_sync_orphan_failure
        BEFORE UPDATE OF state ON runtime_triggers WHEN NEW.id='orphaned-sync' AND NEW.state='failed'
        BEGIN SELECT RAISE(ABORT, 'injected terminal write failure'); END`)
      expect(fixture.recover).toThrow('injected terminal write failure')
      expect(fixture.commands.scopedQueue.readReceipt({ sessionId: fixture.receiver.id, requestId: fixture.requestId,
        queueScope: { kind: 'desktop' } })).toMatchObject({ state: 'queued' })
      expect(fixture.commands.runtimeTriggers.read('orphaned-sync')?.state).toBe('matched')
      expect(fixture.wake).not.toHaveBeenCalled()
    } finally { fixture.db.close() }
  })

  it('cleans a trusted queued marker left by an older recovery after the trigger was failed', () => {
    const fixture = orphanedSyncQueueFixture()
    try {
      const trigger = fixture.commands.runtimeTriggers.read('orphaned-sync')!
      fixture.commands.runtimeTriggers.update(trigger.id, trigger.revision, { state: 'failed', result: {
        ...(trigger.result ?? {}), code: 'TRIGGER_SOURCE_GAP', case: 'sync-waiter-lost-on-restart'
      }, updatedAt: 1234 })
      expect(fixture.recover()).toBe(0)
      expect(fixture.commands.scopedQueue.readReceipt({ sessionId: fixture.receiver.id, requestId: fixture.requestId,
        queueScope: { kind: 'desktop' } })).toMatchObject({ state: 'cancelled' })
      expect(fixture.wake).toHaveBeenCalledExactlyOnceWith(fixture.receiver.id)
      expect(getNextDesktopQueueInput(fixture.db, fixture.receiver.id)?.requestId).toBe('later-desktop-input')
    } finally { fixture.db.close() }
  })

  it('keeps an orphan marker when its stored source does not match the trusted trigger identity', () => {
    const fixture = orphanedSyncQueueFixture()
    try {
      getDbConnection(fixture.db).prepare('UPDATE messages SET content=? WHERE id=?').run('forged marker',
        fixture.commands.scopedQueue.readReceipt({ sessionId: fixture.receiver.id, requestId: fixture.requestId, queueScope: { kind: 'desktop' } })?.queuedMessageId)
      expect(fixture.recover()).toBe(0)
      expect(fixture.commands.runtimeTriggers.read('orphaned-sync')?.state).toBe('matched')
      expect(fixture.commands.scopedQueue.readReceipt({ sessionId: fixture.receiver.id, requestId: fixture.requestId,
        queueScope: { kind: 'desktop' } })).toMatchObject({ state: 'queued' })
      expect(fixture.wake).not.toHaveBeenCalled()
    } finally { fixture.db.close() }
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

  it.each([
    { ending: 'SDK pause timeout', incoming: 'ordinary message' },
    { ending: 'active cancellation', incoming: 'ordinary message' },
    { ending: 'SDK pause timeout', incoming: 'cross-session message' },
    { ending: 'active cancellation', incoming: 'cross-session message' }
  ])('wakes the real desktop drainer after $ending releases a sync marker before a $incoming', async ({ ending, incoming }) => {
    const db = createMemoryAppDb()
    try {
      const commands = createSessionCommands(db)
      const source = createSession(db, { name: `sync source ${ending} ${incoming}` })
      const receiver = createSession(db, { name: `sync receiver ${ending} ${incoming}` })
      const now = 1_000
      const scope = { kind: 'desktop' } as const
      const triggerId = `sync-release-${ending.replaceAll(' ', '-')}-${incoming.replaceAll(' ', '-')}`
      const triggerRequestId = `runtime-trigger:${triggerId}`
      const condition = { type: 'session_steps' as const, targetSessionId: source.id, origin: 'registration' as const, threshold: 1,
        mode: 'sync' as const, pauseTimeoutMs: 60_000, onPauseTimeout: 'continue' as const }
      const binding = { bindingVersion: 1 as const, requestId: triggerRequestId, ownerSessionId: source.id, receiverSessionId: receiver.id,
        queueScope: scope, sourceIdentity: condition, payloadDigest: 'source-digest', policyRevision: 'policy',
        authorizationGeneration: 'authorization', runtimeGeneration: 'runtime' }
      insertRuntimeTrigger(commands, { id: triggerId, ownerSessionId: source.id, receiverSessionId: receiver.id, clientKey: triggerId,
        definition: { version: 1, condition, sourceBaseline: { settledCount: 0 } }, state: 'waiting', createdAt: now,
        expiresAt: now + 60_000, attempts: 0, revision: 1, updatedAt: now, result: { authorization: binding } })

      const dispatched: string[] = []
      let activeTurns = 0
      const drainer = createOutboundDrainer({
        submitOutbound: async (intent) => {
          const context = intent.contextIntent
          if (context?.kind !== 'reuse-user' || !context.requestId) throw new Error('ordinary queued turn intent missing')
          claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver.id, userMessageId: context.currentUser.message.id,
            turnId: `turn:${context.requestId}`, assistantMessageId: `assistant:${context.requestId}`, requestId: context.requestId,
            queueScope: scope, source: 'ordinary-desktop' })
          dispatched.push(`ordinary:${context.requestId}`)
          activeTurns += 1
          return { accepted: 'turn-started', sessionId: receiver.id, turnId: `turn:${context.requestId}`, assistantMessage: {} as never }
        },
        listActiveCount: () => activeTurns,
        getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId),
        startAgentSession: async ({ sessionId, requestId }) => {
          expect(sessionId).toBe(receiver.id)
          const snapshot = commands.agentSessionMessages.readApprovalSnapshot({ sessionId, requestId })
          expect(snapshot).not.toBeNull()
          if (!snapshot) return 'rejected'
          const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: `decision:${requestId}`,
            permitRef: `permit:${requestId}`, ownerSessionId: source.id, targetSessionId: receiver.id,
            targetGeneration: receiver.generation, workDirProfileId: receiver.workDirProfileId || 'default', requestId,
            messageId: snapshot.source.messageId, queueScope: 'desktop' as const, payloadDigest: snapshot.source.payloadSha256,
            policyRevision: 'policy', authorizationGeneration: 'authorization', runtimeGeneration: 'runtime', approvedAt: now }
          expect(commands.agentSessionMessages.refreshExecutionApproval({ sessionId, requestId,
            expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: snapshot.approvalDigest ?? null, approval })).not.toBeNull()
          const current = getNextDesktopQueueInput(db, sessionId)
          if (!current || current.requestId !== requestId) return 'queue-head-waiting'
          claimQueuedTurnAtomicallyInScope(db, { sessionId, userMessageId: current.message.id, turnId: `turn:${requestId}`,
            assistantMessageId: `assistant:${requestId}`, requestId, queueScope: scope, source: 'agent-session', agentSessionFinalCheck: () => true })
          dispatched.push(`agent-session:${requestId}`)
          activeTurns += 1
          return 'started'
        },
        consumeQueued: (sessionId, messageId) => { deleteQueuedUserMessageInScope(db, messageId, scope) },
        audit: vi.fn()
      })
      let record = commands.runtimeTriggers.read(triggerId)!
      let waitingSignal: AbortSignal | undefined
      let cancelWait: (() => void) | undefined
      let releasedDrain: Promise<void> | undefined
      const hooks = createSyncCheckpointLifecycleHooks({
        sessionId: source.id, limits, now: () => now,
        listWaitingSync: (targetSessionId) => targetSessionId === source.id ? commands.runtimeTriggers.listByState('waiting', 20) : [],
        listMatchedForExecution: () => [],
        readStepFacts: async () => ({ historyVersion: 5, facts: { ok: true, settledCount: 1, settledStepIds: ['settled-step'], pendingStepIds: [] } }),
        saveProgress: (id, revision, progress) => {
          const current = commands.runtimeTriggers.read(id)
          return current && commands.runtimeTriggers.update(id, revision, { result: { ...(current.result ?? {}), syncStepProgress: progress }, updatedAt: now })
        },
        match: (id, revision, event) => commands.runtimeTriggers.update(id, revision, { state: 'matched', matchedAt: now, event, updatedAt: now }),
        expire: (id, revision) => commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: now }),
        read: (id) => { record = commands.runtimeTriggers.read(id) ?? record; return record },
        acceptPause: ({ trigger }) => commands.runtimeTriggers.update(trigger.id, trigger.revision,
          { result: { ...(trigger.result ?? {}), pauseAcceptedBySdk: true }, updatedAt: now }),
        activateDelivery: async (trigger) => {
          const marker = commands.scopedQueue.enqueue({ sessionId: receiver.id, requestId: triggerRequestId,
            content: `运行时事件待处理：${triggerId}`, queueScope: scope })
          const persisted = commands.runtimeTriggers.read(trigger.id)!
          commands.runtimeTriggers.update(persisted.id, persisted.revision, { messageId: marker.persisted.message.id, updatedAt: now })
          if (incoming === 'ordinary message') {
            enqueueQueuedUserMessageInScope(db, { sessionId: receiver.id, requestId: 'ordinary-after-sync', content: 'ordinary after sync', queueScope: scope })
          } else {
            enqueueAgentSessionMessageInScope(db, { ownerSessionId: source.id, targetSessionId: receiver.id,
              requestId: 'agent-after-sync', content: 'cross-session after sync', authorizationBinding: { marker: 'test-fact' } })
          }
          await drainer.drain(receiver.id, 'queue-enqueued')
          expect(dispatched).toEqual([])
          return 'busy'
        },
        waitForReceiverTurn: (_trigger, { signal }) => {
          waitingSignal = signal
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(String(signal.reason))), { once: true }))
        },
        cancelPendingDelivery: (trigger) => commands.scopedQueue.cancelUndispatchedRuntimeInput({ sessionId: trigger.receiverSessionId,
          requestId: triggerRequestId, queueScope: scope }),
        onQueueReleased: (sessionId) => { releasedDrain = drainer.drain(sessionId, 'capacity-released') },
        subscribeReceiver: () => () => undefined,
        readReceiver: async () => ({ kind: 'pending' }),
        registerWaiter: (_id, cancel) => { cancelWait = cancel; return () => { cancelWait = undefined } },
        fail: (id, revision, code, caseId) => commands.runtimeTriggers.update(id, revision,
          { state: 'failed', result: { ...(commands.runtimeTriggers.read(id)?.result ?? {}), code, case: caseId }, updatedAt: now })
      })
      const pause = await hooks.postStep!({ invocationId: 'sync-invocation', turnId: 'source-turn', stepKey: 'sync-invocation:turn:1',
        modelTurn: 1, historyVersion: 5, hasNextStep: true, executionGeneration: 7, signal: new AbortController().signal })
      const outerSignal = new AbortController()
      const waiting = pause!.wait(outerSignal.signal)
      await vi.waitFor(() => expect(waitingSignal).toBeDefined())

      if (ending === 'SDK pause timeout') outerSignal.abort('lifecycle-pause-timeout')
      else {
        const current = commands.runtimeTriggers.read(triggerId)!
        commands.runtimeTriggers.update(current.id, current.revision, { state: 'cancelled', updatedAt: now })
        cancelWait!()
      }
      await expect(waiting).rejects.toThrow()
      await releasedDrain

      expect(commands.scopedQueue.readReceipt({ sessionId: receiver.id, requestId: triggerRequestId, queueScope: scope })).toMatchObject({ state: 'cancelled' })
      const incomingRequestId = incoming === 'ordinary message' ? 'ordinary-after-sync' : 'agent-after-sync'
      expect(commands.scopedQueue.readReceipt({ sessionId: receiver.id, requestId: incomingRequestId, queueScope: scope })).toMatchObject({ state: 'claimed' })
      expect(getNextDesktopQueueInput(db, receiver.id)).toBeNull()
      expect(dispatched).toEqual([`${incoming === 'ordinary message' ? 'ordinary' : 'agent-session'}:${incoming === 'ordinary message' ? 'ordinary-after-sync' : 'agent-after-sync'}`])
    } finally { db.close() }
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
