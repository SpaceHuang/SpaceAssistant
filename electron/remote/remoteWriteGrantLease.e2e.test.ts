import { describe, expect, it, beforeEach } from 'vitest'
import {
  isRequestLeaseOwner,
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from './remoteAgentRegistry'
import { remoteWriteGrantRegistry } from './remoteWriteGrantRegistry'

/**
 * End-to-end gate matching toolChatLoop's sync check before remote write:
 * generation + owner + lease must all pass before reserve can succeed.
 */
function canRemoteWrite(args: {
  channel: 'feishu' | 'wechat'
  owner: string
  originSessionId: string
  workDirProfileId: string
  authorizationGeneration: number
  requestId: string
  byteCount: number
}): boolean {
  if (!isRequestLeaseOwner(args.originSessionId, args.requestId)) return false
  const reserved = remoteWriteGrantRegistry.reserve({
    channel: args.channel,
    owner: args.owner,
    originSessionId: args.originSessionId,
    workDirProfileId: args.workDirProfileId,
    authorizationGeneration: args.authorizationGeneration,
    byteCount: args.byteCount
  })
  return reserved.ok
}

describe('remote write grant + lease gate', () => {
  beforeEach(() => {
    resetRunningRemoteAgentRegistryForTests()
    remoteWriteGrantRegistry.clearAll()
  })

  it('blocks cross-owner reuse of an existing grant', () => {
    tryClaimRemoteSession('s1', 'req-1', 3)
    remoteWriteGrantRegistry.issue({
      channel: 'feishu',
      owner: 'ou_a',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 1
    })

    expect(
      canRemoteWrite({
        channel: 'feishu',
        owner: 'ou_b',
        originSessionId: 's1',
        workDirProfileId: 'wd1',
        authorizationGeneration: 1,
        requestId: 'req-1',
        byteCount: 10
      })
    ).toBe(false)

    expect(
      canRemoteWrite({
        channel: 'feishu',
        owner: 'ou_a',
        originSessionId: 's1',
        workDirProfileId: 'wd1',
        authorizationGeneration: 1,
        requestId: 'req-1',
        byteCount: 10
      })
    ).toBe(true)
  })

  it('blocks write when requestId is not the lease owner', () => {
    tryClaimRemoteSession('s1', 'req-owner', 3)
    remoteWriteGrantRegistry.issue({
      channel: 'wechat',
      owner: 'u1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0
    })

    expect(
      canRemoteWrite({
        channel: 'wechat',
        owner: 'u1',
        originSessionId: 's1',
        workDirProfileId: 'wd1',
        authorizationGeneration: 0,
        requestId: 'req-other',
        byteCount: 1
      })
    ).toBe(false)
  })

  it('blocks write after lease is released', () => {
    tryClaimRemoteSession('s1', 'req-1', 3)
    remoteWriteGrantRegistry.issue({
      channel: 'wechat',
      owner: 'u1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0
    })
    releaseRemoteSession('s1', 'req-1')

    expect(
      canRemoteWrite({
        channel: 'wechat',
        owner: 'u1',
        originSessionId: 's1',
        workDirProfileId: 'wd1',
        authorizationGeneration: 0,
        requestId: 'req-1',
        byteCount: 1
      })
    ).toBe(false)
  })
})
