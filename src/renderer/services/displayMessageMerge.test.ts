import { describe, expect, it } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  ackDisplayEntryPersisted,
  appendOptimisticDisplayEntry,
  mergeDisplayEntries
} from './displayMessageMerge'

function m(id: string, ts: number, content = id): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content,
    timestamp: ts,
    status: 'sent',
    schemaVersion: 1
  }
}

describe('mergeDisplayEntries', () => {
  it('orders persisted by sequence not timestamp', () => {
    const merged = mergeDisplayEntries(
      [],
      [
        { message: m('b', 1), sequence: 1 },
        { message: m('a', 99), sequence: 0 }
      ]
    )
    expect(merged.map((e) => e.message.id)).toEqual(['a', 'b'])
  })

  it('keeps optimistic after persisted and sorts by ordinal', () => {
    const base = mergeDisplayEntries([], [{ message: m('p0', 1), sequence: 0 }])
    const withOpt = appendOptimisticDisplayEntry(base, m('o1', 0), 1)
    const withOpt2 = appendOptimisticDisplayEntry(withOpt, m('o0', 50), 0)
    expect(withOpt2.map((e) => e.message.id)).toEqual(['p0', 'o0', 'o1'])
  })

  it('dedupes by id and upgrades order on ack even if acks arrive out of order', () => {
    let entries = appendOptimisticDisplayEntry([], m('x', 1), 0)
    entries = appendOptimisticDisplayEntry(entries, m('y', 2), 1)
    entries = ackDisplayEntryPersisted(entries, 'y', 5)
    entries = ackDisplayEntryPersisted(entries, 'x', 4)
    expect(entries.map((e) => ({ id: e.message.id, order: e.order }))).toEqual([
      { id: 'x', order: { kind: 'persisted', sequence: 4 } },
      { id: 'y', order: { kind: 'persisted', sequence: 5 } }
    ])
  })

  it('incoming page updates existing id in place without timestamp reinsert', () => {
    const current = mergeDisplayEntries([], [{ message: m('a', 1, 'old'), sequence: 0 }])
    const merged = mergeDisplayEntries(current, [{ message: m('a', 999, 'new'), sequence: 0 }])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.message.content).toBe('new')
    expect(merged[0]?.order).toEqual({ kind: 'persisted', sequence: 0 })
  })
})
