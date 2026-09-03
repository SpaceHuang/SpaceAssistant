import { beforeEach, describe, expect, it } from 'vitest'
import { recheckRemoteWriteAuthorization } from './remoteWriteAuthorization'
import { remoteAuthorizationRegistry } from './remoteAuthorizationRegistry'
import {
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from './remoteAgentRegistry'
import type { RemoteContext } from '../tools/types'

function ctx(overrides: Partial<RemoteContext> = {}): RemoteContext {
  return {
    source: 'wechat',
    messageId: 'm1',
    confirmPolicy: 'always',
    requestId: 'req-1',
    originSessionId: 's1',
    authOwner: 'owner-a',
    ...overrides
  }
}

describe('recheckRemoteWriteAuthorization（B3：远程写缓存命中/IM 确认后的授权复核）', () => {
  beforeEach(() => {
    resetRunningRemoteAgentRegistryForTests()
  })

  it('owner + 租约 + 代际一致时放行', () => {
    tryClaimRemoteSession('s1', 'req-1', 4)
    const gen = remoteAuthorizationRegistry.getGeneration('wechat')
    const r = recheckRemoteWriteAuthorization(ctx({ authorizationGeneration: gen }), 's1')
    expect(r.ok).toBe(true)
  })

  it('缺 authOwner 拒绝', () => {
    tryClaimRemoteSession('s1', 'req-1', 4)
    const r = recheckRemoteWriteAuthorization(ctx({ authOwner: undefined, userId: undefined }), 's1')
    expect(r.ok).toBe(false)
    expect(r.hasAuthOwner).toBe(false)
  })

  it('租约不属于当前请求时拒绝（撤销/换绑后旧请求不得再放行）', () => {
    tryClaimRemoteSession('s1', 'req-other', 4)
    const r = recheckRemoteWriteAuthorization(ctx(), 's1')
    expect(r.ok).toBe(false)
    expect(r.leaseOk).toBe(false)
  })

  it('无租约时拒绝', () => {
    const r = recheckRemoteWriteAuthorization(ctx(), 's1')
    expect(r.ok).toBe(false)
  })

  it('授权代际不一致时拒绝（invalidate 后旧快照失效）', () => {
    tryClaimRemoteSession('s1', 'req-1', 4)
    const staleGen = remoteAuthorizationRegistry.getGeneration('wechat')
    remoteAuthorizationRegistry.invalidate('wechat', 'manual')
    const r = recheckRemoteWriteAuthorization(ctx({ authorizationGeneration: staleGen }), 's1')
    expect(r.ok).toBe(false)
    expect(r.currentGeneration).toBe(staleGen + 1)
  })

  it('未携带代际快照时不做代际校验（等价既有确认路径语义）', () => {
    tryClaimRemoteSession('s1', 'req-1', 4)
    const r = recheckRemoteWriteAuthorization(ctx({ authorizationGeneration: undefined }), 's1')
    expect(r.ok).toBe(true)
  })

  it('originSessionId 缺省时回退到当前 sessionId', () => {
    tryClaimRemoteSession('s9', 'req-1', 4)
    const r = recheckRemoteWriteAuthorization(ctx({ originSessionId: undefined }), 's9')
    expect(r.ok).toBe(true)
  })
})
