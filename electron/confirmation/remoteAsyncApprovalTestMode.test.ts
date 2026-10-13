import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { isRemoteAsyncApprovalEnabledForRuntime } from './remoteAsyncApprovalRuntime'
import { getRemoteAsyncApprovalTestRunId, isRemoteAsyncApprovalTestModeEnabled, isRemoteAsyncApprovalTestTodoEnabled,
  setRemoteAsyncApprovalTestModeEnabled } from './remoteAsyncApprovalTestMode'
import { isRemoteAsyncApprovalGateEnabled } from './remoteAsyncApprovalGate'

afterEach(() => { setRemoteAsyncApprovalTestModeEnabled(false, false) })

describe('development remote async approval test mode', () => {
  it('is process-local, unavailable in packaged builds, and independent from the production release gate', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)

    expect(isRemoteAsyncApprovalTestModeEnabled()).toBe(false)
    expect(isRemoteAsyncApprovalEnabledForRuntime(db)).toBe(false)
    expect(setRemoteAsyncApprovalTestModeEnabled(true, false)).toBe(true)
    expect(isRemoteAsyncApprovalTestModeEnabled()).toBe(true)
    const firstRunId = getRemoteAsyncApprovalTestRunId()!
    expect(isRemoteAsyncApprovalEnabledForRuntime(db)).toBe(true)
    expect(isRemoteAsyncApprovalTestTodoEnabled({ policyBehaviorVersion: `im-standard-v2:dev-test:${firstRunId}` })).toBe(true)
    expect(isRemoteAsyncApprovalTestTodoEnabled({ policyBehaviorVersion: 'im-standard-v2' })).toBe(false)
    expect(isRemoteAsyncApprovalGateEnabled(db)).toBe(false)
    expect(conn.prepare('SELECT state,close_required,behavior_version FROM remote_async_approval_gate_state WHERE singleton=1').get())
      .toEqual({ state: 'disabled', close_required: 0, behavior_version: '' })
    expect(() => setRemoteAsyncApprovalTestModeEnabled(false, true)).toThrow('REMOTE_ASYNC_APPROVAL_TEST_MODE_UNAVAILABLE')
    expect(isRemoteAsyncApprovalTestModeEnabled()).toBe(true)

    setRemoteAsyncApprovalTestModeEnabled(false, false)
    expect(isRemoteAsyncApprovalTestTodoEnabled({ policyBehaviorVersion: `im-standard-v2:dev-test:${firstRunId}` })).toBe(false)
    setRemoteAsyncApprovalTestModeEnabled(true, false)
    expect(getRemoteAsyncApprovalTestRunId()).not.toBe(firstRunId)

    db.close()
  })
})
