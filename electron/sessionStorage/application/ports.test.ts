import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ExecutionClaimResult, ExecutionLease, PreparedIdentity, SessionRecoveryPort, SessionExecutionStore, ContinuationRecordSnapshot } from './ports'

describe('session execution application contracts', () => {
  it('keeps execution fencing identities explicit and independent of storage handles', () => {
    expectTypeOf<keyof ExecutionLease>().toEqualTypeOf<'sessionId' | 'turnId' | 'ownerId' | 'generation'>()
    expectTypeOf<PreparedIdentity['startToken']>().toEqualTypeOf<string>()
    expectTypeOf<Extract<ExecutionClaimResult, { acquired: false }>['reason']>().toEqualTypeOf<'owned' | 'blocked'>()
    expect(true).toBe(true)
  })

  it('reports recovery readiness as application facts', () => {
    expectTypeOf<ReturnType<SessionRecoveryPort['inspectReadiness']>['readable']>().toEqualTypeOf<boolean>()
    expectTypeOf<Parameters<SessionRecoveryPort['inspectReadiness']>[0]>().toEqualTypeOf<string>()
    expect(true).toBe(true)
  })

  it('exposes continuation lifecycle facts without carrying the runtime transcript implementation', () => {
    expectTypeOf<ContinuationRecordSnapshot['continuationId']>().toEqualTypeOf('id' as string)
    expectTypeOf<ContinuationRecordSnapshot['status']>().toEqualTypeOf('pending' as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect')
    const claim = (store: SessionExecutionStore) => store.claimExecution({ sessionId: 's', turnId: 't', ownerId: 'o' })
    expect(claim).toBeTypeOf('function')
    expect(true).toBe(true)
  })
})
