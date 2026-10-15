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
    )).toEqual({ kind: 'deferred', todoId: 'todo-contract-1', cause: 'insufficient-delegation-evidence',
      executionState: 'not-executed', retryable: false, nextStep: 'await-user' })
  })

  it('requires structured execution state, retryability, and next step on shared deferred results', () => {
    type SharedDeferred = Extract<DeferredApprovalResult, { kind: 'deferred' }>
    expectTypeOf<SharedDeferred>().toHaveProperty('executionState')
    expectTypeOf<SharedDeferred>().toHaveProperty('retryable')
    expectTypeOf<SharedDeferred>().toHaveProperty('nextStep')
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
    expect(parseDeferredApprovalResult({ kind: 'deferred', todoId: 'todo-1', cause: 'agent-undetermined',
      executionState: 'not-executed', retryable: false, nextStep: 'await-user' }))
      .toEqual({ kind: 'deferred', todoId: 'todo-1', cause: 'agent-undetermined',
        executionState: 'not-executed', retryable: false, nextStep: 'await-user' })
    expect(parseDeferredApprovalResult({ kind: 'deferred', todoId: 'todo-1', cause: 'locked' })).toBeNull()
    expect(parseDeferredApprovalResult({ kind: 'deferred', todoId: 'todo-1', cause: 'agent-undetermined' })).toBeNull()
    expect(parseDeferredApprovalResult({ kind: 'deferred', todoId: 'todo-1', cause: 'agent-undetermined',
      executionState: 'executed', retryable: false, nextStep: 'await-user' })).toBeNull()
  })

  it.each(['agent-deny', 'unparsable', 'config-error'] as const)('round-trips terminal deny cause %s', (cause) => {
    expect(parseDeferredApprovalResult({ kind: 'deny', cause })).toEqual({ kind: 'deny', cause })
  })

  it('rejects an unknown terminal denial cause', () => {
    expect(parseDeferredApprovalResult({ kind: 'deny', cause: 'future-unknown-cause' })).toBeNull()
  })
})
