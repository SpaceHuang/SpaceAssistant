import { describe, expect, it, vi } from 'vitest'
import { createDeferredImDispatchPorts } from './deferredImDispatch'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'

describe('deferred IM production dispatch ports', () => {
  it('rejects stale authorization epochs before dispatch', async () => {
    const dispatch = vi.fn()
    const ports = createDeferredImDispatchPorts({
      channel: 'feishu', getAuthorizationEpoch: () => 9, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch
    })
    const todo = { authorizationEpoch: 8 } as never
    const envelope = { executionContext: {} } as never
    await expect(ports.recheck({} as never, todo, envelope)).resolves.toEqual({ allowed: false })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('requires the persisted task revision to still own the exact deferred invocation', async () => {
    const dispatch = vi.fn()
    const ports = createDeferredImDispatchPorts({
      channel: 'wechat', getAuthorizationEpoch: () => 2, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => false, dispatch
    })
    const todo = { authorizationEpoch: 2 } as never
    const envelope = { executionContext: {} } as never
    await expect(ports.recheck({} as never, todo, envelope)).resolves.toEqual({ allowed: false })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches the intact persisted invocation only after every production fence passes', async () => {
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const ports = createDeferredImDispatchPorts({
      channel: 'feishu', getAuthorizationEpoch: () => 9, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch
    })
    const todo = { channel: 'feishu', originSessionId: 'session', ownerId: 'owner', identityKey: 'chat',
      authorizationEpoch: 9, invocationId: 'invocation' } as never
    const envelope = { invocationId: 'invocation', requestId: 'request', turnId: 'turn', toolCallId: 'call', toolName: 'write_file',
      canonicalArgs: { path: 'doc.md' }, executionContext: { channel: 'feishu', sessionId: 'session', ownerId: 'owner',
        identityKey: 'chat', authorizationEpoch: 9, invocationId: 'invocation', toolName: 'write_file', toolInput: { path: 'doc.md' },
        requestId: 'request', turnId: 'turn', toolCallId: 'call', providerRouteId: 'route' } } as never
    await expect(ports.dispatch({} as never, todo, envelope)).resolves.toEqual({ dispatched: true })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it.each([
    ['owner', (context: Record<string, unknown>) => ({ ...context, ownerId: 'different-owner' })],
    ['identity', (context: Record<string, unknown>) => ({ ...context, identityKey: 'different-chat' })],
    ['channel', (context: Record<string, unknown>) => ({ ...context, channel: 'wechat' })],
    ['authorization epoch', (context: Record<string, unknown>) => ({ ...context, authorizationEpoch: 8 })],
    ['canonical arguments', (context: Record<string, unknown>) => ({ ...context, toolInput: { path: '/etc/hosts' } })]
  ])('does not dispatch when the persisted envelope drifts in %s', async (_label, changeContext) => {
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const ports = createDeferredImDispatchPorts({ channel: 'feishu', getAuthorizationEpoch: () => 9, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch })
    const todo = { channel: 'feishu', originSessionId: 'session', ownerId: 'owner', identityKey: 'chat',
      authorizationEpoch: 9, invocationId: 'invocation' } as never
    const context = { channel: 'feishu', sessionId: 'session', ownerId: 'owner', identityKey: 'chat', authorizationEpoch: 9,
      invocationId: 'invocation', toolName: 'write_file', toolInput: { path: 'doc.md' }, requestId: 'request', turnId: 'turn',
      toolCallId: 'call', providerRouteId: 'route' }
    const envelope = { invocationId: 'invocation', requestId: 'request', turnId: 'turn', toolCallId: 'call', toolName: 'write_file',
      canonicalArgs: { path: 'doc.md' }, executionContext: changeContext(context) } as never

    await expect(ports.dispatch({} as never, todo, envelope)).resolves.toEqual({ dispatched: false })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('requires the envelope to preserve the todo decision facts and policy version binding', async () => {
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const ports = createDeferredImDispatchPorts({ channel: 'feishu', getAuthorizationEpoch: () => 9, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch })
    const todo = { channel: 'feishu', originSessionId: 'session', ownerId: 'owner', identityKey: 'chat', authorizationEpoch: 9,
      invocationId: 'invocation', policyBehaviorVersion: 'im-standard-v2', policyRevision: 3, policyEpoch: 4,
      rule: { ruleId: 'write-file', factsHash: 'a'.repeat(64) } } as never
    const envelope = { invocationId: 'invocation', requestId: 'request', turnId: 'turn', toolCallId: 'call', toolName: 'write_file',
      canonicalArgs: { path: 'doc.md' }, contentVersions: {}, executionContext: { channel: 'feishu', sessionId: 'session', ownerId: 'owner',
        identityKey: 'chat', authorizationEpoch: 9, invocationId: 'invocation', toolName: 'write_file', toolInput: { path: 'doc.md' },
        requestId: 'request', turnId: 'turn', toolCallId: 'call', providerRouteId: 'route', policyBehaviorVersion: 'im-v1.6',
        policyRevision: 3, policyEpoch: 4, ruleId: 'write-file', factsHash: 'a'.repeat(64) } } as never

    await expect(ports.recheck({} as never, todo, envelope)).resolves.toEqual({ allowed: false })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps a Feishu todo bound to Feishu when a WeChat dispatcher receives the wake', async () => {
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const ports = createDeferredImDispatchPorts({ channel: 'wechat', getAuthorizationEpoch: () => 9, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch })
    const todo = { channel: 'feishu', originSessionId: 'session', ownerId: 'owner', identityKey: 'feishu-chat', authorizationEpoch: 9,
      invocationId: 'invocation', rule: { ruleId: 'write', factsHash: 'b'.repeat(64) } } as never
    const envelope = { invocationId: 'invocation', requestId: 'request', turnId: 'turn', toolCallId: 'call', toolName: 'write_file',
      canonicalArgs: {}, contentVersions: {}, executionContext: { channel: 'feishu', sessionId: 'session', ownerId: 'owner',
        identityKey: 'feishu-chat', authorizationEpoch: 9, invocationId: 'invocation', toolName: 'write_file', toolInput: {},
        requestId: 'request', turnId: 'turn', toolCallId: 'call', providerRouteId: 'route' } } as never

    await expect(ports.recheck({} as never, todo, envelope)).resolves.toEqual({ allowed: false })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects a deferred approval bound to an older IM policy revision even when channel epoch is unchanged', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'dispatch-policy-v1' })
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const todo = { channel: 'feishu', originSessionId: 'session', ownerId: 'owner', identityKey: 'chat', authorizationEpoch: 9,
      invocationId: 'invocation', policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1,
      rule: { ruleId: 'write', factsHash: 'a'.repeat(64) } } as never
    const envelope = { invocationId: 'invocation', requestId: 'request', turnId: 'turn', toolCallId: 'call', toolName: 'write_file',
      canonicalArgs: { path: 'doc.md' }, contentVersions: {}, executionContext: { channel: 'feishu', sessionId: 'session', ownerId: 'owner',
        identityKey: 'chat', authorizationEpoch: 9, invocationId: 'invocation', toolName: 'write_file', toolInput: { path: 'doc.md' },
        requestId: 'request', turnId: 'turn', toolCallId: 'call', providerRouteId: 'route' } } as never
    commitImPolicySnapshot(conn, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'strict' }, updatedAt: 2, eventId: 'dispatch-policy-v2' })
    const ports = createDeferredImDispatchPorts({ db, channel: 'feishu', getAuthorizationEpoch: () => 9, isEnabled: () => true,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch })

    await expect(ports.dispatch({} as never, todo, envelope)).resolves.toEqual({ dispatched: false })
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })
})
