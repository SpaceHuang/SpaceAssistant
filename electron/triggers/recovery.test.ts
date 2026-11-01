import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { createRuntimeTriggerRecovery } from './recovery'

function matched(overrides: Partial<RuntimeTriggerRecord> = {}): RuntimeTriggerRecord {
  return { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'key',
    definition: { version: 1, condition: { type: 'time', at: '2026-01-01T00:00:00.000Z', taskPrompt: 'safe task' }, sourceBaseline: {} },
    state: 'matched', createdAt: 1, expiresAt: 9_999_999, matchedAt: 1_000, event: { type: 'time', taskPrompt: 'safe task' },
    attempts: 0, revision: 1, updatedAt: 1, ...overrides }
}

describe('runtime trigger recovery and delivery lifecycle', () => {
  afterEach(() => { vi.useRealTimers() })

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
