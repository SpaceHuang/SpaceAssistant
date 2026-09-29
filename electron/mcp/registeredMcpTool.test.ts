import { describe, expect, it, vi } from 'vitest'
import { createRegisteredMcpTool } from './registeredMcpTool'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { AgentTurnCancelledError, runAgentTurn, runHostedAgentTurn } from '../../packages/agent-sdk/src/turn'
import { createHostedAgentTurnHost } from '../runtime/hostedAgentTurnHost'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { createRegisteredAgentTurnTools } from '../tools/registeredAgentTurnTools'
import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import { createHostedMcpToolRegistry } from './hostedMcpRegistry'
import { McpConnectionManager } from './mcpConnectionManager'
import type { McpToolSnapshot } from './mcpToolRegistry'
import { PolicyAuthorizationChangeRegistry } from '../runtime/policyAuthorizationChangeRegistry'

describe('createRegisteredMcpTool', () => {
  it('passes the coordinator lease signal and call identity to MCP executor', async () => {
    const execute = vi.fn(async (_input: Record<string, unknown>, _context: unknown) => ({ success: true, data: 'ok' }))
    const registered = createRegisteredMcpTool({ name: 'mcp_server_tool', execute } as never)
    const handle = await registered.begin({ value: 1 }, { requestId: 'req', toolUseId: 'call' })
    handle.confirm()
    const leaseSignal = new AbortController().signal
    const runtime = { requestId: 'stale', toolUseId: 'stale', signal: new AbortController().signal } as never

    await handle.execute({
      requestId: 'req', toolUseId: 'call', signal: leaseSignal, runtimeContext: runtime
    })

    expect(execute).toHaveBeenCalledWith({ value: 1 }, expect.objectContaining({
      requestId: 'req', toolUseId: 'call', signal: leaseSignal
    }))
  })

  it('rejects non object arguments before an executor is available', async () => {
    const execute = vi.fn(async () => ({ success: true }))
    const registered = createRegisteredMcpTool({ name: 'mcp_server_tool', execute } as never)
    await expect(registered.begin('invalid', { requestId: 'req', toolUseId: 'call' })).rejects.toThrow('MCP_TOOL_INPUT_INVALID')
    expect(execute).not.toHaveBeenCalled()
  })

  it('aborts a claimed MCP execution through the SDK admission lease after revocation', async () => {
    const route = { routeId: 'mcp-hosted', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const requestId = 'mcp-request'
    const invocationId = 'mcp-invocation'
    const toolName = 'mcp_docs_search'
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop')
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      enteredExecutor()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('MCP request aborted before a response; server result unknown')), { once: true })
      })
    })
    let observedSignal: AbortSignal | undefined
    let enteredExecutor!: () => void
    const executorEntered = new Promise<void>((resolve) => { enteredExecutor = resolve })
    const manager = new McpConnectionManager()
    const snapshot: McpToolSnapshot = {
      entries: new Map([[toolName, { mappedName: toolName, serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]]),
      budgetDropped: []
    }
    const resolveExecutor = vi.fn((name: string, resolvedManager: McpConnectionManager) =>
      name === toolName && resolvedManager === manager ? { name, execute } : undefined
    )
    const registry = createHostedMcpToolRegistry({ base: new TypedToolRegistry(), snapshot, manager, resolveExecutor })
    const registered = createRegisteredAgentTurnTools({
      requestId, turnId: 'mcp-turn', registry, permits, admission, toolRevocations: revocations,
      createExecutionContext: () => ({ runtimeContext: { lane: 'desktop' } }),
      resolveAuthorizationVersion: () => 'mcp-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, [toolName])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'mcp-policy-v1' })
    } })
    const providers = new ModelProviderRegistry()
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [
      chunks({ type: 'tool-call', toolCallId: 'mcp-call-1', toolName, input: { query: 'docs' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      chunks({ type: 'text-delta', text: 'cancelled safely' },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'fake-mcp-hosted', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId: 'mcp-turn',
      request: { messages: [{ role: 'user', content: 'search docs' }], maxTokens: 50, tools: [...snapshot.entries].map(([name, entry]) => ({ name, description: entry.description, inputSchema: entry.inputSchema })) },
      safetyGate, prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, maxModelTurns: 2, history
    })

    await executorEntered
    expect(observedSignal?.aborted).toBe(false)
    expect(revocations.revokeToolForLane('desktop', toolName)).toBe(1)
    expect(observedSignal?.aborted).toBe(true)
    await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(resolveExecutor).toHaveBeenCalledExactlyOnceWith(toolName, manager)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount(requestId)).toBe(0)
    expect(admission.executorEntries).toBe(1)
    const events = (await history.read(invocationId)).events
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
  })

  it('real Hosted Host blocks MCP executor when revocation wins after permit consume but before dispatch claim', async () => {
    const route = { routeId: 'mcp-hosted-claim-barrier', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const requestId = 'mcp-hosted-claim-request'
    const toolName = 'mcp_docs_search'
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop')
    const admissionLedger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (...args: Parameters<typeof admissionLedger.markPermitConsumed>) => admissionLedger.markPermitConsumed(...args),
      beginDispatch: async (...args: Parameters<typeof admissionLedger.beginDispatch>) => {
        reachedClaim()
        await claimBarrier
        return admissionLedger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof admissionLedger.invalidate>) => admissionLedger.invalidate(...args),
      settle: (...args: Parameters<typeof admissionLedger.settle>) => admissionLedger.settle(...args)
    }
    const permits = new InMemorySafetyPermitStore()
    const manager = new McpConnectionManager()
    const execute = vi.fn(async () => ({ success: true, data: 'must not execute' }))
    const toolSnapshot: McpToolSnapshot = {
      entries: new Map([[toolName, { mappedName: toolName, serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]]),
      budgetDropped: []
    }
    const mcpRegistry = createHostedMcpToolRegistry({
      base: new TypedToolRegistry(), snapshot: toolSnapshot, manager,
      resolveExecutor: (name, resolvedManager) => name === toolName && resolvedManager === manager ? { name, execute } : undefined
    })
    const registered = createRegisteredAgentTurnTools({
      requestId, turnId: 'mcp-hosted-claim-turn', registry: mcpRegistry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: () => ({ lane: 'desktop' }),
      resolveAuthorizationVersion: () => 'mcp-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'hosted-mcp-claim-barrier', stream: async function* () {
      providerCalls += 1
      if (providerCalls === 1) {
        yield { type: 'tool-call', toolCallId: 'mcp-claim-call', toolName, input: { query: 'docs' } } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' } as const
        return
      }
      yield { type: 'text-delta', text: 'revoked before dispatch' } as const
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' } as const
    } })
    const history = new MemoryHistory()
    const host = createHostedAgentTurnHost({
      invocationId: requestId, turnId: 'mcp-hosted-claim-turn', routeId: route.routeId,
      providerRegistry: providers, toolRegistry: mcpRegistry, authorizedToolNames: new Set([toolName]),
      capabilities, permits, admission, safetyGate, history,
      prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, maxConcurrentTools: 1, maxModelTurns: 3
    })
    const turn = runHostedAgentTurn({
      host, invocationId: requestId, turnId: 'mcp-hosted-claim-turn', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'search docs' }], maxTokens: 64, tools: [...toolSnapshot.entries.values()].map((entry) => ({ name: entry.mappedName, description: entry.description, inputSchema: entry.inputSchema })) }
    })

    await atClaim
    expect(execute).not.toHaveBeenCalled()
    expect(revocations.revokeToolForLane('desktop', toolName)).toBe(1)
    releaseClaim()
    await expect(turn).resolves.toMatchObject({ text: 'revoked before dispatch' })
    expect(execute).not.toHaveBeenCalled()
    expect(providerCalls).toBe(2)
    expect(admissionLedger.activeLeaseCount(requestId)).toBe(0)
    const events = (await history.read(requestId)).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'mcp-claim-call', reason: expect.stringMatching(/REVOKED/) }) }))
    expect(events.some(({ kind }) => kind === 'tool-call-started' || kind === 'tool-call-finished')).toBe(false)
    await manager.shutdown()
  })

  it('real Hosted Host blocks MCP executor when authorization version changes before dispatch claim', async () => {
    const route = { routeId: 'mcp-hosted-version-barrier', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const requestId = 'mcp-hosted-version-request'
    const toolName = 'mcp_docs_search'
    const admissionLedger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (...args: Parameters<typeof admissionLedger.markPermitConsumed>) => admissionLedger.markPermitConsumed(...args),
      beginDispatch: async (...args: Parameters<typeof admissionLedger.beginDispatch>) => {
        reachedClaim()
        await claimBarrier
        return admissionLedger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof admissionLedger.invalidate>) => admissionLedger.invalidate(...args),
      settle: (...args: Parameters<typeof admissionLedger.settle>) => admissionLedger.settle(...args)
    }
    const permits = new InMemorySafetyPermitStore()
    const manager = new McpConnectionManager()
    const execute = vi.fn(async () => ({ success: true, data: 'must not execute' }))
    const toolSnapshot: McpToolSnapshot = {
      entries: new Map([[toolName, { mappedName: toolName, serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]]),
      budgetDropped: []
    }
    const mcpRegistry = createHostedMcpToolRegistry({
      base: new TypedToolRegistry(), snapshot: toolSnapshot, manager,
      resolveExecutor: (name, resolvedManager) => name === toolName && resolvedManager === manager ? { name, execute } : undefined
    })
    let authorizationVersion = 'mcp-policy-v1'
    const registered = createRegisteredAgentTurnTools({
      requestId, turnId: 'mcp-hosted-version-turn', registry: mcpRegistry, permits, admission,
      createExecutionContext: () => ({ lane: 'desktop' }),
      resolveAuthorizationVersion: () => authorizationVersion
    })
    const capabilities = new CapabilityRegistry()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'hosted-mcp-version-barrier', stream: async function* () {
      providerCalls += 1
      if (providerCalls === 1) {
        yield { type: 'tool-call', toolCallId: 'mcp-version-call', toolName, input: { query: 'docs' } } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' } as const
        return
      }
      yield { type: 'text-delta', text: 'authorization changed before dispatch' } as const
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' } as const
    } })
    const history = new MemoryHistory()
    const host = createHostedAgentTurnHost({
      invocationId: requestId, turnId: 'mcp-hosted-version-turn', routeId: route.routeId,
      providerRegistry: providers, toolRegistry: mcpRegistry, authorizedToolNames: new Set([toolName]),
      capabilities, permits, admission, safetyGate, history,
      prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, maxConcurrentTools: 1, maxModelTurns: 3
    })
    const turn = runHostedAgentTurn({
      host, invocationId: requestId, turnId: 'mcp-hosted-version-turn', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'search docs' }], maxTokens: 64, tools: [...toolSnapshot.entries.values()].map((entry) => ({ name: entry.mappedName, description: entry.description, inputSchema: entry.inputSchema })) }
    })

    await atClaim
    expect(execute).not.toHaveBeenCalled()
    authorizationVersion = 'mcp-policy-v2'
    releaseClaim()
    await expect(turn).resolves.toMatchObject({ text: 'authorization changed before dispatch' })
    expect(execute).not.toHaveBeenCalled()
    expect(providerCalls).toBe(2)
    expect(admissionLedger.activeLeaseCount(requestId)).toBe(0)
    const events = (await history.read(requestId)).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'mcp-version-call' }) }))
    expect(events.some(({ kind }) => kind === 'tool-call-started' || kind === 'tool-call-finished')).toBe(false)
    await manager.shutdown()
  })

  it('real Hosted Host cancels MCP dispatch after permit consume but before claim without entering executor', async () => {
    const route = { routeId: 'mcp-hosted-cancel-barrier', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const requestId = 'mcp-hosted-cancel-request'
    const toolName = 'mcp_docs_search'
    const admissionLedger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (...args: Parameters<typeof admissionLedger.markPermitConsumed>) => admissionLedger.markPermitConsumed(...args),
      beginDispatch: async (...args: Parameters<typeof admissionLedger.beginDispatch>) => {
        reachedClaim()
        await claimBarrier
        return admissionLedger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof admissionLedger.invalidate>) => admissionLedger.invalidate(...args),
      settle: (...args: Parameters<typeof admissionLedger.settle>) => admissionLedger.settle(...args)
    }
    const permits = new InMemorySafetyPermitStore()
    const manager = new McpConnectionManager()
    const execute = vi.fn(async () => ({ success: true, data: 'must not execute' }))
    const toolSnapshot: McpToolSnapshot = {
      entries: new Map([[toolName, { mappedName: toolName, serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]]),
      budgetDropped: []
    }
    const mcpRegistry = createHostedMcpToolRegistry({
      base: new TypedToolRegistry(), snapshot: toolSnapshot, manager,
      resolveExecutor: (name, resolvedManager) => name === toolName && resolvedManager === manager ? { name, execute } : undefined
    })
    const registered = createRegisteredAgentTurnTools({
      requestId, turnId: 'mcp-hosted-cancel-turn', registry: mcpRegistry, permits, admission,
      createExecutionContext: () => ({ lane: 'desktop' }),
      resolveAuthorizationVersion: () => 'mcp-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'hosted-mcp-cancel-barrier', stream: async function* () {
      providerCalls += 1
      yield { type: 'tool-call', toolCallId: 'mcp-cancel-call', toolName, input: { query: 'docs' } } as const
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'tool-calls' } as const
    } })
    const history = new MemoryHistory()
    const host = createHostedAgentTurnHost({
      invocationId: requestId, turnId: 'mcp-hosted-cancel-turn', routeId: route.routeId,
      providerRegistry: providers, toolRegistry: mcpRegistry, authorizedToolNames: new Set([toolName]),
      capabilities, permits, admission, safetyGate, history,
      prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, maxConcurrentTools: 1, maxModelTurns: 2
    })
    const controller = new AbortController()
    const turn = runHostedAgentTurn({
      host, invocationId: requestId, turnId: 'mcp-hosted-cancel-turn', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'search docs' }], maxTokens: 64, signal: controller.signal, tools: [...toolSnapshot.entries.values()].map((entry) => ({ name: entry.mappedName, description: entry.description, inputSchema: entry.inputSchema })) }
    })

    try {
      await atClaim
      expect(execute).not.toHaveBeenCalled()
      controller.abort(new Error('cancel before MCP dispatch claim'))
      releaseClaim()
      await expect(turn).rejects.toBeInstanceOf(AgentTurnCancelledError)
      expect(execute).not.toHaveBeenCalled()
      expect(providerCalls).toBe(1)
      expect(admissionLedger.activeLeaseCount(requestId)).toBe(0)
      const events = (await history.read(requestId)).events
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'mcp-cancel-call', reason: expect.stringMatching(/CANCELLED/) }) }))
      expect(events.some(({ kind }) => kind === 'tool-call-started' || kind === 'tool-call-finished')).toBe(false)
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
    } finally {
      releaseClaim()
      await manager.shutdown()
    }
  })

  it('real Hosted Host aborts a claimed MCP executor when active policy authorization changes', async () => {
    const route = { routeId: 'mcp-hosted-active-policy-change', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const requestId = 'mcp-hosted-active-policy-request'
    const toolName = 'mcp_docs_search'
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const manager = new McpConnectionManager()
    let executeSignal: AbortSignal | undefined
    let enterExecutor!: () => void
    const executorEntered = new Promise<void>((resolve) => { enterExecutor = resolve })
    const execute = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) => {
      executeSignal = context.signal
      enterExecutor()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('MCP request aborted; server result unknown')), { once: true })
      })
    })
    const toolSnapshot: McpToolSnapshot = {
      entries: new Map([[toolName, { mappedName: toolName, serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search docs', inputSchema: { type: 'object' } }]]),
      budgetDropped: []
    }
    const mcpRegistry = createHostedMcpToolRegistry({
      base: new TypedToolRegistry(), snapshot: toolSnapshot, manager,
      resolveExecutor: (name) => name === toolName ? { name, execute } : undefined
    })
    let authorizationVersion = 'mcp-policy-v1'
    const policyChanges = new PolicyAuthorizationChangeRegistry()
    const registered = createRegisteredAgentTurnTools({
      requestId, turnId: 'mcp-hosted-active-policy-turn', registry: mcpRegistry, permits, admission,
      createExecutionContext: () => ({ lane: 'desktop' }),
      resolveAuthorizationVersion: () => authorizationVersion,
      subscribeAuthorizationChanges: (call, listener) => policyChanges.subscribe(call.invocationId, 'desktop', listener),
      currentAuthorizationVersion: () => authorizationVersion
    })
    const capabilities = new CapabilityRegistry()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'hosted-mcp-active-policy-change', stream: async function* () {
      providerCalls += 1
      if (providerCalls === 1) {
        yield { type: 'tool-call', toolCallId: 'mcp-active-policy-call', toolName, input: { query: 'docs' } } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' } as const
        return
      }
      yield { type: 'text-delta', text: 'policy changed during execution' } as const
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' } as const
    } })
    const history = new MemoryHistory()
    const host = createHostedAgentTurnHost({
      invocationId: requestId, turnId: 'mcp-hosted-active-policy-turn', routeId: route.routeId,
      providerRegistry: providers, toolRegistry: mcpRegistry, authorizedToolNames: new Set([toolName]),
      capabilities, permits, admission, safetyGate, history,
      prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, maxConcurrentTools: 1, maxModelTurns: 3
    })
    const turn = runHostedAgentTurn({
      host, invocationId: requestId, turnId: 'mcp-hosted-active-policy-turn', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'search docs' }], maxTokens: 64, tools: [{ name: toolName, description: 'Search docs', inputSchema: { type: 'object' } }] }
    })

    await executorEntered
    expect(executeSignal?.aborted).toBe(false)
    authorizationVersion = 'mcp-policy-v2'
    expect(policyChanges.publish('desktop')).toBe(1)
    expect(executeSignal?.aborted).toBe(true)
    await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount(requestId)).toBe(0)
    expect(admission.executorEntries).toBe(1)
    const events = (await history.read(requestId)).events
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    await manager.shutdown()
  })
})
