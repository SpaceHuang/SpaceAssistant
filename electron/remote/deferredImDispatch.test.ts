import { describe, expect, it, vi } from 'vitest'
import { createDeferredImDispatchPorts } from './deferredImDispatch'

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
})
