import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ApprovalInvocationResult } from './types'
import { mapDeferredApprovalResult, parseDeferredApprovalResult, type DeferredApprovalResult, type DeferredApprovalEligibility } from './deferredApprovalResult'

const eligible: DeferredApprovalEligibility = { kind: 'eligible', todoId: 'todo-contract-1' }

describe('shared deferred approval result contract', () => {
  it('keeps approve, deny, undetermined, transport failures, and deferred distinct', () => {
    type Kinds = DeferredApprovalResult['kind']
    expectTypeOf<Kinds>().toEqualTypeOf<'approve' | 'deny' | 'undetermined' | 'unavailable' | 'timeout' | 'unparsable' | 'deferred'>()

    const results: Array<[ApprovalInvocationResult, DeferredApprovalEligibility, DeferredApprovalResult['kind']]> = [
      [{ ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } }, { kind: 'not-requested' }, 'approve'],
      [{ ok: true, verdict: { kind: 'deny', reason: { summary: 'denied' } } }, eligible, 'deny'],
      [{ ok: true, verdict: { kind: 'undetermined', reason: { summary: 'missing evidence' } } }, eligible, 'undetermined'],
      [{ ok: false, cause: 'unavailable' }, eligible, 'unavailable'],
      [{ ok: false, cause: 'timeout' }, eligible, 'timeout'],
      [{ ok: false, cause: 'unparsable' }, eligible, 'unparsable']
    ]
    for (const [result, eligibility, kind] of results) {
      expect(mapDeferredApprovalResult(result, eligibility).kind).toBe(kind)
    }
    expect(mapDeferredApprovalResult(
      { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } }, eligible
    )).toEqual({ kind: 'deferred', todoId: 'todo-contract-1' })
  })

  it('never maps config error, locked or critical policy, or recursion block to deferred', () => {
    const approval: ApprovalInvocationResult = { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved' } } }
    for (const eligibility of [
      { kind: 'config-error' as const }, { kind: 'locked' as const }, { kind: 'critical' as const },
      { kind: 'recursion-blocked' as const }
    ]) {
      expect(mapDeferredApprovalResult(approval, eligibility).kind).not.toBe('deferred')
    }
  })

  it('round-trips deferred cause across the shared JSON boundary and rejects unknown causes', () => {
    expect(parseDeferredApprovalResult({ kind: 'deferred', todoId: 'todo-1', cause: 'agent-undetermined' }))
      .toEqual({ kind: 'deferred', todoId: 'todo-1', cause: 'agent-undetermined' })
    expect(parseDeferredApprovalResult({ kind: 'deferred', todoId: 'todo-1', cause: 'locked' })).toBeNull()
  })
})
