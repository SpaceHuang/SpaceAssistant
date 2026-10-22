import { describe, expect, expectTypeOf, it } from 'vitest'
import type { MaintenanceReason, SessionLedgerRecoveryBindings, SessionStorageHost, StorageLifecycleControl } from './ports'

describe('session storage host contracts', () => {
  it('composes storage startup and lifecycle behind host-owned bindings', () => {
    expectTypeOf<MaintenanceReason>().toEqualTypeOf<'startup' | 'window-ready' | 'policy-changed' | 'scope-changed' | 'capacity-pressure' | 'retry'>()
    expectTypeOf<SessionStorageHost['lifecycle']>().toMatchTypeOf<StorageLifecycleControl>()
    expectTypeOf<SessionStorageHost['startup']['recoverHistory']>().toBeCallableWith()
    expectTypeOf<SessionStorageHost['ledgerRecovery']>().toMatchTypeOf<SessionLedgerRecoveryBindings>()
    expectTypeOf<SessionStorageHost['ledgerRecovery']['getAllowedRoots']>().toBeCallableWith({ configuredWorkDir: '/workspace', profilesJson: undefined })
    expect(true).toBe(true)
  })
})
