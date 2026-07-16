import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRemoteSession,
  countRunningRemoteAgents,
  getRemoteAgentLease,
  isRemoteAgentRunning,
  isRequestLeaseOwner,
  reapExpiredRemoteSessions,
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from './remoteAgentRegistry'

describe('remoteAgentRegistry', () => {
  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
  })

  it('claims a free origin session', () => {
    expect(tryClaimRemoteSession('s1', 'req-1', 3)).toBe('ok')
    expect(isRemoteAgentRunning('s1')).toBe(true)
    expect(countRunningRemoteAgents()).toBe(1)
    expect(isRequestLeaseOwner('s1', 'req-1')).toBe(true)
  })

  it('returns session_busy for a different requestId claiming the same origin session', () => {
    expect(tryClaimRemoteSession('s1', 'req-1', 3)).toBe('ok')
    expect(tryClaimRemoteSession('s1', 'req-2', 3)).toBe('session_busy')
    expect(countRunningRemoteAgents()).toBe(1)
  })

  it('is idempotent when the same (originSessionId, requestId) reclaims', () => {
    expect(tryClaimRemoteSession('s1', 'req-1', 3)).toBe('ok')
    expect(tryClaimRemoteSession('s1', 'req-1', 3)).toBe('ok')
    expect(countRunningRemoteAgents()).toBe(1)
  })

  it('returns parallel_full when global cap reached', () => {
    expect(tryClaimRemoteSession('s1', 'req-1', 2)).toBe('ok')
    expect(tryClaimRemoteSession('s2', 'req-2', 2)).toBe('ok')
    expect(tryClaimRemoteSession('s3', 'req-3', 2)).toBe('parallel_full')
    expect(countRunningRemoteAgents()).toBe(2)
  })

  it('release only succeeds for the owning requestId; is idempotent and allows re-claim', () => {
    expect(tryClaimRemoteSession('s1', 'req-1', 2)).toBe('ok')
    releaseRemoteSession('s1', 'req-2') // wrong owner: no-op
    expect(isRemoteAgentRunning('s1')).toBe(true)
    releaseRemoteSession('s1', 'req-1')
    releaseRemoteSession('s1', 'req-1') // idempotent
    expect(isRemoteAgentRunning('s1')).toBe(false)
    expect(tryClaimRemoteSession('s1', 'req-3', 2)).toBe('ok')
  })

  it('isRemoteAgentRunning with exemptRequestId excludes only the current lease owner', () => {
    expect(tryClaimRemoteSession('s1', 'req-1', 2)).toBe('ok')
    expect(isRemoteAgentRunning('s1', { exemptRequestId: 'req-1' })).toBe(false)
    expect(isRemoteAgentRunning('s1', { exemptRequestId: 'req-other' })).toBe(true)
    expect(isRemoteAgentRunning('s1')).toBe(true)
  })

  it('claims are keyed by originSessionId; requestId alone does not collide across sessions', () => {
    expect(tryClaimRemoteSession('s1', 'req-shared', 3)).toBe('ok')
    expect(tryClaimRemoteSession('s2', 'req-shared', 3)).toBe('ok')
    expect(countRunningRemoteAgents()).toBe(2)
  })

  it('cancelRemoteSession invokes the cancel handle and releases only the owning requestId', () => {
    const cancel = vi.fn()
    expect(tryClaimRemoteSession('s1', 'req-1', 2, { cancel })).toBe('ok')
    expect(cancelRemoteSession('s1', 'req-2')).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(isRemoteAgentRunning('s1')).toBe(true)
    expect(cancelRemoteSession('s1', 'req-1')).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(isRemoteAgentRunning('s1')).toBe(false)
  })

  it('expired leases are reclaimable by a new requestId and force-reaped', () => {
    const cancel = vi.fn()
    const now = 1_000
    expect(tryClaimRemoteSession('s1', 'req-1', 2, { cancel, ttlMs: 1000, now })).toBe('ok')
    expect(isRemoteAgentRunning('s1', { now: now + 500 })).toBe(true)
    // Past expiry: a new requestId can claim (stale lease reclaimed), old owner no longer owns it.
    expect(tryClaimRemoteSession('s1', 'req-2', 2, { now: now + 2000 })).toBe('ok')
    expect(isRequestLeaseOwner('s1', 'req-1', now + 2000)).toBe(false)
    expect(isRequestLeaseOwner('s1', 'req-2', now + 2000)).toBe(true)
  })

  it('reapExpiredRemoteSessions removes only stale leases and fires their cancel handles', () => {
    const cancel = vi.fn()
    const now = 1_000
    // s1's lease expires quickly; s2 keeps the (long) default TTL and stays live.
    tryClaimRemoteSession('s1', 'req-1', 2, { cancel, ttlMs: 500, now })
    tryClaimRemoteSession('s2', 'req-2', 2, { now })
    expect(reapExpiredRemoteSessions(now + 1000)).toBe(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(countRunningRemoteAgents(now + 1000)).toBe(1)
    expect(isRemoteAgentRunning('s2', { now: now + 1000 })).toBe(true)
  })

  it('getRemoteAgentLease exposes a snapshot for the live lease only', () => {
    expect(getRemoteAgentLease('s1')).toBeUndefined()
    tryClaimRemoteSession('s1', 'req-1', 2)
    const snapshot = getRemoteAgentLease('s1')
    expect(snapshot).toMatchObject({ originSessionId: 's1', requestId: 'req-1' })
  })
})
