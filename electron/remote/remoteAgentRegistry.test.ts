import { afterEach, describe, expect, it } from 'vitest'
import {
  countRunningRemoteAgents,
  isRemoteAgentRunning,
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from './remoteAgentRegistry'

describe('remoteAgentRegistry', () => {
  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
  })

  it('claims a free session', () => {
    expect(tryClaimRemoteSession('s1', 3)).toBe('ok')
    expect(isRemoteAgentRunning('s1')).toBe(true)
    expect(countRunningRemoteAgents()).toBe(1)
  })

  it('returns session_busy for duplicate claim', () => {
    expect(tryClaimRemoteSession('s1', 3)).toBe('ok')
    expect(tryClaimRemoteSession('s1', 3)).toBe('session_busy')
    expect(countRunningRemoteAgents()).toBe(1)
  })

  it('returns parallel_full when global cap reached', () => {
    expect(tryClaimRemoteSession('s1', 2)).toBe('ok')
    expect(tryClaimRemoteSession('s2', 2)).toBe('ok')
    expect(tryClaimRemoteSession('s3', 2)).toBe('parallel_full')
    expect(countRunningRemoteAgents()).toBe(2)
  })

  it('release is idempotent and allows re-claim', () => {
    expect(tryClaimRemoteSession('s1', 2)).toBe('ok')
    releaseRemoteSession('s1')
    releaseRemoteSession('s1')
    expect(isRemoteAgentRunning('s1')).toBe(false)
    expect(tryClaimRemoteSession('s1', 2)).toBe('ok')
  })
})
