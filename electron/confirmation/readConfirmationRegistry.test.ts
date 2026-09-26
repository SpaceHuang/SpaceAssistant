import { describe, expect, it } from 'vitest'
import { ReadConfirmationRegistry } from './readConfirmationRegistry'

describe('ReadConfirmationRegistry', () => {
  it('大量终结调用只保留有容量上限的轻量墓碑，近期同键重放仍被拒绝', () => {
    const r = new ReadConfirmationRegistry({ now: () => 10 }, { maxEntries: 4, maxTombstones: 8, tombstoneTtlMs: 100 })
    for (let i = 0; i < 100; i++) {
      const entry = { requestId: `request-${i}`, toolUseId: `tool-${i}`, inputDigest: `digest-${i}`, factIds: [`/secret/path-${i}`], ruleId: 'rule', expiresAt: 1_000 }
      expect(r.register(entry)).toBe(true)
      if (i % 3 === 0) {
        expect(r.settle(entry.requestId, entry.toolUseId, 'rejected')).toBe(true) // 拒绝或取消
      } else if (i % 3 === 1) {
        expect(r.approve({ requestId: entry.requestId, toolUseId: entry.toolUseId, inputDigest: entry.inputDigest, approvedFactIds: entry.factIds, ruleId: entry.ruleId })).toBe(true)
        expect(r.consume(entry.requestId, entry.toolUseId)).toMatchObject({ state: 'consumed' })
      } else {
        expect(r.settle(entry.requestId, entry.toolUseId, 'expired')).toBe(true) // 超时
      }
    }
    expect(r.stats()).toEqual({ activeEntries: 0, tombstones: 8 })
    expect(r.register({ requestId: 'request-99', toolUseId: 'tool-99', inputDigest: 'replayed', factIds: ['/other/path'], ruleId: 'rule', expiresAt: 1_000 })).toBe(false)
  })

  it('墓碑到期后惰性回收并允许该键作为新调用复用', () => {
    let now = 10
    const r = new ReadConfirmationRegistry({ now: () => now }, { maxEntries: 4, maxTombstones: 8, tombstoneTtlMs: 50 })
    expect(r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd', factIds: ['/secret'], ruleId: 'rule', expiresAt: 100 })).toBe(true)
    expect(r.settle('r', 't', 'expired')).toBe(true)
    expect(r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd2', factIds: ['/new-secret'], ruleId: 'rule', expiresAt: 200 })).toBe(false)
    now = 61
    expect(r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd2', factIds: ['/new-secret'], ruleId: 'rule', expiresAt: 200 })).toBe(true)
    expect(r.stats()).toEqual({ activeEntries: 1, tombstones: 0 })
  })

  it('活跃登记达到容量上限时 fail-closed', () => {
    const r = new ReadConfirmationRegistry({ now: () => 10 }, { maxEntries: 2, maxTombstones: 2, tombstoneTtlMs: 100 })
    for (const toolUseId of ['t1', 't2']) expect(r.register({ requestId: 'r', toolUseId, inputDigest: 'd', factIds: [`f-${toolUseId}`], ruleId: 'rule', expiresAt: 100 })).toBe(true)
    expect(r.register({ requestId: 'r', toolUseId: 't3', inputDigest: 'd', factIds: ['f-t3'], ruleId: 'rule', expiresAt: 100 })).toBe(false)
    expect(r.stats()).toEqual({ activeEntries: 2, tombstones: 0 })
  })

  it('访问时回收自然过期的完整登记并留下无路径墓碑', () => {
    let now = 10
    const r = new ReadConfirmationRegistry({ now: () => now }, { maxEntries: 4, maxTombstones: 8, tombstoneTtlMs: 100 })
    expect(r.register({ requestId: 'expired-request', toolUseId: 'expired-tool', inputDigest: 'd', factIds: ['/secret/private/path'], ruleId: 'rule', expiresAt: 20 })).toBe(true)
    now = 20
    expect(r.stats()).toEqual({ activeEntries: 0, tombstones: 1 })
    expect(r.register({ requestId: 'expired-request', toolUseId: 'expired-tool', inputDigest: 'd2', factIds: ['/new-path'], ruleId: 'rule', expiresAt: 200 })).toBe(false)
  })

  it('pending → approved → consumed 只能消费一次', () => {
    const r = new ReadConfirmationRegistry({ now: () => 100 })
    r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd', factIds: ['f'], ruleId: 'path-sensitive-read-confirm', expiresAt: 200 })
    expect(r.approve({ requestId: 'r', toolUseId: 't', inputDigest: 'd', approvedFactIds: ['f'] })).toBe(true)
    expect(r.consume('r', 't')).toMatchObject({ state: 'consumed', factIds: ['f'] })
    expect(r.consume('r', 't')).toBeUndefined()
    expect(r.stats()).toEqual({ activeEntries: 0, tombstones: 1 })
    expect(r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'new-digest', factIds: ['new-f'], ruleId: 'rule', expiresAt: 300 })).toBe(false)
  })
  it('同一 requestId 下支持多个 toolUseId 独立并发登记与消费', () => {
    const r = new ReadConfirmationRegistry({ now: () => 10 })
    for (const toolUseId of ['t1', 't2']) {
      expect(r.register({ requestId: 'same-request', toolUseId, inputDigest: `d-${toolUseId}`, factIds: [`f-${toolUseId}`], ruleId: 'rule', expiresAt: 100 })).toBe(true)
    }
    expect(r.approve({ requestId: 'same-request', toolUseId: 't1', inputDigest: 'd-t1', approvedFactIds: ['f-t1'] })).toBe(true)
    expect(r.approve({ requestId: 'same-request', toolUseId: 't2', inputDigest: 'd-t2', approvedFactIds: ['f-t2'] })).toBe(true)
    expect(r.consume('same-request', 't1')).toMatchObject({ toolUseId: 't1', state: 'consumed' })
    expect(r.consume('same-request', 't2')).toMatchObject({ toolUseId: 't2', state: 'consumed' })
  })

  it('拒绝部分批准、绑定不匹配和过期登记', () => {
    const r = new ReadConfirmationRegistry({ now: () => 100 })
    r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd', factIds: ['f1', 'f2'], ruleId: 'rule', expiresAt: 100 })
    expect(r.approve({ requestId: 'r', toolUseId: 't', inputDigest: 'd', approvedFactIds: ['f1'] })).toBe(false)
    expect(r.approve({ requestId: 'r', toolUseId: 'x', inputDigest: 'd', approvedFactIds: ['f1', 'f2'] })).toBe(false)
    expect(r.approve({ requestId: 'r', toolUseId: 't', inputDigest: 'd', approvedFactIds: ['f1', 'f2'] })).toBe(false)
    expect(r.consume('r', 't')).toBeUndefined()
  })

  it('拒绝或取消可将 pending 终结，终结后不再接受迟到批准', () => {
    const r = new ReadConfirmationRegistry({ now: () => 10 })
    r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd', factIds: ['f'], ruleId: 'rule', expiresAt: 100 })
    expect(r.settle('r', 't', 'rejected')).toBe(true)
    expect(r.approve({ requestId: 'r', toolUseId: 't', inputDigest: 'd', approvedFactIds: ['f'] })).toBe(false)
    expect(r.settle('r', 't', 'expired')).toBe(false)
    expect(r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd', factIds: ['f'], ruleId: 'rule', expiresAt: 100 })).toBe(false)
  })

  it('超时将 pending 标记为 expired', () => {
    const r = new ReadConfirmationRegistry({ now: () => 10 })
    r.register({ requestId: 'r', toolUseId: 't', inputDigest: 'd', factIds: ['f'], ruleId: 'rule', expiresAt: 100 })
    expect(r.settle('r', 't', 'expired')).toBe(true)
    expect(r.approve({ requestId: 'r', toolUseId: 't', inputDigest: 'd', approvedFactIds: ['f'] })).toBe(false)
  })
})
