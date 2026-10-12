import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent, HistoryPort, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { createTurnScopedHistoryMemo } from './turnScopedHistoryMemo'

function event(sequence: number): HistoryEvent {
  return {
    invocationId: 'inv-1', sequence, eventId: `evt-${sequence}`, idempotencyKey: `evt-${sequence}`,
    turnId: 'turn-1', schemaVersion: 1, kind: 'invocation-context-committed', payload: { messages: [] }
  }
}

function snapshotWith(sequence: number): HistorySnapshot {
  return { invocationId: 'inv-1', version: sequence, schemaVersion: 1, events: [event(sequence)] }
}

function fakeHistory(): HistoryPort & { readCalls: number[] } {
  const readCalls: number[] = []
  return {
    readCalls,
    read: vi.fn(async (invocationId: string) => {
      readCalls.push(Date.now())
      return snapshotWith(readCalls.length)
    }),
    appendBatch: vi.fn(async (events: readonly HistoryEvent[], expectedVersion: number) => ({ version: expectedVersion + events.length, duplicate: false }))
  }
}

describe('turn-scoped history read memo (P0-⑤)', () => {
  it('serves repeated reads of the same invocation from one underlying read', async () => {
    const underlying = fakeHistory()
    const memo = createTurnScopedHistoryMemo(underlying)

    const first = await memo.read('inv-1')
    const second = await memo.read('inv-1')
    const third = await memo.read('inv-1')

    expect(underlying.read).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('memoizes each invocation id independently within the turn', async () => {
    const underlying = fakeHistory()
    const memo = createTurnScopedHistoryMemo(underlying)

    await memo.read('inv-a')
    await memo.read('inv-b')
    await memo.read('inv-a')

    expect(underlying.read).toHaveBeenCalledTimes(2)
  })

  it('drops the memo on any append so the next read observes the new events', async () => {
    const underlying = fakeHistory()
    const memo = createTurnScopedHistoryMemo(underlying)
    await memo.read('inv-1')

    await memo.appendBatch([event(2)], 1)
    const after = await memo.read('inv-1')

    expect(underlying.read).toHaveBeenCalledTimes(2)
    expect(after.version).toBe(2)
  })

  it('propagates appendBatch results to the caller while still invalidating', async () => {
    const underlying = fakeHistory()
    const memo = createTurnScopedHistoryMemo(underlying)
    await memo.read('inv-1')

    const result = await memo.appendBatch([event(1)], 1)
    expect(result).toMatchObject({ version: 2 })
    await memo.read('inv-1')

    expect(underlying.read).toHaveBeenCalledTimes(2)
  })
})
