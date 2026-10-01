import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { InvocationHistoryWriter, MemoryHistory } from '../../packages/agent-sdk/src/history'
import { runHostedAgentTurn } from '../../packages/agent-sdk/src/turn'
import { createAgentSdkTurnDispatch } from '../tools/agentSdkTurnDispatch'
import { createRegisteredAgentTurnTools } from '../tools/registeredAgentTurnTools'
import { definePlannedTool, TypedToolRegistry } from '../tools/plannedToolRegistry'
import { createAgentSdkSafetyPolicy } from '../confirmation/agentSdkSafetyPolicy'
import { createAgentSdkConfirmationPort } from '../confirmation/agentSdkConfirmationPort'
import type { ToolCallGateResult } from '../confirmation/toolCallGate'
import { createHostedAgentTurnHost } from './hostedAgentTurnHost'
import { assembleInvocation } from './invocationAssembler'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { createAgentSdkOutputRecovery } from './agentSdkOutputRecovery'
import { createAgentSdkUsageRecorder, createAgentSdkUsageSessionEvent } from './agentSdkUsageRecorder'
import { decodeTerminalOutcome } from './terminalOutcome'
import { rebuildClaudeMessagesFromHistory } from './canonicalHistory'
import { createAgentRuntime } from './agentRuntime'
import { getDefaultAgentRuntime, resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './agentRuntimeDefaults'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { createRunScriptRegisteredTool } from '../tools/runScriptRegisteredTool'
import { isTruncatedToolResultContent } from '../../src/shared/oversizedToolResult'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from '../../src/shared/toolResultLimits'

const route = { routeId: 'desktop-test', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }

function baseDependencies() {
  const providerRegistry = new ModelProviderRegistry()
  const onProviderStart = vi.fn()
  providerRegistry.register(route, { providerId: 'test-provider', stream: async function* () {
    onProviderStart()
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
    yield { type: 'finish', reason: 'stop' }
  } })
  const capabilities = new CapabilityRegistry()
  capabilities.define('req-host', [])
  const permits = new InMemorySafetyPermitStore()
  const admission = new InMemoryExecutionAdmissionCoordinator()
  const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } })
  return {
    invocationId: 'req-host',
    turnId: 'turn-host',
    routeId: route.routeId,
    providerRegistry,
    authorizedToolNames: new Set(['lookup']),
    onProviderStart,
    toolRegistry: { get: vi.fn((name: string) => name === 'lookup' ? { name } : undefined) },
    permits,
    admission,
    capabilities,
    safetyGate,
    history: new MemoryHistory(),
    prepareTool: vi.fn(async () => { throw new Error('unused') }),
    discardPreparedTool: vi.fn(),
    toolExecution: { execute: vi.fn() },
    recordProviderAttemptUsage: vi.fn(),
    recoverProviderAttempt: vi.fn(async () => undefined),
    turnBoundary: vi.fn(async () => undefined),
    resourceLocks: { acquire: vi.fn(async () => ({ release: vi.fn() })) },
    toolResourceKeys: vi.fn(() => [] as readonly string[]),
    isApprovalCandidate: vi.fn(() => true),
    maxConcurrentTools: 2,
    maxModelTurns: 4
  }
}

describe('Desktop Hosted AgentTurnHost composition', () => {
  it('composes route, invocation identity, mandatory policy/execution ports and History into SDK ports', async () => {
    const deps = baseDependencies()
    const host = createHostedAgentTurnHost(deps)
    const request = { messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 128, tools: [{ name: 'lookup', description: 'lookup', inputSchema: {} }, { name: 'missing', description: 'missing', inputSchema: {} }] }

    const ports = await host.createPorts({ invocationId: 'req-host', turnId: 'turn-host', currentUserMessageId: 'user-1', requiredUserMessage: { id: 'user-1', message: request.messages[0]! }, routeId: route.routeId, request })

    expect(ports).toMatchObject({ invocationId: 'req-host', turnId: 'turn-host', routeId: route.routeId, registry: deps.providerRegistry, safetyGate: deps.safetyGate, history: deps.history, maxConcurrentTools: 2, maxModelTurns: 4 })
    expect(ports.prepareTool).toBe(deps.prepareTool)
    expect(ports.discardPreparedTool).toBe(deps.discardPreparedTool)
    expect(ports.toolExecution).toBe(deps.toolExecution)
    expect(ports.recordProviderAttemptUsage).toBe(deps.recordProviderAttemptUsage)
    expect(ports.recoverProviderAttempt).toBe(deps.recoverProviderAttempt)
    expect(ports.turnBoundary).toBe(deps.turnBoundary)
    expect(ports.resourceLocks).toBe(deps.resourceLocks)
    expect(ports.toolResourceKeys).toBe(deps.toolResourceKeys)
    expect(ports.isApprovalCandidate).toBe(deps.isApprovalCandidate)
    expect(deps.capabilities.visible('req-host')).toEqual(['lookup'])
    await expect(deps.safetyGate.evaluate({ requestId: 'req-host', turnId: 'turn-host', invocationId: 'req-host', toolCallId: 'missing-call', capabilityId: 'missing', inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'UNAUTHORIZED_CAPABILITY' })
  })

  it('does not authorize a registered tool that is absent from the invocation effective capability set', async () => {
    const deps = baseDependencies()
    const host = createHostedAgentTurnHost({ ...deps, authorizedToolNames: new Set<string>() })
    const ports = await host.createPorts({
      invocationId: deps.invocationId, routeId: deps.routeId,
      request: { messages: [], maxTokens: 32, tools: [{ name: 'lookup', description: 'lookup', inputSchema: {} }] }
    })

    expect(deps.capabilities.lookup(deps.invocationId, 'lookup')).toEqual({ state: 'known-unauthorized', id: 'lookup' })
    await expect(deps.safetyGate.evaluate({
      requestId: deps.invocationId, turnId: deps.turnId, invocationId: deps.invocationId, toolCallId: 'lookup-1',
      capabilityId: 'lookup', inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat'
    })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'UNAUTHORIZED_CAPABILITY' })
    expect(ports.registry).toBe(deps.providerRegistry)
  })

  it('does not make a product-authorized tool known when it is absent from this model request', async () => {
    const deps = baseDependencies()
    const host = createHostedAgentTurnHost({ ...deps, authorizedToolNames: new Set(['lookup']) })
    await host.createPorts({
      invocationId: deps.invocationId, routeId: deps.routeId,
      request: { messages: [], maxTokens: 32, tools: [] }
    })

    expect(deps.capabilities.lookup(deps.invocationId, 'lookup')).toEqual({ state: 'unknown', requestedId: 'lookup' })
  })

  it('matches sanitized provider tool aliases against the product-authorized internal identity', async () => {
    const deps = baseDependencies()
    const aliasRegistry = { get: vi.fn((name: string) => name === 'lookup.internal' ? { name } : undefined) }
    const host = createHostedAgentTurnHost({
      ...deps,
      toolRegistry: aliasRegistry,
      resolveRegisteredToolName: (name) => name === 'lookup_internal' ? 'lookup.internal' : name,
      authorizedToolNames: new Set(['lookup.internal'])
    })
    await host.createPorts({
      invocationId: deps.invocationId, routeId: deps.routeId,
      request: { messages: [], maxTokens: 32, tools: [{ name: 'lookup_internal', description: 'lookup', inputSchema: {} }] }
    })

    expect(deps.capabilities.lookup(deps.invocationId, 'lookup_internal')).toEqual({ state: 'known-authorized', id: 'lookup_internal' })
  })

  it('composes the desktop observer into hosted SDK ports when provided', async () => {
    const deps = baseDependencies()
    const observer = { onTurnFinished: vi.fn() }
    const hostedDeps = { ...deps, observer }
    const ports = await createHostedAgentTurnHost(hostedDeps).createPorts({ invocationId: deps.invocationId, routeId: deps.routeId, request: { messages: [], maxTokens: 10 } })
    expect(ports.observer).toBe(observer)
  })

  it('composes provider recovery into hosted SDK ports when provided', async () => {
    const deps = baseDependencies()
    const ports = await createHostedAgentTurnHost(deps).createPorts({ invocationId: deps.invocationId, routeId: route.routeId, request: { messages: [], maxTokens: 10 } })
    expect(ports.recoverProviderAttempt).toBe(deps.recoverProviderAttempt)
  })

  it('rejects identity drift between invocation, turn, or provider route before creating SDK ports', async () => {
    const deps = baseDependencies()
    const host = createHostedAgentTurnHost(deps)
    const request = { messages: [], maxTokens: 128 }
    await expect(host.createPorts({ invocationId: 'other', routeId: route.routeId, request })).rejects.toThrow('HOSTED_INVOCATION_ID_MISMATCH')
    await expect(host.createPorts({ invocationId: 'req-host', turnId: 'other-turn', routeId: route.routeId, request })).rejects.toThrow('HOSTED_TURN_ID_MISMATCH')
    await expect(host.createPorts({ invocationId: 'req-host', routeId: 'other-route', request })).rejects.toThrow('HOSTED_ROUTE_ID_MISMATCH')
  })

  it('runs a real Hosted SDK model turn through the composed provider and History ports', async () => {
    const deps = baseDependencies()
    const host = createHostedAgentTurnHost(deps)
    const onModelChunk = vi.fn()
    const result = await runHostedAgentTurn({
      host, invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 },
      observer: { onModelChunk }
    })

    expect(result.text).toBe('ok')
    expect(result.modelTurns).toBe(1)
    expect(onModelChunk).toHaveBeenCalledTimes(2)
    await expect(deps.history.read(deps.invocationId)).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'model-response-committed' }), expect.objectContaining({ kind: 'invocation-completed' })])
    })
  })

  it('records only observed usage for cancelled Hosted model attempts', async () => {
    for (const withUsage of [false, true]) {
      const deps = baseDependencies()
      const controller = new AbortController()
      const providerStream = vi.fn(async function* () {
        controller.abort()
        if (withUsage) yield { type: 'usage' as const, inputTokens: 0, outputTokens: 0 }
        yield { type: 'finish' as const, reason: 'cancelled' as const }
      })
      deps.providerRegistry.register(route, { providerId: 'cancel-hosted-provider', stream: providerStream })
      const recordStepUsage = vi.fn()
      const emitSessionEvent = vi.fn()
      const emitFactEvent = vi.fn()
      const recordProviderAttemptUsage = createAgentSdkUsageRecorder({
        requestId: deps.invocationId, sessionId: 'session-host', turnId: deps.turnId,
        recordStepUsage, emitSessionEvent, emitFactEvent
      })
      const sessionLedgerForAttemptUsage = vi.fn((attempt: Record<string, unknown>) => {
        const event = createAgentSdkUsageSessionEvent({ requestId: deps.invocationId, turnId: deps.turnId }, attempt)
        return event ? { location: { sessionId: 'session-host' }, requestUsage: event.payload } : {}
      })
      const host = createHostedAgentTurnHost({ ...deps, recordProviderAttemptUsage, sessionLedgerForAttemptUsage })

      await expect(runHostedAgentTurn({
        host, invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
        request: { messages: [{ role: 'user', content: 'cancel this request' }], maxTokens: 32, signal: controller.signal }
      })).rejects.toMatchObject({ code: 'TURN_CANCELLED' })

      expect(providerStream).toHaveBeenCalledOnce()
      expect(recordStepUsage).toHaveBeenCalledTimes(withUsage ? 1 : 0)
      expect(emitSessionEvent).toHaveBeenCalledTimes(withUsage ? 1 : 0)
      expect(emitFactEvent).toHaveBeenCalledTimes(withUsage ? 1 : 0)
      if (withUsage) expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'request_usage', payload: expect.objectContaining({
          requestId: `${deps.invocationId}:round:1`, turnId: deps.turnId,
          usage: expect.objectContaining({ input_tokens: 0, output_tokens: 0 })
        }) }))
      expect(sessionLedgerForAttemptUsage).toHaveBeenCalledTimes(withUsage ? 1 : 0)
      const events = (await deps.history.read(deps.invocationId)).events
      const terminals = events.filter((event) => ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind))
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
      expect(decodeTerminalOutcome(terminals[0]!)).toBe('cancelled')
      const attemptUsageEvents = events.filter((event) => event.kind === 'model-attempt-discarded')
      expect(attemptUsageEvents).toHaveLength(withUsage ? 1 : 0)
      if (withUsage) {
        expect(terminals[0]?.payload).toHaveProperty('usage', { type: 'usage', inputTokens: 0, outputTokens: 0 })
        expect(attemptUsageEvents[0]).toMatchObject({
          payload: {
            reasonCode: 'TURN_CANCELLED', finishReason: 'cancelled',
            sessionLedger: { requestUsage: { requestId: `${deps.invocationId}:round:1`, turnId: deps.turnId } }
          }
        })
      } else expect(terminals[0]?.payload).not.toHaveProperty('usage')
    }
  })

  it('stops after the configured tool round limit and records the next proposal as not dispatched', async () => {
    const deps = baseDependencies()
    const toolUseIds: string[] = []
    let modelRound = 0
    deps.providerRegistry.register(route, { providerId: 'round-limit-provider', stream: async function* () {
      const current = modelRound++
      if (current < 3) {
        const toolCallId = `round-limit-${current + 1}`
        toolUseIds.push(toolCallId)
        yield { type: 'tool-call' as const, toolCallId, toolName: 'lookup', input: { query: 'continue' } }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'tool-calls' as const }
        return
      }
      yield { type: 'text-delta' as const, text: 'done' }
      yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish' as const, reason: 'stop' as const }
    } })
    const lookupExecutor = vi.fn(async () => ({ success: true, data: 'result' }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'lookup', parseInput: (raw) => raw as { query: string }, plan: async (input) => input, execute: lookupExecutor }))
    const registered = createRegisteredAgentTurnTools({
      requestId: deps.invocationId, turnId: deps.turnId, registry, permits: deps.permits, admission: deps.admission,
      createExecutionContext: () => ({ workDir: '/tmp' } as never), resolveAuthorizationVersion: () => 'policy-v1'
    })
    deps.toolRegistry = registry
    deps.authorizedToolNames = new Set(['lookup'])
    deps.prepareTool = registered.prepareTool
    deps.toolExecution = registered.toolExecution
    deps.safetyGate = new SafetyGate({
      capabilities: deps.capabilities, permitStore: deps.permits,
      policy: { evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }) }
    })
    deps.maxToolRounds = 2
    const history = new MemoryHistory()
    deps.history = history
    const host = createHostedAgentTurnHost(deps)

    await expect(runHostedAgentTurn({
      host, invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId, maxToolRounds: 2,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128, tools: [{ name: 'lookup', description: 'lookup', inputSchema: {} }] }
    })).rejects.toMatchObject({ code: 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED', maxToolRounds: 2 })

    const snapshot = await history.read(deps.invocationId)
    expect(modelRound).toBe(3)
    expect(lookupExecutor).toHaveBeenCalledTimes(2)
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      kind: 'tool-call-not-dispatched',
      payload: expect.objectContaining({ toolCallId: 'round-limit-3', reason: 'tool_loop_max_rounds_exceeded' })
    }))
    expect(snapshot.events).not.toContainEqual(expect.objectContaining({
      kind: 'tool-call-started', payload: expect.objectContaining({ toolCallId: 'round-limit-3' })
    }))
  })

  it('projects a real Hosted turn through the Desktop observer after History commit', async () => {
    const deps = baseDependencies()
    const events: string[] = []
    const projected: Array<{ type: string; payload: Record<string, unknown> }> = []
    const assembled = assembleInvocation({
      requestId: deps.invocationId, sessionId: 'session-host', turnId: deps.turnId, model: route.modelId, providerRouteId: deps.routeId, locale: 'zh-CN',
      messages: [{ role: 'user', content: 'hello' }], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent: (event) => { events.push(`fact:${event.type}`) },
      sessionEventLocation: { workDir: '/tmp', sessionId: 'session-host', createdAt: 1000 },
      emitSessionEvent: async (event) => {
        const history = await deps.history.read(deps.invocationId)
        const projectionIndex = projected.length
        projected.push(event as { type: string; payload: Record<string, unknown> })
        if (projectionIndex < 2) {
          expect(history.events.some((entry) => entry.kind === 'model-request-started' && Boolean((entry.payload as { sessionLedger?: unknown }).sessionLedger))).toBe(true)
          expect(history.events.some((entry) => entry.kind === 'model-response-committed')).toBe(false)
        } else {
          expect(history.events.some((entry) => entry.kind === 'model-response-committed')).toBe(true)
        }
        events.push(`session:${event.type}`)
      },
    })
    const observer = assembled.ports.observer
    deps.onProviderStart.mockImplementation(() => {
      expect(projected.slice(0, 2).map((event) => event.type)).toEqual(['request_header', 'request_context'])
    })
    const result = await runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, observer }), invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
    })
    expect(result.text).toBe('ok')
    expect(deps.onProviderStart).toHaveBeenCalledOnce()
    expect(projected.slice(0, 2).map((event) => event.type)).toEqual(['request_header', 'request_context'])
    expect(projected[0]?.payload).toMatchObject({ requestId: `${deps.invocationId}:round:1` })
    expect(projected[1]?.payload).toMatchObject({ requestId: `${deps.invocationId}:round:1` })
    const requestOutbox = (await deps.history.read(deps.invocationId)).events.find((event) => event.kind === 'model-request-started')
    expect(requestOutbox?.payload).toMatchObject({
      sessionLedger: {
        location: { workDir: '/tmp', sessionId: 'session-host', createdAt: 1000 },
        requestHeader: { route: 'anthropic.messages.stream', requestId: `${deps.invocationId}:round:1`, attempt: 1 },
        requestContext: { requestId: `${deps.invocationId}:round:1`, attempt: 1 }
      }
    })
    expect(events).toContain('session:assistant_chunk')
    expect(events).toContain('fact:content-delta')
    expect(events).toContain('fact:preview-commit')
  })

  it('projects staged Remote content before the Hosted terminal History commit', async () => {
    const deps = baseDependencies()
    const order: string[] = []
    const facts: Array<{ type: string; text?: string }> = []
    const appendBatch = deps.history.appendBatch.bind(deps.history)
    vi.spyOn(deps.history, 'appendBatch').mockImplementation(async (events, version) => {
      const result = await appendBatch(events, version)
      for (const event of events) order.push(`history:${event.kind}`)
      return result
    })
    deps.providerRegistry.register(route, { providerId: 'test-provider', stream: async function* () {
      yield { type: 'text-delta', text: 'final remote answer' } as const
      expect(facts.some((fact) => fact.type === 'content-delta')).toBe(false)
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' }
    } })
    const { ports } = assembleInvocation({
      requestId: deps.invocationId, sessionId: 'remote-session-host', turnId: deps.turnId, model: route.modelId,
      providerRouteId: deps.routeId, locale: 'zh-CN', messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: deps.history, remoteContext: { source: 'feishu', messageId: 'remote-message', confirmPolicy: 'always' },
      emitFactEvent: (event) => {
        facts.push(event as { type: string; text?: string })
        if (event.type === 'content-reconciled') order.push('fact:content-reconciled')
      },
      emitSessionEvent: vi.fn()
    })

    const result = await runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, observer: ports.observer }),
      invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
    })

    expect(result.text).toBe('final remote answer')
    expect(facts.filter((fact) => fact.type === 'content-delta')).toEqual([])
    expect(facts).toContainEqual({ type: 'content-reconciled', text: 'final remote answer' })
    expect(order.indexOf('fact:content-reconciled')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('history:invocation-completed')).toBeGreaterThan(order.indexOf('fact:content-reconciled'))
  })

  it('does not leak staged Remote text when the Hosted provider fails mid-stream', async () => {
    const deps = baseDependencies()
    deps.providerRegistry.register(route, { providerId: 'test-provider', stream: async function* () {
      yield { type: 'text-delta', text: 'partial remote answer' } as const
      throw new Error('remote provider disconnected')
    } })
    const facts: unknown[] = []
    const { ports } = assembleInvocation({
      requestId: deps.invocationId, sessionId: 'remote-failed-session', turnId: deps.turnId, model: route.modelId,
      providerRouteId: deps.routeId, locale: 'zh-CN', messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: deps.history, remoteContext: { source: 'wechat', messageId: 'failed-message', confirmPolicy: 'always' },
      emitFactEvent: (event) => facts.push(event), emitSessionEvent: vi.fn()
    })

    await expect(runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, observer: ports.observer }),
      invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
    })).rejects.toThrow('remote provider disconnected')

    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-delta' }))
    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-reconciled' }))
    expect(facts).not.toContainEqual({ type: 'preview-rollback' })
    expect((await deps.history.read(deps.invocationId)).events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('records provider usage received before a Hosted stream failure without committing a response', async () => {
    const deps = baseDependencies()
    deps.providerRegistry.register(route, { providerId: 'failed-usage-provider', stream: async function* () {
      yield { type: 'usage', inputTokens: 1234, outputTokens: 0 } as const
      throw new Error('provider disconnected after usage')
    } })

    await expect(runHostedAgentTurn({
      host: createHostedAgentTurnHost(deps), invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
    })).rejects.toThrow('provider disconnected after usage')

    expect(deps.recordProviderAttemptUsage).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: deps.invocationId, modelTurn: 1, attempt: 1, disposition: 'failed',
      usage: expect.objectContaining({ inputTokens: 1234, outputTokens: 0 })
    }))
    await expect(deps.history.read(deps.invocationId)).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'invocation-failed' })])
    })
    await expect(deps.history.read(deps.invocationId)).resolves.toMatchObject({
      events: expect.not.arrayContaining([expect.objectContaining({ kind: 'model-response-committed' })])
    })
  })

  it('does not complete or deliver staged Remote text when the provider ends as cancelled', async () => {
    const deps = baseDependencies()
    deps.providerRegistry.register(route, { providerId: 'test-provider', stream: async function* () {
      yield { type: 'text-delta', text: 'cancelled partial answer' } as const
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
      yield { type: 'finish', reason: 'cancelled' } as const
    } })
    const facts: unknown[] = []
    const { ports } = assembleInvocation({
      requestId: deps.invocationId, sessionId: 'remote-cancelled-session', turnId: deps.turnId, model: route.modelId,
      providerRouteId: deps.routeId, locale: 'zh-CN', messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: deps.history, remoteContext: { source: 'feishu', messageId: 'cancelled-message', confirmPolicy: 'always' },
      emitFactEvent: (event) => facts.push(event), emitSessionEvent: vi.fn()
    })

    await expect(runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, observer: ports.observer }),
      invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
    })).rejects.toThrow('agent turn cancelled')

    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-delta' }))
    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-reconciled' }))
    expect(facts).not.toContainEqual({ type: 'preview-rollback' })
    expect((await deps.history.read(deps.invocationId)).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
  })

  it('recovers a truncated tool response through Hosted History and never dispatches its partial proposal', async () => {
    const deps = baseDependencies()
    const providerRegistry = new ModelProviderRegistry()
    let providerCalls = 0
    providerRegistry.register(route, { providerId: 'output-recovery-provider', stream: async function* () {
      providerCalls += 1
      if (providerCalls === 1) {
        yield { type: 'tool-call', toolCallId: 'truncated-write', toolName: 'lookup', input: { query: 'partial' } } as const
        yield { type: 'usage', inputTokens: 100, outputTokens: 128 } as const
        yield { type: 'finish', reason: 'length' } as const
      } else {
        yield { type: 'text-delta', text: 'completed after recovery' } as const
        yield { type: 'usage', inputTokens: 110, outputTokens: 20 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    } })
    const prepareTool = vi.fn(async () => { throw new Error('truncated tool proposal must not be prepared') })
    const history = deps.history
    const result = await runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, providerRegistry, prepareTool, recoverOutputLimit: createAgentSdkOutputRecovery() }),
      invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: {
        messages: [{ role: 'user', content: 'lookup information' }], maxTokens: 128,
        tools: [{ name: 'lookup', description: 'lookup', inputSchema: {} }]
      }
    })

    expect(result.text).toBe('completed after recovery')
    expect(providerCalls).toBe(2)
    expect(prepareTool).not.toHaveBeenCalled()
    expect(deps.toolExecution.execute).not.toHaveBeenCalled()
    const events = (await history.read(deps.invocationId)).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'truncated-write', reason: 'MODEL_OUTPUT_TRUNCATED' }) }))
    const rebuilt = rebuildClaudeMessagesFromHistory(events)
    expect(rebuilt.some((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result' && block.is_error))).toBe(true)
    expect(rebuilt.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('运行时恢复通知'))).toBe(true)
  })

  it('does not duplicate Desktop session/fact projection for an already-projected committed handoff response', async () => {
    const deps = baseDependencies()
    const requestId = deps.invocationId
    const turnId = deps.turnId
    const userMessage = { role: 'user' as const, content: 'hello' }
    const assistantMessage = { role: 'assistant' as const, content: 'legacy response' }
    const writer = new InvocationHistoryWriter(deps.history, { invocationId: requestId, turnId })
    await writer.append([
      { kind: 'invocation-context-committed', payload: { messages: [userMessage] } },
      { kind: 'model-response-committed', payload: { message: assistantMessage, finishReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } } }
    ])
    const emitFactEvent = vi.fn()
    const emitSessionEvent = vi.fn()
    const assembled = assembleInvocation({
      requestId, sessionId: 'session-handoff', turnId, model: route.modelId, providerRouteId: route.routeId, locale: 'zh-CN',
      messages: [userMessage], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent, emitSessionEvent
    })
    const result = await runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, observer: assembled.ports.observer }),
      invocationId: requestId, turnId, routeId: route.routeId,
      request: { messages: [userMessage], maxTokens: 128 },
      initialResponse: {
        message: assistantMessage, finishReason: 'stop', usage: { type: 'usage', inputTokens: 2, outputTokens: 3 },
        historyCommitted: true, hostProjectionCommitted: true
      }
    })

    expect(result).toMatchObject({ text: 'legacy response', modelTurns: 1, usage: { inputTokens: 2, outputTokens: 3 } })
    expect(emitSessionEvent).not.toHaveBeenCalled()
    expect(emitFactEvent).not.toHaveBeenCalled()
  })

  it('reuses the committed proposal stepId for tool result projections on initialResponse handoff', async () => {
    const deps = baseDependencies()
    const runtime = createAgentRuntime({ safetyPermits: deps.permits, executionAdmission: deps.admission, modelProviders: deps.providerRegistry })
    setDefaultAgentRuntime(runtime)
    const toolCall = { id: 'legacy-tool-call', name: 'lookup', input: { query: 'plan' } }
    const assistantMessage = { role: 'assistant' as const, content: [], toolCalls: [toolCall] }
    const proposalStepId = 'legacy:committed:model-step:owner'
    const writer = new InvocationHistoryWriter(deps.history, { invocationId: deps.turnId, turnId: deps.turnId })
    await writer.append([
      { kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'find plan' }] } },
      { kind: 'model-response-committed', payload: {
        message: assistantMessage, finishReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 },
        sessionLedger: { location: { workDir: '/tmp', sessionId: 'session-handoff-step', createdAt: 1 }, stepId: proposalStepId, toolCalls: [{ toolUseId: toolCall.id, name: toolCall.name, args: toolCall.input }] }
      } }
    ])
    const emitSessionEvent = vi.fn()
    const assembled = assembleInvocation({
      requestId: deps.invocationId, sessionId: 'session-handoff-step', turnId: deps.turnId, model: route.modelId,
      providerRouteId: deps.routeId, locale: 'zh-CN', messages: [{ role: 'user', content: 'find plan' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: deps.history, sessionEventLocation: { workDir: '/tmp', sessionId: 'session-handoff-step', createdAt: 1 }, emitFactEvent: vi.fn(), emitSessionEvent
    })
    const execute = vi.fn(async () => ({ success: true, data: { found: true } }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'lookup', parseInput: (raw) => raw as { query: string }, plan: async (input) => input, execute }))
    const registered = assembled.agentSdk.createRegisteredTools({ registry, refreshExecutionContext: (_call, _stage, current) => current })
    const host = assembled.agentSdk.createHostedTurnHost({ registeredTools: registered, registry, authorizedToolNames: new Set(['lookup']), policy: {
      evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion })
    } as never })
    const request = { messages: [{ role: 'user' as const, content: 'find plan' }], maxTokens: 128, tools: [{ name: 'lookup', description: 'lookup', inputSchema: {} }] }
    const hostPorts = await host.createPorts({ invocationId: deps.turnId, turnId: deps.turnId, routeId: deps.routeId, request })
    expect(() => hostPorts.sessionLedgerForModelResponse?.(assistantMessage, 1, 1, {
      location: { workDir: '/other-workspace', sessionId: 'session-handoff-step', createdAt: 1 },
      stepId: proposalStepId,
      toolCalls: [{ toolUseId: 'forged-call', name: 'lookup', args: { query: 'plan' } }]
    })).toThrow('HOST_COMMITTED_SESSION_LEDGER_IDENTITY_MISMATCH')

    await runHostedAgentTurn({
      host, invocationId: deps.turnId, turnId: deps.turnId, routeId: deps.routeId,
      request,
      initialResponse: { message: assistantMessage, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }, historyCommitted: true, hostProjectionCommitted: true }
    })

    const events = (await deps.history.read(deps.turnId)).events
    const finished = events.find((event) => event.kind === 'tool-call-finished')
    expect(events.map((event) => ({ kind: event.kind, payload: event.payload }))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool-call-finished' })]))
    expect((finished?.payload as { sessionLedger?: { stepId?: string } }).sessionLedger?.stepId).toBe(proposalStepId)
    expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result', payload: expect.objectContaining({ toolUseId: toolCall.id, stepId: proposalStepId }) }))
    expect(execute).toHaveBeenCalledOnce()
    resetDefaultAgentRuntimeForTests()
  })

  it('awaits assembled provider usage persistence before committing and projecting the response', async () => {
    const deps = baseDependencies()
    const order: string[] = []
    const appendBatch = deps.history.appendBatch.bind(deps.history)
    vi.spyOn(deps.history, 'appendBatch').mockImplementation(async (events, expectedVersion) => {
      if (events.some((event) => event.kind === 'model-response-committed')) order.push('response-committed')
      return appendBatch(events, expectedVersion)
    })
    const recordProviderAttemptUsage = vi.fn(async () => { order.push('usage-persisted') })
    const observer = {
      onModelChunk: vi.fn(async () => { order.push('model-chunk') })
    }
    const result = await runHostedAgentTurn({
      host: createHostedAgentTurnHost({ ...deps, recordProviderAttemptUsage, observer }),
      invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 }
    })

    expect(result.text).toBe('ok')
    expect(recordProviderAttemptUsage).toHaveBeenCalledOnce()
    expect(order.indexOf('usage-persisted')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('usage-persisted')).toBeLessThan(order.indexOf('response-committed'))
    await expect(deps.history.read(deps.invocationId)).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'model-response-committed' })])
    })
  })

  it('runs a RegisteredTool through Hosted turn safety recheck, permit admission, executor and canonical History', async () => {
    const deps = baseDependencies()
    deps.authorizedToolNames = new Set(['write.file'])
    const events: string[] = []
    const typedRegistry = new TypedToolRegistry()
    const execute = vi.fn(async () => { events.push('execute'); return { success: true, data: { saved: true } } })
    typedRegistry.register(definePlannedTool({
      name: 'write.file', parseInput: (raw) => raw as { path: string },
      plan: async (input) => { events.push('plan'); return input },
      validate: async () => { events.push('validate') }, execute
    }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const callAuthorization = new Map<string, string>()
    const gateCalls: string[] = []
    const registered = createRegisteredAgentTurnTools({
      requestId: deps.invocationId, turnId: deps.turnId, registry: typedRegistry, permits, admission,
      createExecutionContext: () => ({ workDir: '/workspace', sessionId: 'session-host' } as never),
      resolveAuthorizationVersion: (call) => callAuthorization.get(call.toolCallId) ?? 'policy-v1',
      mapExecutionResult: (result) => ({ output: result })
    })
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async (binding) => {
        gateCalls.push(binding.phase)
        return { toolName: binding.capabilityId, toolInput: { path: 'note.txt' }, sessionId: 'session-host', workDir: '/workspace', userDataDir: '/tmp', toolsConfig: {}, effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} } } as never
      },
      evaluateGate: async (args) => ({ decision: { type: 'auto-allow', ruleId: 'host-read-write-policy', reason: 'test' }, facts: { toolName: args.toolName, actionClass: 'write', baseRiskLevel: 'low', signals: [], summary: { text: 'test' } }, approvedFactIds: [] })
    })
    deps.capabilities.define(deps.invocationId, ['write_file'])
    const safetyGate = new SafetyGate({ capabilities: deps.capabilities, permitStore: permits, policy })
    const providers = deps.providerRegistry
    const rounds = [
      (async function* () { yield { type: 'tool-call' as const, toolCallId: 'save-1', toolName: 'write_file', input: { path: 'note.txt' } }; yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }; yield { type: 'finish' as const, reason: 'tool-calls' } })(),
      (async function* () { yield { type: 'text-delta' as const, text: 'saved' }; yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }; yield { type: 'finish' as const, reason: 'stop' } })()
    ]
    providers.register(route, { providerId: 'test-provider', stream: () => rounds.shift()! })
    Object.assign(deps, {
      toolRegistry: typedRegistry,
      capabilities: deps.capabilities,
      permits,
      admission,
      safetyGate,
      prepareTool: async (call: Parameters<typeof registered.prepareTool>[0], stage: Parameters<typeof registered.prepareTool>[1]) => {
        const binding = await registered.prepareTool(call, stage)
        callAuthorization.set(call.toolCallId, binding.authorizationVersion)
        return binding
      },
      discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution,
      toolResourceKeys: registered.toolResourceKeys
    })
    const host = createHostedAgentTurnHost(deps)

    const result = await runHostedAgentTurn({
      host, invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'save note' }], maxTokens: 128, tools: [{ name: 'write_file', description: 'write', inputSchema: { type: 'object' } }] }
    })

    expect(result.text).toBe('saved')
    expect(events).toEqual(['plan', 'validate', 'validate', 'execute'])
    expect(gateCalls).toEqual(['initial-compat', 'recheck'])
    expect(execute).toHaveBeenCalledOnce()
    expect(admission.executorEntries).toBe(1)
    expect(admission.activeLeaseCount(deps.invocationId, deps.invocationId)).toBe(0)
    await expect(deps.history.read(deps.invocationId)).resolves.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ kind: 'tool-call-started' }), expect.objectContaining({ kind: 'tool-call-finished' })]) })
  })

  it('settles Hosted run_script revoke after dispatch as unknown without retrying provider', async () => {
    const deps = baseDependencies()
    deps.authorizedToolNames = new Set(['run_script'])
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(deps.invocationId, 'desktop', deps.turnId)
    const typedRegistry = new TypedToolRegistry()
    let executorSignal: AbortSignal | undefined
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const executor = vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
      executorSignal = context.signal
      markEntered()
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'SCRIPT_CANCELLED' }
    })
    typedRegistry.register(createRunScriptRegisteredTool({ name: 'run_script', execute: executor } as never))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const registered = createRegisteredAgentTurnTools({
      requestId: deps.invocationId, turnId: deps.turnId, registry: typedRegistry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: () => ({
        workDir: '/workspace', userDataDir: '/tmp',
        toolsConfig: { scriptTimeout: 10, pythonPath: 'python', scriptInterpreterPaths: {} }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1',
      mapExecutionResult: (result) => ({ output: result })
    })
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => ({
        toolName: 'run_script', toolInput: { language: 'python', code: 'print("hello")' },
        sessionId: 'session-host', workDir: '/workspace', userDataDir: '/tmp',
        toolsConfig: { scriptTimeout: 10, pythonPath: 'python', scriptInterpreterPaths: {} },
        effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} }
      } as never),
      evaluateGate: async () => ({
        decision: { type: 'auto-allow', ruleId: 'run-script-allow', reason: 'test' },
        facts: { toolName: 'run_script', actionClass: 'execute', baseRiskLevel: 'low', signals: [], summary: { text: 'execute script' } },
        approvedFactIds: []
      })
    })
    deps.capabilities.define(deps.invocationId, ['run_script'])
    Object.assign(deps, {
      toolRegistry: typedRegistry, permits, admission,
      safetyGate: new SafetyGate({ capabilities: deps.capabilities, permitStore: permits, policy }),
      prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, toolResourceKeys: registered.toolResourceKeys
    })
    const providerCalls: string[] = []
    const toolRounds = [
      (async function* () {
        providerCalls.push('tool-call')
        yield { type: 'tool-call' as const, toolCallId: 'script-1', toolName: 'run_script', input: { language: 'python', code: 'print("hello")' } }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'tool-calls' }
      })(),
      (async function* () {
        providerCalls.push('retry')
        yield { type: 'text-delta' as const, text: 'must not retry' }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' }
      })()
    ]
    deps.providerRegistry.register(route, { providerId: 'run-script-revoke-provider', stream: () => toolRounds.shift()! })
    const runningTurn = runHostedAgentTurn({
      host: createHostedAgentTurnHost(deps), invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'run script' }], maxTokens: 128, tools: [{ name: 'run_script', description: 'run a script', inputSchema: { type: 'object' } }] }
    }).catch(() => undefined)

    await entered
    expect(executorSignal?.aborted).toBe(false)
    expect(revocations.revokeToolForLane('desktop', 'run_script')).toBe(1)
    await runningTurn

    const snapshot = await deps.history.read(deps.invocationId)
    expect(executor).toHaveBeenCalledOnce()
    expect(executorSignal?.aborted).toBe(true)
    expect(providerCalls).toEqual(['tool-call'])
    expect(admission.activeLeaseCount(deps.invocationId, deps.invocationId)).toBe(0)
    expect(snapshot.events.map((event) => event.kind)).toContain('tool-call-started')
    expect(snapshot.events.map((event) => event.kind)).not.toContain('tool-call-finished')
    expect(snapshot.events.at(-1)).toMatchObject({
      kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'unknown-after-dispatch' }
    })
  })

  it('requires an actual confirmation receipt before an unchanged require-confirm may pass fresh recheck', async () => {
    const deps = baseDependencies()
    deps.authorizedToolNames = new Set(['write_file'])
    const typedRegistry = new TypedToolRegistry()
    const execute = vi.fn(async () => ({ success: true }))
    typedRegistry.register(definePlannedTool({ name: 'write_file', parseInput: (raw) => raw as { path: string }, plan: async (input) => input, execute }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const registered = createRegisteredAgentTurnTools({
      requestId: deps.invocationId, turnId: deps.turnId, registry: typedRegistry, permits, admission,
      createExecutionContext: () => ({ workDir: '/workspace', sessionId: 'session-host' } as never), resolveAuthorizationVersion: () => 'policy-v1'
    })
    const gateResult = {
      decision: { type: 'require-confirm' as const, ruleId: 'human-approval', answerer: 'user' as const, riskLevel: 'medium' as const, facts: { toolName: 'write_file', actionClass: 'write' as const, baseRiskLevel: 'medium' as const, signals: [], summary: { text: 'write' } }, memoryTiers: [], timeoutMs: 1000 },
      facts: { toolName: 'write_file', actionClass: 'write' as const, baseRiskLevel: 'medium' as const, signals: [], summary: { text: 'write' } }, approvedFactIds: []
    }
    const safetyPolicy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => ({ toolName: 'write_file', toolInput: { path: 'note.txt' }, sessionId: 'session-host', workDir: '/workspace', userDataDir: '/tmp', toolsConfig: {}, effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} } } as never),
      evaluateGate: async () => gateResult
    })
    const confirmation = createAgentSdkConfirmationPort({
      createChannel: () => ({ request: async () => ({ kind: 'approved', cause: 'user-approved' }), cancel: vi.fn() } as never),
      publish: vi.fn(), cancel: vi.fn(), onApproved: safetyPolicy.markConfirmed
    })
    const safetyGate = new SafetyGate({ capabilities: deps.capabilities, permitStore: permits, policy: safetyPolicy })
    deps.capabilities.define(deps.invocationId, ['write_file'])
    const rounds = [
      (async function* () { yield { type: 'tool-call' as const, toolCallId: 'confirm-1', toolName: 'write_file', input: { path: 'note.txt' } }; yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }; yield { type: 'finish' as const, reason: 'tool-calls' } })(),
      (async function* () { yield { type: 'text-delta' as const, text: 'done' }; yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }; yield { type: 'finish' as const, reason: 'stop' } })()
    ]
    deps.providerRegistry.register(route, { providerId: 'test-provider', stream: () => rounds.shift()! })
    Object.assign(deps, { toolRegistry: typedRegistry, permits, admission, safetyGate, confirmation, prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool, toolExecution: registered.toolExecution, toolResourceKeys: registered.toolResourceKeys })

    const result = await runHostedAgentTurn({ host: createHostedAgentTurnHost(deps), invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'write' }], maxTokens: 128, tools: [{ name: 'write_file', description: 'write', inputSchema: {} }] } })

    expect(result.text).toBe('done')
    expect(execute).toHaveBeenCalledOnce()
    expect(admission.executorEntries).toBe(1)
  })

  it('authorizes a sanitized provider tool alias only when it resolves to a registered internal capability', async () => {
    const deps = baseDependencies()
    deps.authorizedToolNames = new Set(['lookup.internal'])
    deps.toolRegistry = {
      get: vi.fn((name: string) => name === 'lookup.internal' ? { name } : undefined),
      entries: () => [{ name: 'lookup.internal' }]
    } as never
    const host = createHostedAgentTurnHost(deps)
    const ports = await host.createPorts({ invocationId: deps.invocationId, routeId: deps.routeId,
      request: { messages: [], maxTokens: 10, tools: [{ name: 'lookup_internal', description: 'lookup', inputSchema: {} }, { name: 'missing', description: 'missing', inputSchema: {} }] } })

    expect(deps.capabilities.visible(deps.invocationId)).toEqual(['lookup_internal'])
    expect(deps.toolRegistry.get).toHaveBeenCalledWith('lookup.internal')
    expect(await ports.safetyGate.evaluate({ requestId: deps.invocationId, turnId: deps.turnId, invocationId: deps.invocationId, toolCallId: 'missing-1', capabilityId: 'missing', inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' })).toMatchObject({ kind: 'deny', reasonCode: 'UNAUTHORIZED_CAPABILITY' })
  })

  it('executes a sanitized alias through the real Hosted Gate, RegisteredTool and permit admission path', async () => {
    const deps = baseDependencies()
    deps.authorizedToolNames = new Set(['lookup.internal'])
    const execute = vi.fn(async () => ({ success: true, data: { found: true } }))
    const typedRegistry = new TypedToolRegistry()
    typedRegistry.register(definePlannedTool({
      name: 'lookup.internal', parseInput: (raw) => raw as { query: string },
      plan: async (input) => input, validate: async () => undefined, execute
    }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const registered = createRegisteredAgentTurnTools({
      requestId: deps.invocationId, turnId: deps.turnId, registry: typedRegistry, permits, admission,
      resolveRegisteredToolName: (name) => name === 'lookup_internal' ? 'lookup.internal' : name,
      createExecutionContext: () => ({ workDir: '/workspace', sessionId: 'session-host' }),
      resolveAuthorizationVersion: () => 'policy-v1',
      mapExecutionResult: (result) => ({ output: result })
    })
    const gateNames: string[] = []
    const policy = createAgentSdkSafetyPolicy({
      resolveToolCall: registered.getPreparedCall,
      resolveToolName: (name) => name === 'lookup_internal' ? 'lookup.internal' : name,
      resolveGateArgs: async (binding, call) => ({
        toolName: call?.toolName === 'lookup_internal' ? 'lookup.internal' : binding.capabilityId,
        toolInput: call?.input ?? {}, sessionId: 'session-host', workDir: '/workspace', userDataDir: '/tmp',
        toolsConfig: {}, effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} }
      } as never),
      evaluateGate: async (args) => {
        gateNames.push(args.toolName)
        return { decision: { type: 'auto-allow', ruleId: 'lookup-policy', reason: 'safe lookup' }, facts: { toolName: args.toolName, actionClass: 'read', baseRiskLevel: 'low', signals: [], summary: { text: 'lookup' } }, approvedFactIds: [] }
      }
    })
    const safetyGate = new SafetyGate({ capabilities: deps.capabilities, permitStore: permits, policy })
    const rounds = [
      (async function* () { yield { type: 'tool-call', toolCallId: 'lookup-call', toolName: 'lookup_internal', input: { query: 'value' } }; yield { type: 'usage', inputTokens: 1, outputTokens: 1 }; yield { type: 'finish', reason: 'tool-calls' } })(),
      (async function* () { yield { type: 'text-delta', text: 'found' }; yield { type: 'usage', inputTokens: 1, outputTokens: 1 }; yield { type: 'finish', reason: 'stop' } })()
    ]
    deps.providerRegistry.register(route, { providerId: 'test-provider', stream: () => rounds.shift()! })
    Object.assign(deps, {
      toolRegistry: typedRegistry, permits, admission, safetyGate,
      resolveRegisteredToolName: (name: string) => name === 'lookup_internal' ? 'lookup.internal' : name,
      prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, toolResourceKeys: registered.toolResourceKeys
    })

    const result = await runHostedAgentTurn({
      host: createHostedAgentTurnHost(deps), invocationId: deps.invocationId, turnId: deps.turnId, routeId: deps.routeId,
      request: { messages: [{ role: 'user', content: 'look up' }], maxTokens: 128, tools: [{ name: 'lookup_internal', description: 'lookup', inputSchema: { type: 'object' } }] }
    })

    expect(result.text).toBe('found')
    expect(gateNames).toEqual(['lookup.internal', 'lookup.internal'])
    expect(execute).toHaveBeenCalledOnce()
    expect(admission.executorEntries).toBe(1)
  })

  it('fails closed when a security-critical Hosted port is missing', () => {
    const deps = baseDependencies()
    expect(() => createHostedAgentTurnHost({ ...deps, history: undefined } as never)).toThrow('HOSTED_HISTORY_REQUIRED')
    expect(() => createHostedAgentTurnHost({ ...deps, safetyGate: undefined } as never)).toThrow('HOSTED_SAFETY_GATE_REQUIRED')
    expect(() => createHostedAgentTurnHost({ ...deps, toolExecution: undefined } as never)).toThrow('HOSTED_TOOL_EXECUTION_REQUIRED')
  })
})
