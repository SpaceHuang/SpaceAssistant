import { describe, expect, it, vi } from 'vitest'
import type { ConfirmationChannel } from '../../src/shared/confirmation/types'
import { createAgentSdkConfirmationPort, mapAgentSdkConfirmationOutcome } from './agentSdkConfirmationPort'
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
  it('returns a durable deferred confirmation from the explicit IM deferral callback', async () => {
    const channel = { request: vi.fn(async () => ({ kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' })), cancel: vi.fn() }
    const defer = vi.fn(async () => ({ kind: 'deferred' as const, todoId: 'todo-1', invocationId: 'inv-1',
      checkpointRef: { checkpointId: 'checkpoint-1', workflowRevision: 2 } }))
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: vi.fn(), cancel: vi.fn(), defer })
    const result = await port({ call: { invocationId: 'inv-1', toolCallId: 'call-1', toolName: 'write_file', input: {} },
      modelTurn: 1, confirmationId: 'confirm-1', answerer: 'agent', reasonCode: 'policy',
      context: { facts: { actionClass: 'write' }, decision: { riskLevel: 'high', memoryTiers: [], timeoutMs: null } } })
    expect(result).toMatchObject({ kind: 'deferred', todoId: 'todo-1', invocationId: 'inv-1' })
    expect(defer).toHaveBeenCalledOnce()
  })

  it('offers agent-approved outcomes to policy so insufficient direct delegation can still defer', async () => {
    const channel = { request: vi.fn(async () => ({ kind: 'approved', cause: 'agent-approved', answererKind: 'agent' })), cancel: vi.fn() }
    const defer = vi.fn(async () => ({ kind: 'deferred' as const, todoId: 'todo-low-evidence', invocationId: 'inv-2',
      checkpointRef: { checkpointId: 'checkpoint-2', workflowRevision: 3 } }))
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: vi.fn(), cancel: vi.fn(), defer })
    const result = await port({ call: { invocationId: 'inv-2', toolCallId: 'call-2', toolName: 'write_file', input: {} },
      modelTurn: 1, confirmationId: 'confirm-2', answerer: 'agent', reasonCode: 'policy',
      context: { facts: { actionClass: 'write' }, decision: { riskLevel: 'high', memoryTiers: [], timeoutMs: null } } })
    expect(result).toMatchObject({ kind: 'deferred', todoId: 'todo-low-evidence' })
    expect(defer).toHaveBeenCalledOnce()
  })

  it('将人工选择的记忆键交给宿主确认提交回调', async () => {
    const memory = { kind: 'script-content' as const, digest: 'a'.repeat(64), sessionId: 'session-1' }
    const onApproved = vi.fn()
    const port = createAgentSdkConfirmationPort({
      createChannel: () => ({ request: async () => ({ kind: 'approved', answererKind: 'user', cause: 'user-approved', memory }), cancel: vi.fn() }),
      publish: async () => undefined, cancel: vi.fn(), onApproved
    })
    await port({ call: { invocationId: 'inv', toolCallId: 'tool-memory', toolName: 'run_script', input: { code: 'custom_api()' } }, confirmationId: 'tool-memory', answerer: 'user', reasonCode: 'script-unmodeled-path-ask', context })
    expect(onApproved).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'approved' }), expect.anything(), context, memory)
  })

  it('通过真实 channel 与 SDK port 保留 Agent 裁决和 fail-closed fallback 语义', async () => {
    const { AgentChannel } = await import('./agentChannel')
    const { resolveConfirmChannel } = await import('./channels')
    const invokeApproval = vi.fn(async () => ({ ok: true as const, verdict: { kind: 'undetermined' as const, reason: { summary: '缺少影响范围证据' } } }))
    const channel = resolveConfirmChannel({
      lane: 'wechat', requestId: 'deferred-contract-undetermined', sessionId: 'session-contract', toolName: 'write_file',
      remoteAsyncApprovalEnabled: true, answererPolicy: { kind: 'agent' },
      agentChannelFactory: (deps) => new AgentChannel({ ...deps, policy: deps.policy, invokeApproval }),
      imChannel: { send: vi.fn() } as never,
      buildImPending: () => ({}) as never
    })
    const fallback = vi.fn(async () => undefined)
    const port = createAgentSdkConfirmationPort({
      createChannel: () => channel,
      publish: async () => undefined,
      cancel: vi.fn(),
      fallback
    })
    const result = await port({ call: { invocationId: 'inv', toolCallId: 'tool-contract', toolName: 'write_file', input: {} }, confirmationId: 'tool-contract', answerer: 'agent', reasonCode: 'agent-approval', context })

    expect(invokeApproval).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ kind: 'denied', answerer: 'agent', cause: 'agent-undetermined', userMessage: '缺少影响范围证据' })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('Agent cannot turn an IM outbound action into agent-approved', async () => {
    const channel: ConfirmationChannel = { request: async () => ({ kind: 'approved', answererKind: 'agent', cause: 'agent-approved' }), cancel: vi.fn() }
    const onApproved = vi.fn()
    const port = createAgentSdkConfirmationPort({ createChannel: () => channel, publish: async () => undefined, cancel: vi.fn(), onApproved })
    await expect(port({ call: { invocationId: 'inv', toolCallId: 'outbound-agent', toolName: 'send_message', input: {} },
      confirmationId: 'outbound-agent', answerer: 'agent', reasonCode: 'agent-approval',
      context: { ...context, facts: { ...facts, toolName: 'send_message', actionClass: 'outbound' } } }))
      .resolves.toMatchObject({ kind: 'denied', answerer: 'agent', cause: 'rules-violated' })
    expect(onApproved).not.toHaveBeenCalled()
  })

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

  it('只在同一模型轮内对同工具同写目标去重，其他轮次、目标和工具仍走确认', async () => {
    const request = vi.fn(async () => ({ kind: 'rejected' as const, cause: 'user-denied', answererKind: 'user' as const }))
    const publish = vi.fn(async () => undefined)
    const port = createAgentSdkConfirmationPort({ createChannel: () => ({ request, cancel: vi.fn() }), publish, cancel: vi.fn() })
    const ask = (toolCallId: string, toolName: string, path: string, modelTurn = 1, content = 'same content') => port({
      modelTurn,
      call: { invocationId: 'inv', toolCallId, toolName, input: { path, content } }, confirmationId: toolCallId, answerer: 'user', reasonCode: 'write-confirm',
      context: { ...context, facts: { ...facts, toolName, actionClass: 'write' }, writePathFact: { normalizedPath: path } }
    })

    await expect(ask('first', 'edit_file', '/workspace/a.txt')).resolves.toMatchObject({ kind: 'denied', cause: 'user-denied' })
    await expect(ask('same', 'edit_file', '/workspace/a.txt')).resolves.toMatchObject({ kind: 'denied', cause: 'user-denied', userMessage: expect.stringContaining('同批同目标') })
    await ask('next-turn-changed-content', 'edit_file', '/workspace/a.txt', 2, 'updated content')
    await ask('other-path', 'edit_file', '/workspace/b.txt')
    await ask('other-tool', 'write_file', '/workspace/a.txt')
    expect(request).toHaveBeenCalledTimes(4)
    expect(publish).toHaveBeenCalledTimes(4)
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
    const memory = { kind: 'script-content' as const, digest: 'a'.repeat(64), sessionId: 'session-1' }
    const port = createAgentSdkConfirmationPort({
      createChannel: () => ({ request: async () => cause === 'timeout'
        ? ({ kind: 'timeout', cause, answererKind: 'agent' })
        : ({ kind: 'rejected', cause, answererKind: 'agent' }), cancel: vi.fn() }),
      publish: async () => undefined,
      cancel: vi.fn(),
      onApproved,
      fallback: async (_call, _confirmation, _context, primary) => {
        order.push(`fallback:${primary.kind}:${primary.cause}`)
        return mapAgentSdkConfirmationOutcome({ kind: 'approved', cause: 'user-approved', answererKind: 'user', memory }, 'user')
      }
    })

    const result = await port({
      call: { invocationId: 'inv', toolCallId: 'tool-fallback-port', toolName: 'write_file', input: {} },
      confirmationId: 'tool-fallback-port', answerer: 'agent', reasonCode: 'agent-approval', context
    })

    expect(result).toMatchObject({ kind: 'approved', answerer: 'user', cause: 'user-approved' })
    expect(order).toEqual([`fallback:${cause === 'timeout' ? 'timeout' : 'rejected'}:${cause}`, 'approved'])
    expect(onApproved).toHaveBeenCalledOnce()
    expect(onApproved).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ selectedMemory: memory }), expect.anything(), context, memory)
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
      await vi.waitFor(() => expect(isPendingConfirm(requestId, toolCallId, 'session-1')).toBe(true))

      chatCancels.signalChatCancel(requestId)

      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', cause: 'cancelled' })
      expect(isPendingConfirm(requestId, toolCallId, 'session-1')).toBe(false)
    } finally {
      chatCancels.clear(requestId)
    }
  })
})
