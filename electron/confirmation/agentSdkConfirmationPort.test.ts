import { describe, expect, it, vi } from 'vitest'
import type { ConfirmationChannel } from '../../src/shared/confirmation/types'
import { createAgentSdkConfirmationPort } from './agentSdkConfirmationPort'
import { DesktopChannel } from './channels'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { isPendingConfirm } from '../toolConfirmRegistry'

const facts = { toolName: 'read_file', actionClass: 'read', baseRiskLevel: 'medium', signals: [], summary: { text: 'Read a file' } }
const context = {
  facts,
  decision: { riskLevel: 'high', memoryTiers: [{ key: { kind: 'path', path: '/workspace/a.txt' }, label: 'file' }], timeoutMs: 1200 },
  readPathFact: { normalizedPath: '/workspace/a.txt' }
}

describe('createAgentSdkConfirmationPort', () => {
  it('从 policy context 还原 ConfirmRequest，并在发布卡片前登记 channel waiter', async () => {
    const order: string[] = []
    const channel: ConfirmationChannel = {
      request: vi.fn(async (request) => { order.push('waiter'); expect(request).toEqual({ facts, riskLevel: 'high', memoryTiers: context.decision.memoryTiers, timeoutMs: 1200 }); return { kind: 'approved', answererKind: 'user', cause: 'user-approved' } }),
      cancel: vi.fn()
    }
    const port = createAgentSdkConfirmationPort({
      createChannel: () => channel,
      publish: async (_call, _request, _confirmationId, publishedContext) => { order.push('publish'); expect(publishedContext).toEqual(context) },
      cancel: () => { order.push('cancel') },
      onApproved: () => { order.push('approved') }
    })

    const result = await port({
      call: { invocationId: 'inv', toolCallId: 'tool-1', toolName: 'read_file', input: { path: 'a.txt' } },
      confirmationId: 'tool-1', answerer: 'agent', reasonCode: 'human', context
    })

    expect(order).toEqual(['waiter', 'publish', 'approved'])
    expect(result.kind).toBe('approved')
    if (result.kind === 'approved') {
      expect(result.receipt).toMatch(/^confirmation:[0-9a-f-]{36}$/)
      expect(result).toMatchObject({ answerer: 'user', cause: 'user-approved' })
    }
  })

  it.each([
    ['rejected', 'denied'], ['timeout', 'timeout'], ['unavailable', 'unavailable'], ['cancelled', 'cancelled']
  ] as const)('将 channel %s 映射为 SDK %s', async (channelKind, expected) => {
    const channel: ConfirmationChannel = { request: async () => ({ kind: channelKind, cause: channelKind === 'rejected' ? 'user-denied' : channelKind }), cancel: vi.fn() } as never
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: async () => undefined, cancel: vi.fn() })
    await expect(port({ call: { invocationId: 'inv', toolCallId: 'tool-1', toolName: 'read_file', input: {} }, confirmationId: 'tool-1', answerer: 'user', reasonCode: 'human', context })).resolves.toMatchObject({ kind: expected })
  })

  it.each(['continue', 'back-to-desktop', 'stop'] as const)(
    '将 approved-with-action/%s 保持为 denied，不能当作工具批准', async (action) => {
      const channel: ConfirmationChannel = {
        request: async () => ({ kind: 'approved-with-action', action, cause: 'user-approved' }),
        cancel: vi.fn()
      }
      const onApproved = vi.fn()
      const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: async () => undefined, cancel: vi.fn(), onApproved })

      await expect(port({ call: { invocationId: 'inv', toolCallId: 'tool-1', toolName: 'read_file', input: {} }, confirmationId: 'tool-1', answerer: 'user', reasonCode: 'human', context }))
        .resolves.toMatchObject({ kind: 'denied', answerer: 'user', cause: 'user-approved' })
      expect(onApproved).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['user-approved', 'approved'], ['user-denied', 'denied']
  ] as const)('agent policy fallback outcome %s is attributed to the user', async (cause, expectedKind) => {
    const channel: ConfirmationChannel = { request: async () => ({ kind: expectedKind === 'approved' ? 'approved' : 'rejected', cause }), cancel: vi.fn() } as never
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: async () => undefined, cancel: vi.fn() })
    await expect(port({ call: { invocationId: 'inv', toolCallId: 'tool-fallback', toolName: 'write_file', input: {} }, confirmationId: 'tool-fallback', answerer: 'agent', reasonCode: 'agent-approval', context }))
      .resolves.toMatchObject({ answerer: 'user', cause, kind: expectedKind })
  })

  it.each(['unavailable', 'timeout'] as const)('allows the host to resolve an agent %s result through a user fallback and confirms only the final approval', async (cause) => {
    const order: string[] = []
    const onApproved = vi.fn(() => { order.push('approved') })
    const port = createAgentSdkConfirmationPort({
      createChannel: () => ({ request: async () => cause === 'timeout'
        ? ({ kind: 'timeout', cause, answererKind: 'agent' })
        : ({ kind: 'rejected', cause, answererKind: 'agent' }), cancel: vi.fn() }),
      publish: async () => undefined,
      cancel: vi.fn(),
      onApproved,
      fallback: async (_call, _confirmation, _context, primary) => {
        order.push(`fallback:${primary.kind}:${primary.cause}`)
        return { kind: 'approved', receipt: 'fallback-receipt', answerer: 'user', cause: 'user-approved' }
      }
    })

    const result = await port({
      call: { invocationId: 'inv', toolCallId: 'tool-fallback-port', toolName: 'write_file', input: {} },
      confirmationId: 'tool-fallback-port', answerer: 'agent', reasonCode: 'agent-approval', context
    })

    expect(result).toMatchObject({ kind: 'approved', answerer: 'user', cause: 'user-approved' })
    expect(order).toEqual([`fallback:${cause === 'timeout' ? 'timeout' : 'rejected'}:${cause}`, 'approved'])
    expect(onApproved).toHaveBeenCalledOnce()
  })

  it('publish 失败时取消已登记 waiter，并以 unavailable fail closed', async () => {
    const cancel = vi.fn()
    const channel: ConfirmationChannel = { request: vi.fn(async () => new Promise(() => undefined)), cancel: vi.fn() }
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: async () => { throw new Error('window unavailable') }, cancel })
    await expect(port({ call: { invocationId: 'inv', toolCallId: 'tool-1', toolName: 'read_file', input: {} }, confirmationId: 'tool-1', answerer: 'user', reasonCode: 'human', context })).resolves.toEqual({ kind: 'unavailable', cause: 'unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('signal abort 时立即取消 waiter 并结束 SDK confirmation', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const channel: ConfirmationChannel = { request: vi.fn(async () => new Promise(() => undefined)), cancel: vi.fn() }
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: async () => undefined, cancel })
    const pending = port({ call: { invocationId: 'inv', toolCallId: 'tool-1', toolName: 'read_file', input: {} }, confirmationId: 'tool-1', answerer: 'user', reasonCode: 'human', context, signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toEqual({ kind: 'cancelled', cause: 'cancelled' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(channel.cancel).toHaveBeenCalledWith('tool-1', 'cancelled')
  })

  it('Desktop request cancellation resolves the real confirmation waiter and SDK port', async () => {
    const requestId = 'desktop-confirm-cancel-request'
    const toolCallId = 'desktop-confirm-cancel-tool'
    const chatCancels = new ChatCancelRegistry()
    const signal = chatCancels.register(requestId)
    const channel = new DesktopChannel({ requestId, toolUseId: toolCallId, sessionId: 'session-1', toolName: 'write_file', lane: 'desktop' })
    const port = createAgentSdkConfirmationPort({
      createChannel: () => channel,
      publish: async () => undefined,
      cancel: () => undefined
    })

    try {
      const pending = port({
        call: { invocationId: requestId, toolCallId, toolName: 'write_file', input: { path: 'note.txt', content: 'change' } },
        confirmationId: toolCallId,
        answerer: 'user',
        reasonCode: 'human-approval',
        context: { ...context, facts: { ...facts, toolName: 'write_file', actionClass: 'write' } },
        signal
      })
      await vi.waitFor(() => expect(isPendingConfirm(requestId, toolCallId)).toBe(true))

      chatCancels.signalChatCancel(requestId)

      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', cause: 'cancelled' })
      expect(isPendingConfirm(requestId, toolCallId)).toBe(false)
    } finally {
      chatCancels.clear(requestId)
    }
  })
})
