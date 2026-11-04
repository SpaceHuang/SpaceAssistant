import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { createRuntimeTriggerRecovery } from './recovery'
import { beginManagedProcess, finishManagedProcess, resetManagedProcessSourceForTests } from './processSource'
import { evaluateRuntimeTriggerSource } from './sources'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'
import { createRuntimeTriggerDelivery } from './delivery'

function matched(overrides: Partial<RuntimeTriggerRecord> = {}): RuntimeTriggerRecord {
  return { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'key',
    definition: { version: 1, condition: { type: 'time', at: '2026-01-01T00:00:00.000Z', taskPrompt: 'safe task' }, sourceBaseline: {} },
    state: 'matched', createdAt: 1, expiresAt: 9_999_999, matchedAt: 1_000, event: { type: 'time', taskPrompt: 'safe task' },
    attempts: 0, revision: 1, updatedAt: 1, ...overrides }
}

describe('runtime trigger recovery and delivery lifecycle', () => {
  afterEach(() => { vi.useRealTimers() })

  it('recovers a pre-expiry time fact from SQLite and delivers it once after expiry', async () => {
    const db = createMemoryAppDb()
    try {
      const commands = createSessionCommands(db)
      const owner = createSession(db, { name: 'offline-owner' }).id
      const receiver = createSession(db, { name: 'offline-receiver' }).id
      const due = Date.parse('2030-01-01T00:00:00Z')
      let timestamp = due - 1000
      const scope = { kind: 'desktop' } as const
      const service = createRuntimeTriggerService(commands, { now: () => timestamp, authorize: () => true, authorizeTarget: () => true })
      const created = await service.register({ ownerSessionId: owner, params: { clientKey: 'offline-recovery', receiverSessionId: receiver,
        expiresAt: due, condition: { type: 'time', at: new Date(due).toISOString(), taskPrompt: 'wake once' } } })
      timestamp = due + 60_000
      const delivery = createRuntimeTriggerDelivery({ now: () => timestamp, read: (id) => commands.runtimeTriggers.read(id),
        update: (id, revision, patch) => commands.runtimeTriggers.update(id, revision, patch),
        expire: (id, revision) => commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: timestamp }),
        authorize: (trigger, queueScope) => ({ bindingVersion: 1, requestId: `runtime-trigger:${trigger.id}`, ownerSessionId: owner,
          receiverSessionId: receiver, queueScope, sourceIdentity: trigger.definition.condition, payloadDigest: 'offline-payload',
          policyRevision: 'policy', authorizationGeneration: 'auth', runtimeGeneration: 'runtime' }),
        queueScope: () => scope, enqueue: (request) => commands.scopedQueue.enqueue(request),
        readReceipt: (request) => commands.scopedQueue.readReceipt(request) })
      const recovery = createRuntimeTriggerRecovery({
        listWaiting: () => commands.runtimeTriggers.listByState('waiting', 4096), listMatched: () => commands.runtimeTriggers.listByState('matched', 4096),
        read: (id) => commands.runtimeTriggers.read(id),
        evaluateWaiting: (trigger, now) => evaluateRuntimeTriggerSource(trigger, { now }),
        match: (id, revision, event) => commands.runtimeTriggers.update(id, revision, { state: 'matched', matchedAt: timestamp, event, updatedAt: timestamp }),
        expire: (id, revision) => commands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: timestamp }),
        fail: (id, revision, code, caseId) => commands.runtimeTriggers.update(id, revision, { state: 'failed', result: { code, case: caseId }, updatedAt: timestamp }),
        deliver: delivery, update: (id, revision, patch) => commands.runtimeTriggers.update(id, revision, patch),
        readReceipt: (trigger) => commands.scopedQueue.readReceipt({ sessionId: receiver, requestId: `runtime-trigger:${trigger.id}`, queueScope: scope }),
        isSessionBusy: () => true, startReceiver: () => 'busy', readTurnTerminal: () => ({ kind: 'active' }), now: () => timestamp
      })
      await recovery.scan()
      const matched = commands.runtimeTriggers.read(created.trigger.triggerId)
      expect(matched).toMatchObject({ state: 'matched', event: { occurredAt: due }, messageId: expect.any(String) })
      expect(commands.scopedQueue.readReceipt({ sessionId: receiver, requestId: `runtime-trigger:${created.trigger.triggerId}`, queueScope: scope }))
        .toMatchObject({ queuedMessageId: matched!.messageId })
      await recovery.scan()
      expect(commands.scopedQueue.readReceipt({ sessionId: receiver, requestId: `runtime-trigger:${created.trigger.triggerId}`, queueScope: scope }))
        .toMatchObject({ queuedMessageId: matched!.messageId })
      expect(commands.runtimeTriggers.read(created.trigger.triggerId)?.state).toBe('matched')
    } finally { db.close() }
  })

  it('stops the recovery timer idempotently and admits no later scans', async () => {
    vi.useFakeTimers()
    const evaluateWaiting = vi.fn(() => ({ kind: 'none' as const }))
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [matched({ state: 'waiting' })], listMatched: () => [], read: () => null,
      evaluateWaiting, match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver: vi.fn(() => ({ kind: 'deferred' as const, case: 'none' })),
      update: vi.fn(() => null), readReceipt: () => undefined, isSessionBusy: () => false,
      startReceiver: vi.fn(() => 'unavailable' as const), readTurnTerminal: vi.fn(() => ({ kind: 'missing' as const })), intervalMs: 100
    })
    recovery.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(evaluateWaiting).toHaveBeenCalledTimes(2)
    recovery.stop()
    recovery.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(evaluateWaiting).toHaveBeenCalledTimes(2)
    recovery.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(evaluateWaiting).toHaveBeenCalledTimes(3)
    recovery.stop()
  })

  it('advances matched recovery pages so legacy backlog cannot starve newer triggers', async () => {
    const rows = Array.from({ length: 4_097 }, (_, index) => matched({ id: `trigger-${String(index).padStart(4, '0')}`,
      createdAt: index + 1, updatedAt: index + 1 }))
    const delivered: string[] = []
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [],
      listMatched: (after) => rows.filter((row) => !after || row.createdAt > after.createdAt || (row.createdAt === after.createdAt && row.id > after.id)).slice(0, 4_096),
      read: (id) => rows.find((row) => row.id === id) ?? null, evaluateWaiting: () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver: (id) => { delivered.push(id); return { kind: 'deferred', case: 'queued' } },
      update: vi.fn(() => null), readReceipt: () => undefined, isSessionBusy: () => true, startReceiver: () => 'busy',
      readTurnTerminal: () => ({ kind: 'active' })
    })
    await recovery.scan()
    expect(delivered).toHaveLength(4_096)
    await recovery.scan()
    expect(delivered).toHaveLength(4_097)
    expect(delivered.at(-1)).toBe('trigger-4096')
  })

  it('waits for an active durable scan to settle before shutdown proceeds', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const evaluateWaiting = vi.fn(async () => { await gate; return { kind: 'none' as const } })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [matched({ state: 'waiting' })], listMatched: () => [], read: () => null,
      evaluateWaiting, match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver: vi.fn(() => ({ kind: 'deferred' as const, case: 'none' })),
      update: vi.fn(() => null), readReceipt: () => undefined, isSessionBusy: () => false,
      startReceiver: vi.fn(() => 'unavailable' as const), readTurnTerminal: vi.fn(() => ({ kind: 'missing' as const }))
    })
    const scan = recovery.scan()
    await vi.waitFor(() => expect(evaluateWaiting).toHaveBeenCalledOnce())
    let stopped = false
    const quiescence = recovery.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await Promise.all([scan, quiescence])
    expect(stopped).toBe(true)
  })

  it('keeps busy receivers queued without consuming the delivery retry budget', async () => {
    let record = matched()
    const update = vi.fn((_id: string, _revision: number, patch: Partial<RuntimeTriggerRecord>) => { record = { ...record, ...patch, revision: record.revision + 1 }; return record })
    const startReceiver = vi.fn(async () => 'busy' as const)
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver: vi.fn(() => ({ kind: 'enqueued', messageId: 'marker-1' })), update,
      readReceipt: () => ({ queuedMessageId: 'marker-1', state: 'queued' }), isSessionBusy: () => true,
      startReceiver, readTurnTerminal: vi.fn(async () => ({ kind: 'active' })), now: () => 2_000
    })
    await recovery.scan()
    expect(record.attempts).toBe(0)
    expect(startReceiver).not.toHaveBeenCalled()
  })

  it('removes expired no-match source rows from the bounded waiting scan on the first recovery pass', async () => {
    let record = matched({ state: 'waiting', expiresAt: 10 })
    const evaluateWaiting = vi.fn(() => ({ kind: 'expired' as const, case: 'source-expired' }))
    const expire = vi.fn((_id: string, _revision: number) => { record = { ...record, state: 'expired', revision: record.revision + 1 } })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => record.state === 'waiting' ? [record] : [], listMatched: () => [], read: () => record,
      evaluateWaiting, match: vi.fn(), expire, fail: vi.fn(), deliver: vi.fn(), update: vi.fn(() => null), readReceipt: () => undefined,
      isSessionBusy: () => false, startReceiver: vi.fn(() => 'unavailable' as const), readTurnTerminal: vi.fn(() => ({ kind: 'missing' as const })), now: () => 11
    })
    await recovery.scan()
    expect(record.state).toBe('expired')
    await recovery.scan()
    expect(evaluateWaiting).toHaveBeenCalledOnce()
  })

  it('keeps a live managed process waiting over scans and matches exactly once after its exit', async () => {
    resetManagedProcessSourceForTests()
    const process = beginManagedProcess({ sessionId: 'owner', toolName: 'run_shell' })
    let record = matched({ id: 'process-trigger', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'waiting', expiresAt: 10_000,
      definition: { version: 1, condition: { type: 'process_exit', managedProcessId: process.managedProcessId }, sourceBaseline: { runtimeGeneration: process.runtimeGeneration } } })
    const match = vi.fn((_id: string, _revision: number, event: Readonly<Record<string, unknown>>) => {
      record = { ...record, state: 'matched', revision: record.revision + 1, event }
      return record
    })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => record.state === 'waiting' ? [record] : [], listMatched: () => record.state === 'matched' ? [record] : [], read: () => record,
      evaluateWaiting: (trigger, now) => evaluateRuntimeTriggerSource(trigger, { now }), match, expire: vi.fn(), fail: vi.fn(),
      deliver: vi.fn(() => ({ kind: 'enqueued' as const, messageId: 'marker-1' })), update: vi.fn(() => record),
      readReceipt: () => ({ queuedMessageId: 'marker-1', state: 'queued' }), isSessionBusy: () => true,
      startReceiver: vi.fn(() => 'busy' as const), readTurnTerminal: vi.fn(() => ({ kind: 'active' as const })), now: () => 200
    })
    await recovery.scan()
    await recovery.scan()
    expect(record.state).toBe('waiting')
    expect(match).not.toHaveBeenCalled()
    finishManagedProcess(process, { exitCode: 0, signal: null, reason: 'process_exit', occurredAt: 300 })
    await recovery.scan()
    await recovery.scan()
    expect(record).toMatchObject({ state: 'matched', event: { managedProcessId: process.managedProcessId, occurredAt: 300 } })
    expect(match).toHaveBeenCalledOnce()
    resetManagedProcessSourceForTests()
  })

  it('retries transient delivery errors with the shared wake retry policy and fails after exhaustion', async () => {
    let record = matched()
    const update = vi.fn((_id: string, _revision: number, patch: Partial<RuntimeTriggerRecord>) => { record = { ...record, ...patch, revision: record.revision + 1 }; return record })
    const fail = vi.fn((_id: string, _revision: number, _code: string, _caseId: string) => { record = { ...record, state: 'failed', revision: record.revision + 1 }; return record })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail, deliver: vi.fn(() => ({ kind: 'failed', case: 'delivery-write-conflict' })), update,
      readReceipt: () => undefined, isSessionBusy: () => false, startReceiver: vi.fn(async () => 'started'),
      readTurnTerminal: vi.fn(async () => ({ kind: 'active' })), now: () => 2_000, random: () => 0.5
    })
    await recovery.scan()
    expect(record.attempts).toBe(1)
    expect(record.nextAttemptAt).toBe(3_000)
    expect(fail).not.toHaveBeenCalled()
  })

  it('stops retrying at the configured attempt ceiling', async () => {
    let record = matched()
    let now = 2_000
    const update = vi.fn((_id: string, _revision: number, patch: Partial<RuntimeTriggerRecord>) => {
      record = { ...record, ...patch, revision: record.revision + 1 }
      return record
    })
    const fail = vi.fn((_id: string, _revision: number, _code: string, caseId: string) => {
      record = { ...record, state: 'failed', result: { case: caseId }, revision: record.revision + 1 }
    })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => record.state === 'matched' ? [record] : [], read: () => record,
      evaluateWaiting: () => ({ kind: 'none' }), match: vi.fn(), expire: vi.fn(), fail,
      deliver: vi.fn(() => ({ kind: 'failed' as const, case: 'transient-queue-write' })), update,
      readReceipt: () => undefined, isSessionBusy: () => false, startReceiver: vi.fn(() => 'busy' as const),
      readTurnTerminal: vi.fn(() => ({ kind: 'active' as const })), now: () => now,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, maxElapsedMs: 60_000, jitterRatio: 0, random: () => 0 }
    })
    await recovery.scan()
    expect(record).toMatchObject({ state: 'matched', attempts: 1 })
    now = record.nextAttemptAt!
    await recovery.scan()
    expect(record.state).toBe('failed')
    expect(fail).toHaveBeenCalledWith('trigger-1', 2, 'TRIGGER_DELIVERY_FAILED', 'delivery-retries-exhausted')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('settles a trigger from the exact persisted receiver Turn terminal', async () => {
    let record = matched({ messageId: 'marker-1' })
    const update = vi.fn((_id: string, _revision: number, patch: Partial<RuntimeTriggerRecord>) => { record = { ...record, ...patch, revision: record.revision + 1 }; return record })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver: vi.fn(), update,
      readReceipt: () => ({ queuedMessageId: 'marker-1', turnId: 'receiver-turn', state: 'claimed' }), isSessionBusy: () => true,
      startReceiver: vi.fn(), readTurnTerminal: vi.fn(async () => ({ kind: 'terminal', outcome: 'completed' })), now: () => 2_000
    })
    await recovery.scan()
    expect(record.state).toBe('completed')
    expect(record.result).toMatchObject({ receiverTurnId: 'receiver-turn' })
  })

  it('reports the original receiver startup error before recording a retryable delivery failure', async () => {
    const record = matched({ messageId: 'marker-1' })
    const startupError = new Error('PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH')
    const onDeliveryError = vi.fn()
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver: vi.fn(), update: vi.fn(() => record),
      readReceipt: () => ({ queuedMessageId: 'marker-1', state: 'queued' }), isSessionBusy: () => false,
      startReceiver: vi.fn(async () => { throw startupError }), readTurnTerminal: vi.fn(async () => ({ kind: 'active' })),
      onDeliveryError
    })
    await recovery.scan()
    expect(onDeliveryError).toHaveBeenCalledExactlyOnceWith('trigger-1', startupError)
  })

  it('does not redeliver after a persisted fixed-request receipt is recovered', async () => {
    let record = matched({ messageId: 'marker-1' })
    const deliver = vi.fn(() => { throw new Error('must reuse original receipt') })
    const startReceiver = vi.fn(async () => 'busy' as const)
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver, update: vi.fn(() => record),
      readReceipt: () => ({ queuedMessageId: 'marker-1', state: 'queued' }), isSessionBusy: () => false,
      startReceiver, readTurnTerminal: vi.fn(async () => ({ kind: 'active' })), now: () => 2_000
    })
    await recovery.scan()
    await recovery.scan()
    expect(deliver).not.toHaveBeenCalled()
    expect(startReceiver).toHaveBeenCalledTimes(2)
    expect(startReceiver).toHaveBeenCalledWith({ sessionId: 'receiver', requestId: 'runtime-trigger:trigger-1', messageId: 'marker-1' })
  })

  it('keeps a sync match inert until the SDK has persisted pause acceptance', async () => {
    const record = matched({ definition: { version: 1, condition: { type: 'session_steps', targetSessionId: 'owner', origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: 1000, onPauseTimeout: 'fail' }, sourceBaseline: {} } })
    const deliver = vi.fn()
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail: vi.fn(), deliver, update: vi.fn(() => record), readReceipt: () => undefined,
      isSessionBusy: () => false, startReceiver: vi.fn(), readTurnTerminal: vi.fn(async () => ({ kind: 'active' })), now: () => 2_000
    })
    await recovery.scan()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('settles permanently unavailable receivers instead of leaving a matched row retrying forever', async () => {
    let record = matched({ messageId: 'marker-1' })
    const fail = vi.fn((_id: string, _revision: number, _code: string, _caseId: string) => { record = { ...record, state: 'failed', revision: record.revision + 1 } })
    const recovery = createRuntimeTriggerRecovery({
      listWaiting: () => [], listMatched: () => [record], read: () => record, evaluateWaiting: async () => ({ kind: 'none' }),
      match: vi.fn(), expire: vi.fn(), fail, deliver: vi.fn(), update: vi.fn(() => record),
      readReceipt: () => ({ queuedMessageId: 'marker-1', state: 'queued' }), isSessionBusy: () => false,
      startReceiver: vi.fn(async () => 'unavailable' as const), readTurnTerminal: vi.fn(async () => ({ kind: 'active' })), now: () => 2_000
    })
    await recovery.scan()
    expect(record.state).toBe('failed')
    expect(fail).toHaveBeenCalledWith('trigger-1', 1, 'TRIGGER_DELIVERY_FAILED', 'receiver-unavailable')
  })
})
