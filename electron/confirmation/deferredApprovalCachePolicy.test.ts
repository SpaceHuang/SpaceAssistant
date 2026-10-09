import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { DeferredApprovalResult } from '../../src/shared/confirmation/deferredApprovalResult'
import { createDeferredApprovalAdapter } from './deferredApprovalAdapter'
import { deferredApprovalCachePolicy } from './deferredApprovalCachePolicy'

describe('deferred approval cache policy', () => {
  it('never grants long-term cache writes to ordinary todo outcomes', () => {
    const write = vi.fn()
    for (const input of [
      { lane: 'wechat', verdict: 'approve', actionClass: 'write' },
      { lane: 'feishu', verdict: 'deny', actionClass: 'write' },
      { lane: 'wechat', verdict: 'approve', actionClass: 'outbound' },
      { lane: 'desktop', verdict: 'approve', actionClass: 'write' },
      { lane: 'automation', verdict: 'approve', actionClass: 'execute' },
      { lane: 'feishu', verdict: 'locked', actionClass: 'write' },
      { lane: 'feishu', verdict: 'critical', actionClass: 'write' }
    ] as const) {
      const decision = deferredApprovalCachePolicy(input)
      expect(decision).toEqual({ allowed: false, reason: 'deferred-approval-never-writes-memory' })
      if (decision.allowed) write()
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('deferred result contract carries no cache key or remembered decision', () => {
    expectTypeOf<DeferredApprovalResult>().not.toHaveProperty('memory')
    const result: DeferredApprovalResult = { kind: 'deferred', todoId: 'todo-no-memory' }
    expect(result).toEqual({ kind: 'deferred', todoId: 'todo-no-memory' })
    // @ts-expect-error deferred outcomes have no memory write payload
    expect(result.memory).toBeUndefined()
  })

  it('adapter accepts no cache writer and does not return one with a deferred outcome', async () => {
    const write = vi.fn()
    const adapter = createDeferredApprovalAdapter({
      admission: { defer: async () => ({ kind: 'deferred' }) },
      dispatch: vi.fn()
    })
    const result = await adapter.resolve({ approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'ok' } } },
      eligibility: { kind: 'eligible', todoId: 'todo-cache' }, todo: { todoId: 'todo-cache', invocationId: 'inv', reservationId: 'res', originSessionId: 's', identityKey: 'i' }, ttlMs: 10 })
    expect(result).toMatchObject({ kind: 'deferred' })
    expect(write).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('memory')
  })

  it('普通待办追认不调用决策缓存写入入口', async () => {
    const { recordUserAnswerFromMemoryTiers } = await import('./decisionCacheWriter')
    const cacheWrite = vi.spyOn(await import('./decisionCacheWriter'), 'recordUserAnswerFromMemoryTiers')
    const adapter = createDeferredApprovalAdapter({ admission: { defer: async () => ({ kind: 'deferred' }) }, dispatch: vi.fn() })
    const result = await adapter.resolve({ approval: { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } },
      eligibility: { kind: 'eligible', todoId: 'todo-no-cache' }, todo: { todoId: 'todo-no-cache', invocationId: 'inv-no-cache', reservationId: 'res-no-cache',
        originSessionId: 'session-no-cache', identityKey: 'identity-no-cache' }, ttlMs: 1000 })
    expect(result).toMatchObject({ kind: 'deferred' })
    expect(cacheWrite).not.toHaveBeenCalled()
    expect(recordUserAnswerFromMemoryTiers).toBeTypeOf('function')
    cacheWrite.mockRestore()
  })
})
