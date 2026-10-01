import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { createWeChatOutboundRegisteredTools } from './wechatOutboundRegisteredTools'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { createRegisteredAgentTurnTools } from './registeredAgentTurnTools'
import { TypedToolRegistry } from './plannedToolRegistry'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { executeWeChatSend, WeChatOutboundExecutionUncertainError } from './weChatToolExecutor'

function makeRuntime() {
  return {
    workDir: '/work/approved',
    sessionId: 'session-approved',
    lane: 'wechat',
    wechatConfig: { ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true },
    remoteContext: {
      source: 'wechat' as const,
      messageId: 'message-approved',
      userId: 'wechat-user-approved',
      authOwner: 'wechat-owner',
      authorizationGeneration: 7,
      originSessionId: 'session-approved'
    }
  }
}

describe('WeChat outbound prepared registrations', () => {
  it.each(['wechat_send', 'wechat_reply'] as const)(
    '真实 %s adapter 在 claim barrier 中授权版本变化时不触发出站执行器',
    async (toolName) => {
      const runtime = makeRuntime()
      const requestId = `request-${toolName}-version`
      const toolUseId = `call-${toolName}-version`
      const input = toolName === 'wechat_send' ? { userId: 'target-user', text: 'must not send' } : { text: 'must not reply' }
      const executor = vi.fn(async () => ({ success: true }))
      const adapters = createWeChatOutboundRegisteredTools({
        send: { name: 'wechat_send', execute: toolName === 'wechat_send' ? executor : vi.fn() } as never,
        reply: { name: 'wechat_reply', execute: toolName === 'wechat_reply' ? executor : vi.fn() } as never
      })
      const registered = adapters.find((tool) => tool.name === toolName)!
      const revocations = new ToolRevocationRegistry()
      revocations.registerToolRevocationRequest(requestId, 'wechat', `turn-${toolName}-version`)
      const ledger = new InMemoryExecutionAdmissionCoordinator()
      let reachedClaim!: () => void
      let releaseClaim!: () => void
      const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
      const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
      const admission = {
        markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
        beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
          reachedClaim()
          await barrier
          return ledger.beginDispatch(...args)
        },
        invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
        settle: (permitId: string) => ledger.settle(permitId)
      }
      let authorizationVersion = 'wechat-policy-v1'
      const dispatch = createPermitBoundCoordinatorDispatch({
        requestId, turnId: `turn-${toolName}-version`, canonicalInput: input,
        authorizationVersion, currentAuthorizationVersion: () => authorizationVersion,
        targetVersion: 'wechat-target-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
        isAllowed: () => !revocations.isToolRevoked(requestId, toolName),
        recheck: async () => ({ allowed: true, authorizationVersion: 'wechat-policy-v1', targetVersion: 'wechat-target-v1', factsHash: 'facts-v1' }),
        safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'wechat-policy-v1' }) },
        toolRevocations: revocations, admission
      })
      const signal = new AbortController().signal
      const result = executeRegisteredTool(registered, input, {
        requestId, toolUseId, signal, executionContext: runtime as never
      }, { confirm: async () => true, dispatch })

      await atClaim
      expect(executor).not.toHaveBeenCalled()
      authorizationVersion = 'wechat-policy-v2'
      releaseClaim()
      await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
      expect(executor).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount(requestId)).toBe(0)
    }
  )

  it('确认后入站 messageId 被替换时在 dispatch 前拒绝 reply', async () => {
    const runtime = makeRuntime()
    const reply = vi.fn(async () => ({ success: true }))
    const [send, replyTool] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: reply } as never
    })
    let dispatched = false

    await expect(executeRegisteredTool(replyTool!, { text: 'hello' }, {
      requestId: 'request-approved', toolUseId: 'reply-1', signal: new AbortController().signal,
      executionContext: runtime as never
    }, {
      confirm: async () => {
        runtime.remoteContext.messageId = 'message-replaced'
        return true
      },
      dispatch: async (_handle, _context, execute) => {
        dispatched = true
        return execute(new AbortController().signal)
      }
    })).rejects.toThrow('WECHAT_OUTBOUND_PREPARED_BINDING_CHANGED')

    expect(dispatched).toBe(false)
    expect(reply).not.toHaveBeenCalled()
    expect(send).toBeDefined()
  })

  it('Hosted wechat_reply 在用户确认期间入站 messageId 改变时不派发且不重试回复', async () => {
    const runtime = makeRuntime()
    const reply = vi.fn(async () => ({ success: true }))
    const [, replyTool] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: reply } as never
    })
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(replyTool!)
    const invocationId = 'inv-wechat-reply-confirm-message-drift'
    const requestId = 'request-wechat-reply-confirm-message-drift'
    const turnId = 'turn-wechat-reply-confirm-message-drift'
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry: toolRegistry, permits, admission,
      createExecutionContext: () => runtime,
      resolveAuthorizationVersion: () => 'wechat-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['wechat_reply'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => binding.phase === 'initial-compat'
        ? { kind: 'ask' as const, confirmationId: 'reply-confirm-1', answerer: 'user' as const, reasonCode: 'remote-reply-confirmation' }
        : { kind: 'allow' as const, authorizationVersion: 'wechat-policy-v1' }
    } })
    const route = { routeId: 'wechat-reply-confirm-message-drift', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const providers = new ModelProviderRegistry()
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [
      chunks({ type: 'tool-call', toolCallId: 'reply-confirm-call', toolName: 'wechat_reply', input: { text: 'reply to approved message' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      chunks({ type: 'text-delta', text: '入站消息已变化，未发送回复。' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'wechat-reply-confirm-message-drift-test', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()

    const result = await runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'reply to the current message' }], maxTokens: 80, tools: [{ name: 'wechat_reply', description: 'reply', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history, returnDeniedToolsToModel: true,
      confirmation: async () => {
        runtime.remoteContext.messageId = 'message-replaced-during-confirmation'
        return { kind: 'approved' as const, receipt: 'user-confirmation-receipt', answerer: 'user' as const, cause: 'user-approved' }
      }
    })

    expect(result.text).toBe('入站消息已变化，未发送回复。')
    expect(providerCalls).toBe(2)
    expect(reply).not.toHaveBeenCalled()
    const events = (await history.read(invocationId)).events
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'reply-confirm-call' })
    }))
    expect(events.some(({ kind }) => kind === 'tool-call-started' || kind === 'tool-call-finished')).toBe(false)
    expect(events.at(-1)?.kind).toBe('invocation-completed')
    expect(admission.activeLeaseCount(requestId)).toBe(0)
  })

  it('执行时仍以准备记录里的工作目录和远程消息身份构造 reply 上下文', async () => {
    const runtime = makeRuntime()
    const reply = vi.fn(async (_input: unknown, _context: unknown) => ({ success: true }))
    const [, replyTool] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: reply } as never
    })

    await expect(executeRegisteredTool(replyTool!, { text: 'hello' }, {
      requestId: 'request-approved', toolUseId: 'reply-2', signal: new AbortController().signal,
      executionContext: runtime as never
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, execute) => execute(new AbortController().signal)
    })).resolves.toMatchObject({ success: true })

    expect(reply).toHaveBeenCalledWith({ text: 'hello' }, expect.objectContaining({
      workDir: '/work/approved',
      sessionId: 'session-approved',
      remoteContext: expect.objectContaining({ messageId: 'message-approved', userId: 'wechat-user-approved' })
    }))
  })

  it('Hosted WeChat reply claim 后撤权且 acknowledgement 晚到时不重放结果', async () => {
    const runtime = makeRuntime()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('request-reply-revoke', 'wechat', 'turn-reply-revoke')
    let observedSignal: AbortSignal | undefined
    let enteredReply!: () => void
    const atReply = new Promise<void>((resolve) => { enteredReply = resolve })
    const reply = vi.fn(async (_input: unknown, context: { signal: AbortSignal; runtimeContext: { remoteContext: { messageId: string; userId: string } } }) => {
      observedSignal = context.signal
      enteredReply()
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'cancelled after dispatch claim', userMessage: '回复已取消。' }
    })
    const [send, replyTool] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: vi.fn() } as never,
      reply: { name: 'wechat_reply', execute: reply } as never
    })
    const registry = new TypedToolRegistry()
    registry.register(replyTool!)
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'request-reply-revoke', turnId: 'turn-reply-revoke', registry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: () => ({ runtimeContext: runtime }),
      resolveAuthorizationVersion: () => 'wechat-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-wechat-reply-revoke', ['wechat_reply'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'wechat-policy-v1' })
    } })
    const route = { routeId: 'wechat-reply-revoke', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const providers = new ModelProviderRegistry()
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [
      chunks({ type: 'tool-call', toolCallId: 'reply-revoke-call', toolName: 'wechat_reply', input: { text: 'hello' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      chunks({ type: 'text-delta', text: '回复已取消。' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'wechat-reply-revoke-test', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId: 'inv-wechat-reply-revoke', turnId: 'turn-reply-revoke',
      request: { messages: [{ role: 'user', content: 'reply to this WeChat message' }], maxTokens: 80, tools: [{ name: 'wechat_reply', description: 'reply', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await atReply
    expect(observedSignal?.aborted).toBe(false)
    expect(reply).toHaveBeenCalledWith({ text: 'hello' }, expect.objectContaining({
      signal: observedSignal,
      runtimeContext: expect.objectContaining({ remoteContext: expect.objectContaining({ messageId: 'message-approved', userId: 'wechat-user-approved' }) })
    }))
    expect(revocations.revokeToolForLane('wechat', 'wechat_reply')).toBe(1)
    expect(observedSignal?.aborted).toBe(true)
    await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    const events = (await history.read('inv-wechat-reply-revoke')).events
    expect(events.map(({ kind }) => kind)).toContain('tool-call-started')
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    expect(events.some(({ kind }) => kind === 'tool-call-not-dispatched')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount('request-reply-revoke')).toBe(0)
    expect(send).toBeDefined()
  })

  it('Hosted WeChat send claim 后撤权且 acknowledgement 晚到时不重放结果', async () => {
    const runtime = makeRuntime()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('request-send-revoke', 'wechat', 'turn-send-revoke')
    let observedSignal: AbortSignal | undefined
    let enteredSend!: () => void
    const atSend = new Promise<void>((resolve) => { enteredSend = resolve })
    const sendExecutor = vi.fn(async (_input: unknown, context: { signal: AbortSignal; runtimeContext: { remoteContext: { userId: string } } }) => {
      observedSignal = context.signal
      enteredSend()
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'cancelled after dispatch claim', userMessage: '消息发送已取消。' }
    })
    const [sendTool] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: sendExecutor } as never,
      reply: { name: 'wechat_reply', execute: vi.fn() } as never
    })
    const registry = new TypedToolRegistry()
    registry.register(sendTool!)
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'request-send-revoke', turnId: 'turn-send-revoke', registry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: () => ({ runtimeContext: runtime }),
      resolveAuthorizationVersion: () => 'wechat-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-wechat-send-revoke', ['wechat_send'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'wechat-policy-v1' })
    } })
    const route = { routeId: 'wechat-send-revoke', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const providers = new ModelProviderRegistry()
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [
      chunks({ type: 'tool-call', toolCallId: 'send-revoke-call', toolName: 'wechat_send', input: { userId: 'target-user', text: 'hello' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      chunks({ type: 'text-delta', text: '消息发送已取消。' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'wechat-send-revoke-test', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId: 'inv-wechat-send-revoke', turnId: 'turn-send-revoke',
      request: { messages: [{ role: 'user', content: 'send this WeChat message' }], maxTokens: 80, tools: [{ name: 'wechat_send', description: 'send', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await atSend
    expect(observedSignal?.aborted).toBe(false)
    expect(sendExecutor).toHaveBeenCalledWith({ userId: 'target-user', text: 'hello' }, expect.objectContaining({
      signal: observedSignal,
      runtimeContext: expect.objectContaining({ remoteContext: expect.objectContaining({ userId: 'wechat-user-approved' }) })
    }))
    expect(revocations.revokeToolForLane('wechat', 'wechat_send')).toBe(1)
    expect(observedSignal?.aborted).toBe(true)
    await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    const events = (await history.read('inv-wechat-send-revoke')).events
    expect(events.map(({ kind }) => kind)).toContain('tool-call-started')
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    expect(events.some(({ kind }) => kind === 'tool-call-not-dispatched')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount('request-send-revoke')).toBe(0)
  })

  it.each(['wechat_send', 'wechat_reply'] as const)(
    'Hosted WeChat %s 在出站请求发出后撤权时以 unknown-after-dispatch 收尾', async (toolName) => {
      const runtime = makeRuntime()
      const requestId = `request-${toolName}-unknown`
      const invocationId = `inv-${toolName}-unknown`
      const turnId = `turn-${toolName}-unknown`
      const revocations = new ToolRevocationRegistry()
      revocations.registerToolRevocationRequest(requestId, 'wechat', turnId)
      let executionSignal!: AbortSignal
      let enteredOutbound!: () => void
      const atOutbound = new Promise<void>((resolve) => { enteredOutbound = resolve })
      const operation = toolName === 'wechat_send' ? 'send' as const : 'reply' as const
      const outbound = vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
        executionSignal = context.signal
        enteredOutbound()
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener(
          'abort', () => reject(new WeChatOutboundExecutionUncertainError(operation)), { once: true }
        ))
      })
      const adapters = createWeChatOutboundRegisteredTools({
        send: { name: 'wechat_send', execute: toolName === 'wechat_send' ? outbound : vi.fn() } as never,
        reply: { name: 'wechat_reply', execute: toolName === 'wechat_reply' ? outbound : vi.fn() } as never
      })
      const tool = adapters.find((adapter) => adapter.name === toolName)!
      const registry = new TypedToolRegistry()
      registry.register(tool)
      const permits = new InMemorySafetyPermitStore()
      const admission = new InMemoryExecutionAdmissionCoordinator()
      const tools = createRegisteredAgentTurnTools({
        requestId, turnId, registry, permits, admission,
        toolRevocations: revocations,
        createExecutionContext: () => ({ runtimeContext: runtime }),
        resolveAuthorizationVersion: () => 'wechat-policy-v1'
      })
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, [toolName])
      const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
        evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'wechat-policy-v1' })
      } })
      const route = { routeId: `wechat-${toolName}-unknown`, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
      const providers = new ModelProviderRegistry()
      async function* chunks(...values: StreamChunk[]) { yield* values }
      let providerCalls = 0
      const input = toolName === 'wechat_send' ? { userId: 'target-user', text: 'hello' } : { text: 'hello' }
      providers.register(route, { providerId: `wechat-${toolName}-unknown-test`, stream: () => {
        providerCalls += 1
        return chunks({ type: 'tool-call', toolCallId: `${toolName}-unknown-call`, toolName, input }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
      } })
      const history = new MemoryHistory()
      const turn = runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: `perform ${toolName}` }], maxTokens: 80, tools: [{ name: toolName, description: toolName, inputSchema: { type: 'object' } }] },
        safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
        toolExecution: tools.toolExecution, maxModelTurns: 2, history
      })

      await atOutbound
      expect(outbound).toHaveBeenCalledOnce()
      expect(executionSignal.aborted).toBe(false)
      expect(revocations.revokeToolForLane('wechat', toolName)).toBe(1)
      await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      expect(executionSignal.aborted).toBe(true)
      const events = (await history.read(invocationId)).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(admission.activeLeaseCount(requestId)).toBe(0)
    }
  )
})
