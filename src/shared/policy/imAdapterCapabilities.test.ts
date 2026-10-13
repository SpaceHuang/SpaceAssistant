import { describe, expect, it } from 'vitest'
import { resolveImAdapterCapability } from './imAdapterCapabilities'
import { matchesImIdentityBinding, validateImChannelContract, type ImChannelContract } from './imChannelContract'
import { imEffectiveActionFor } from './imPolicyBehavior'

describe('IM adapter capability availability', () => {
  it('does not enable auto-review when a channel contract is missing a required safety capability', () => {
    const complete: ImChannelContract = {
      channelId: 'fake-im',
      declaredCapabilityIds: [],
      trustedIdentity: true,
      verifiedPrivateChat: true,
      capabilityDeclaration: true,
      factExtraction: true,
      controlledReply: true,
      todoIdentityBinding: true
    }
    for (const capability of ['trustedIdentity', 'verifiedPrivateChat', 'capabilityDeclaration', 'factExtraction', 'controlledReply', 'todoIdentityBinding'] as const) {
      expect(validateImChannelContract({ ...complete, [capability]: false })).toEqual({
        enabled: false, reason: 'required-safety-capability-missing', missing: [capability]
      })
    }
    expect(validateImChannelContract(complete)).toEqual({ enabled: true, channelId: 'fake-im' })
  })

  it('lets a third fake channel reuse the shared policy contract without channel-specific security settings', () => {
    const fakeAdapter = {
      contract: { channelId: 'fake-im', declaredCapabilityIds: [], trustedIdentity: true, verifiedPrivateChat: true, capabilityDeclaration: true,
        factExtraction: true, controlledReply: true, todoIdentityBinding: true } satisfies ImChannelContract,
      resolvePolicy: () => imEffectiveActionFor('im', 'standard', { id: 'im-low-risk-create', action: 'ask' })
    }
    expect(validateImChannelContract(fakeAdapter.contract)).toEqual({ enabled: true, channelId: 'fake-im' })
    expect(fakeAdapter.resolvePolicy()).toBe('auto-evaluator')
    expect(resolveImAdapterCapability('fake-im', 'workspace.file.write')).toEqual({
      available: false, disposition: 'capability-unavailable', reason: 'unknown-channel'
    })
  })

  it('rejects malformed channel ids rather than creating a policy identity', () => {
    const resolution = validateImChannelContract({ channelId: 'Feishu / admin', declaredCapabilityIds: [], trustedIdentity: true,
      verifiedPrivateChat: true, capabilityDeclaration: true, factExtraction: true, controlledReply: true, todoIdentityBinding: true })
    expect(resolution).toMatchObject({ enabled: false, reason: 'invalid-channel-id' })
  })

  it('isolates deferred approval identity across channels, owners, and origin sessions', () => {
    const todo = { channelId: 'feishu', identityKey: 'user-1', ownerId: 'owner-1', originSessionId: 'session-1' }
    expect(matchesImIdentityBinding(todo, { ...todo })).toBe(true)
    expect(matchesImIdentityBinding(todo, { ...todo, channelId: 'wechat' })).toBe(false)
    expect(matchesImIdentityBinding(todo, { ...todo, identityKey: 'user-2' })).toBe(false)
    expect(matchesImIdentityBinding(todo, { ...todo, ownerId: 'owner-2' })).toBe(false)
    expect(matchesImIdentityBinding(todo, { ...todo, originSessionId: 'session-2' })).toBe(false)
    expect(matchesImIdentityBinding(todo, { ...todo, originSessionId: '' })).toBe(false)
  })

  it('separates shared and Feishu-only capabilities from policy permission', () => {
    expect(resolveImAdapterCapability('wechat', 'workspace.file.write')).toMatchObject({ available: true })
    expect(resolveImAdapterCapability('feishu', 'workspace.file.write')).toMatchObject({ available: true })
    expect(resolveImAdapterCapability('feishu', 'feishu.resource.write')).toMatchObject({ available: true })
    expect(resolveImAdapterCapability('wechat', 'feishu.resource.write')).toEqual({
      available: false, disposition: 'capability-unavailable', reason: 'unsupported-channel'
    })
  })

  it('fails closed for unknown capability identity', () => {
    expect(resolveImAdapterCapability('wechat', 'unregistered.capability')).toEqual({
      available: false, disposition: 'capability-unavailable', reason: 'unknown-capability'
    })
    expect(resolveImAdapterCapability('telegram', 'workspace.file.write')).toEqual({
      available: false, disposition: 'capability-unavailable', reason: 'unknown-channel'
    })
  })

  it('capability support does not grant shared policy permission', () => {
    const capability = resolveImAdapterCapability('feishu', 'feishu.resource.write')
    expect(capability.available).toBe(true)
    expect(imEffectiveActionFor('im', 'standard', { id: 'im-lark-low-write-review', action: 'ask' })).toBe('auto-evaluator')
  })
})
