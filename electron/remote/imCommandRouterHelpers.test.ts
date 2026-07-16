import { afterEach, describe, expect, it } from 'vitest'
import { tryClaimOrRelease } from './imCommandRouterHelpers'
import {
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from './remoteAgentRegistry'
import {
  REMOTE_PARALLEL_FULL_MESSAGE,
  REMOTE_SESSION_BUSY_MESSAGE
} from './remoteSessionGuardMessages'

describe('tryClaimOrRelease', () => {
  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
  })

  it('returns release on success', () => {
    const claim = tryClaimOrRelease('s1', 'req-1', 2)
    expect(claim.ok).toBe(true)
    if (!claim.ok) return
    claim.release()
    expect(tryClaimOrRelease('s1', 'req-2', 2).ok).toBe(true)
  })

  it('selects busy message when session already claimed by another request', () => {
    tryClaimRemoteSession('s1', 'req-1', 2)
    const claim = tryClaimOrRelease('s1', 'req-2', 2)
    expect(claim).toEqual({
      ok: false,
      reason: 'session_busy',
      message: REMOTE_SESSION_BUSY_MESSAGE
    })
    releaseRemoteSession('s1', 'req-1')
  })

  it('is idempotent for the same (sessionId, requestId) pair', () => {
    tryClaimRemoteSession('s1', 'req-1', 2)
    const claim = tryClaimOrRelease('s1', 'req-1', 2)
    expect(claim.ok).toBe(true)
    releaseRemoteSession('s1', 'req-1')
  })

  it('selects parallel-full message when cap reached', () => {
    tryClaimRemoteSession('a', 'req-a', 1)
    const claim = tryClaimOrRelease('b', 'req-b', 1)
    expect(claim).toEqual({
      ok: false,
      reason: 'parallel_full',
      message: REMOTE_PARALLEL_FULL_MESSAGE
    })
  })
})
