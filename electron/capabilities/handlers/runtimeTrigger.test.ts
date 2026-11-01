import { describe, expect, it, vi } from 'vitest'
import { callCapability } from '../callCapability'
import { CapabilityRegistry } from '../registry'
import { matchCapabilities } from '../match'
import type { CapabilityContext } from '../types'
import { createRuntimeTriggerCapabilities } from './runtimeTrigger'

const context = (runtimeTriggers: Record<string, unknown>): CapabilityContext => ({
  workDir: '/work', userDataDir: '/user', sessionId: 'owner-session', requestId: 'invocation', signal: new AbortController().signal,
  runtimeTriggers: runtimeTriggers as never
})

describe('runtime trigger capabilities', () => {
  it('registers five scoped actions with host injected owner and revision guarded cancellation', async () => {
    const service = {
      targets: vi.fn(() => ({ items: [] })),
      register: vi.fn(() => ({ trigger: { triggerId: 'trigger-1' } })),
      get: vi.fn(() => ({ trigger: { triggerId: 'trigger-1', revision: 2 } })),
      list: vi.fn(() => ({ items: [] })),
      cancel: vi.fn(() => ({ trigger: { triggerId: 'trigger-1', state: 'cancelled' } }))
    }
    const registry = new CapabilityRegistry()
    for (const capability of createRuntimeTriggerCapabilities()) registry.register(capability)
    expect(registry.list().map(({ id }) => id)).toEqual([
      'action.runtime_trigger.targets', 'action.runtime_trigger.register', 'action.runtime_trigger.get',
      'action.runtime_trigger.list', 'action.runtime_trigger.cancel'
    ])
    for (const query of ['等另一个会话完成', '监督本会话步骤', '受管进程退出', '飞书消息触发', '定时唤醒']) {
      expect(matchCapabilities(registry.list(), query, 'action').matches.map(({ id }) => id)).toContain('action.runtime_trigger.register')
    }
    const registered = await callCapability(registry, 'action.runtime_trigger.register', {
      clientKey: 'once', receiverSessionId: 'receiver', expiresAt: Date.now() + 60_000,
      condition: { type: 'time', at: new Date(Date.now() + 30_000).toISOString(), taskPrompt: 'wake' }
    }, context(service), { allowed: true })
    expect(registered.ok).toBe(true)
    expect(service.register).toHaveBeenCalledWith(expect.objectContaining({ ownerSessionId: 'owner-session' }))
    const cancelled = await callCapability(registry, 'action.runtime_trigger.cancel', { triggerId: 'trigger-1', expectedRevision: 2 }, context(service), { allowed: true })
    expect(cancelled.ok).toBe(true)
    expect(service.cancel).toHaveBeenCalledWith({ ownerSessionId: 'owner-session', params: { triggerId: 'trigger-1', expectedRevision: 2 } })
    expect(registry.get('action.runtime_trigger.targets')?.risk).toBe('read')
    expect(registry.get('action.runtime_trigger.register')?.risk).toBe('act')
    expect(registry.get('action.runtime_trigger.cancel')?.risk).toBe('act')
    expect(registry.get('action.runtime_trigger.register')?.notes).toContain('命中后系统会唤醒接收会话；来源正文不会写入队列标记')
  })

  it('rejects malformed conditions and never accepts an owner from model params', async () => {
    const service = { register: vi.fn() }
    const registry = new CapabilityRegistry()
    for (const capability of createRuntimeTriggerCapabilities()) registry.register(capability)
    const invalid = await callCapability(registry, 'action.runtime_trigger.register', {
      ownerSessionId: 'attacker', clientKey: 'x', receiverSessionId: 'receiver', expiresAt: Date.now() + 60_000,
      condition: { type: 'time', at: new Date(Date.now() + 30_000).toISOString(), taskPrompt: 'wake' }
    }, context(service), { allowed: true })
    expect(invalid.ok).toBe(false)
    expect(service.register).not.toHaveBeenCalled()
  })
})
