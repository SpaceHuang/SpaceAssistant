import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurnObserver } from '../../packages/agent-sdk/src/turn'
import { createAgentSdkDesktopObserver } from './agentSdkDesktopObserver'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { buildRequestHeaderPayload } from '../../src/shared/requestContext'
import { estimateTokensFromToolResults } from '../../src/shared/contextUsageEstimate'
import { projectRequestHeaderForWindow } from './requestHeaderProjection'
import { reduceAssistantFact, type AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import { buildAssistantActivityTimeline } from '../../src/shared/assistantActivityTimeline'
import type { Message } from '../../src/shared/domainTypes'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('createAgentSdkDesktopObserver', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('projects dispatch-stop, slot materialization, and failure attribution diagnostics', async () => {
    const events: unknown[] = []
    const diagnostics = vi.fn()
    const observer = createAgentSdkDesktopObserver({
      requestId: 'dispatch-diagnostic', sessionId: 's', turnId: 't',
      emitSessionEvent: (event) => { events.push(event) }, onDispatchDiagnostic: diagnostics
    })
    await (observer as AgentTurnObserver).onDispatchStoppedWithPending?.({
      modelTurn: 3, reason: 'ToolExecutionAfterDispatchError', attemptedCount: 2, undispatchedToolCallIds: ['c3', 'c4']
    })
    await (observer as AgentTurnObserver).onUndispatchedToolsMaterialized?.({ modelTurn: 3, count: 2 })
    await (observer as AgentTurnObserver).onToolDispatchFailureContext?.({
      modelTurn: 3, stepId: 'inv:turn:3', toolCallId: 'c2', toolName: 'edit_file', reasonCode: 'ToolExecutionAfterDispatchError',
      errorCode: 'ETIMEDOUT', executionOutcome: 'unknown-after-dispatch', executorEntry: 'entered', invocationDisposition: 'active'
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result', payload: expect.objectContaining({ diagnosticType: 'tools.dispatch_stopped_with_pending', reason: 'ToolExecutionAfterDispatchError', attemptedCount: 2, undispatchedToolCallIds: ['c3', 'c4'] })
    }))
    expect(diagnostics.mock.calls.map(([event]) => event.type)).toEqual([
      'tools.dispatch_stopped_with_pending', 'tools.undispatched_slots_materialized', 'tools.dispatch_failure_context'
    ])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', payload: expect.objectContaining({
      diagnosticType: 'tools.dispatch_failure_context', errorCode: 'ETIMEDOUT', executionOutcome: 'unknown-after-dispatch', executorEntry: 'entered', invocationDisposition: 'active'
    }) }))
  })
  it('accumulates each model request tool declaration into the persisted turn dimensions', async () => {
    let turnDimensions: unknown
    const observer = createAgentSdkDesktopObserver({
      requestId: 'tool-declaration-usage', sessionId: 's', turnId: 't',
      onTurnToolAttribution: (dimension) => { turnDimensions = dimension }
    })
    const request = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      maxTokens: 100,
      tools: [
        { name: 'grep', description: 'search workspace', inputSchema: { type: 'object' } },
        { name: 'mcp_docs_search', description: 'search docs', inputSchema: { type: 'object' } }
      ]
    }

    observer.prepareUsageAttribution?.({ modelTurn: 1, request })
    observer.prepareUsageAttribution?.({ modelTurn: 2, request })
    await observer.onTurnFinished?.({ text: '', messages: [], modelTurns: 2, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 0 } })

    expect(turnDimensions).toMatchObject({
      tools: { grep: expect.any(Number), mcp_docs_search: expect.any(Number) },
      toolSource: { builtin: expect.any(Number), mcp: expect.any(Number) },
      toolSources: { grep: 'builtin', mcp_docs_search: 'mcp' }
    })
    const dimensions = turnDimensions as { tools: Record<string, number>; toolSource: Record<string, number> }
    expect(dimensions.tools.grep).toBeGreaterThan(0)
    expect(dimensions.tools.mcp_docs_search).toBeGreaterThan(0)
    expect(dimensions.toolSource.builtin).toBeGreaterThan(0)
    expect(dimensions.toolSource.mcp).toBeGreaterThan(0)
  })

  it('writes request headers for the first and follow-up Hosted model turns', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'short')
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitSessionEvent, model: 'claude-test', contextWindow: 1000, windowId: 'projection-window' })
    const request = {
      messages: [
        { role: 'system' as const, content: 'system prompt' },
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'tool work' },
        { role: 'tool' as const, toolCallId: 'tc-1', content: 'result', isError: false }
      ],
      maxTokens: 200,
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }]
    }

    const requiredUserMessage = { id: 'user-1', message: { role: 'user' as const, content: 'hello' } }
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request, currentUserMessageId: requiredUserMessage.id, requiredUserMessage })
    expect(emitSessionEvent.mock.calls.map(([event]) => event.type)).toEqual(['request_header', 'request_context'])
    expect(emitSessionEvent.mock.calls[0]?.[0].payload).toMatchObject({
      requestId: 'r:round:1', requiredSurfaceSet: ['user-1'],
      cacheBreakpoints: { count: 2, positions: ['system', 'msg:2'], tailIsString: true, prevPositions: null, moved: false }
    })
    await observer.onModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request, currentUserMessageId: requiredUserMessage.id, requiredUserMessage })

    expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'request_header',
      payload: expect.objectContaining({
        requestId: 'r:round:2', system: undefined, requiredSurfaceSet: ['user-1'],
        toolExecutionCheckpoint: { completedToolUseIds: ['tc-1'], replayForbidden: false },
        tools: undefined
      })
    }))
    expect(emitSessionEvent.mock.calls[2]?.[0].payload).toMatchObject({
      requestId: 'r:round:2',
      cacheBreakpoints: { count: 2, positions: ['system', 'msg:2'], tailIsString: true, prevPositions: ['system', 'msg:2'], moved: false }
    })
    expect(emitSessionEvent.mock.calls.map(([event]) => event.type)).toEqual(['request_header', 'request_context', 'request_header', 'request_context'])
    expect(emitSessionEvent.mock.calls[3]?.[0].payload).toMatchObject({ requestId: 'r:round:2', model: 'claude-test', contextWindow: { tokens: 1000, source: 'config' } })
  })

  it('freezes one AGENTS.md snapshot for a logical request and reloads after the tool boundary', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'agents-md-observer-'))
    try {
      const filePath = path.join(workDir, 'AGENTS.md')
      await writeFile(filePath, 'instruction version one', 'utf8')
      const observer = createAgentSdkDesktopObserver({ requestId: 'agents-request', sessionId: 's', turnId: 't',
        getWorkDir: () => workDir, agentsMdEnabled: true, contextWindow: 100_000
      })
      const request = { messages: [{ role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'hello' }], maxTokens: 32 }
      const first = await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request })
      await writeFile(filePath, 'instruction version two', 'utf8')
      const retry = await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 2, routeId: 'route', request })
      const next = await observer.prepareModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request })
      const systemText = (projection: typeof first) => (projection?.requestPatch?.messages?.[0]?.content as string) ?? ''
      expect(systemText(first)).toContain('instruction version one')
      expect(systemText(retry)).toContain('instruction version one')
      expect(systemText(retry)).not.toContain('instruction version two')
      expect(systemText(next)).toContain('instruction version two')
      expect(first).toMatchObject({ requestMetadata: { agentsMdSnapshot: { status: 'loaded', byteLength: 23, content: 'instruction version one', source: 'AGENTS.md', scope: 'workdir-root', workDir } } })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('captures the workdir instruction at each actual provider request and keeps retries frozen', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'agents-md-provider-capture-'))
    const filePath = path.join(workDir, 'AGENTS.md')
    await writeFile(filePath, 'instruction A', 'utf8')
    try {
      const invocationId = 'agents-provider-capture'
      const route = { routeId: 'agents-capture', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }
      const registry = new ModelProviderRegistry()
      const captured: import('../../packages/agent-sdk/src/model').CanonicalModelMessage[][] = []
      let providerAttempts = 0
      registry.register(route, { providerId: invocationId, stream: async function* (call) {
        providerAttempts += 1
        captured.push(structuredClone([...call.request.messages]))
        if (providerAttempts === 1) throw new Error('temporary provider error')
        if (providerAttempts === 2) {
          yield { type: 'tool-call', toolCallId: 'capture-tool', toolName: 'lookup', input: {} }
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text-delta', text: 'done' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      } })
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, ['lookup'])
      const permits = new InMemorySafetyPermitStore()
      const binding = { requestId: invocationId, turnId: 'agents-turn', invocationId, toolCallId: 'capture-tool', capabilityId: 'lookup',
        inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth-v1' }
      const history = new MemoryHistory()
      const result = await runAgentTurn({
        registry, routeId: route.routeId, invocationId, history,
        request: { messages: [{ role: 'system', content: 'base prompt\n\n<project_memory>memory</project_memory>\n\n## Skills\nskill fragment' }, { role: 'user', content: 'hello' }], maxTokens: 100 },
        observer: createAgentSdkDesktopObserver({ requestId: invocationId, sessionId: 'session', turnId: 'agents-turn',
          getWorkDir: () => workDir, agentsMdEnabled: true, contextWindow: 100_000 }),
        recoverProviderAttempt: async ({ error, messages }) => error ? ({ kind: 'retry', reasonCode: 'TEMPORARY_PROVIDER_ERROR', messages }) : undefined,
        safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (value) => ({ kind: 'allow', authorizationVersion: value.authorizationVersion }) } }),
        prepareTool: async (call, stage) => ({ ...binding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName,
          phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
        toolExecution: createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
          resolveExpected: async (call) => ({ ...binding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
          execute: async () => ({ output: 'tool done' }) }),
        afterToolResult: async () => { await writeFile(filePath, 'instruction B', 'utf8') },
        recordProviderAttemptUsage: vi.fn(),
        maxModelTurns: 2
      })
      expect(result.modelTurns).toBe(2)
      const systems = captured.map((messages) => messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'))
      expect(systems.every((system) => system.includes('<project_memory>memory</project_memory>') && system.includes('skill fragment'))).toBe(true)
      expect(systems[0]).toContain('instruction A')
      expect(systems[1]).toContain('instruction A')
      expect(systems[2]).toContain('instruction B')
      expect(systems[1]).not.toContain('instruction B')
      expect(systems.map((system) => system.match(/<project_instructions /g)?.length ?? 0)).toEqual([1, 1, 1])
      const requestEvents = (await history.read(invocationId)).events.filter((event) => event.kind === 'model-request-started')
      expect(requestEvents.map((event) => (event.payload as { requestMetadata: { agentsMdSnapshot: { content?: string } } }).requestMetadata.agentsMdSnapshot.content))
        .toEqual(['instruction A', 'instruction A', 'instruction B'])
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('records no cache breakpoints when the provider cache retention is disabled', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'none')
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'cache-disabled', sessionId: 's', turnId: 't', emitSessionEvent })
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: {
      messages: [{ role: 'system', content: 'policy' }, { role: 'user', content: 'hello' }], maxTokens: 100, tools: []
    } })
    expect(emitSessionEvent.mock.calls[0]?.[0].payload).toMatchObject({
      cacheBreakpoints: { count: 0, positions: [], tailIsString: true, prevPositions: null, moved: false }
    })
  })

  it('shares header fingerprints with the legacy projection lane for the same window', async () => {
    const windowId = `shared-window-${Date.now()}`
    const first = createAgentSdkDesktopObserver({ requestId: 'hosted', sessionId: 's', turnId: 't', windowId })
    await first.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: {
      messages: [{ role: 'system', content: 'stable-system' }, { role: 'user', content: 'hello' }],
      maxTokens: 100, tools: []
    } })
    const legacyHeader = buildRequestHeaderPayload({
      requestId: 'legacy-followup', system: 'stable-system', tools: [], messages: [{ role: 'user', content: 'hello' }]
    })
    const projectedLegacyHeader = projectRequestHeaderForWindow(windowId, legacyHeader)
    expect(projectedLegacyHeader.system).toBeUndefined()
    expect(projectedLegacyHeader.tools).toBeUndefined()
  })

  it('uses request identity rather than session identity as the fallback cache domain', async () => {
    const firstEvents = vi.fn()
    const secondEvents = vi.fn()
    const request = { messages: [{ role: 'system' as const, content: 'stable-system' }, { role: 'user' as const, content: 'hello' }], maxTokens: 100, tools: [] }
    const first = createAgentSdkDesktopObserver({ requestId: `request-a-${Date.now()}`, sessionId: 'shared-session', turnId: 't-a', emitSessionEvent: firstEvents })
    const second = createAgentSdkDesktopObserver({ requestId: `request-b-${Date.now()}`, sessionId: 'shared-session', turnId: 't-b', emitSessionEvent: secondEvents })
    await first.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request })
    await second.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request })

    expect(firstEvents.mock.calls[0]?.[0].payload).toMatchObject({ system: 'stable-system' })
    expect(secondEvents.mock.calls[0]?.[0].payload).toMatchObject({ system: 'stable-system' })
  })

  it('stages Remote assistant chunks until the entire Hosted turn succeeds', async () => {
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'remote-staged-request', sessionId: 'remote-session', turnId: 'remote-turn',
      stageAssistantContentUntilTurnFinished: true, emitFactEvent: (event) => facts.push(event)
    })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelRequest' | 'onModelChunk' | 'onModelResponseCommitted' | 'onTurnOutputReady' | 'onTurnFinished'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [] } })
    await typed.onModelChunk({ type: 'text-delta', text: 'intermediate tool explanation' })
    await typed.onModelChunk({ type: 'thinking-delta', text: 'private reasoning' })
    await typed.onModelResponseCommitted({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 2, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate tool explanation' }], toolCalls: [{ id: 'tool-1', name: 'lookup', input: {} }] }
    })

    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-delta' }))
    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'thinking-delta' }))
    expect(facts).not.toContainEqual({ type: 'preview-commit' })
    await typed.onModelRequest({ modelTurn: 2, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [] } })
    await typed.onModelChunk({ type: 'text-delta', text: 'final answer' })
    await typed.onModelResponseCommitted({
      modelTurn: 2, finishReason: 'stop', usage: { type: 'usage', inputTokens: 2, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }
    })
    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-reconciled' }))
    expect(facts).toContainEqual({ type: 'tool-use', id: 'tool-1', toolName: 'lookup', input: {} })
    const result = { text: 'intermediate tool explanationfinal answer', messages: [], modelTurns: 2, finishReason: 'stop' as const, usage: { inputTokens: 3, outputTokens: 2 } }
    await typed.onTurnOutputReady(result)
    await typed.onTurnFinished(result)

    expect(facts).toEqual(expect.arrayContaining([
      { type: 'tool-use', id: 'tool-1', toolName: 'lookup', input: {} },
      { type: 'content-reconciled', text: 'intermediate tool explanationfinal answer' }
    ]))
  })

  it('does not project a required surface id without an exact canonical user-message binding', async () => {
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitSessionEvent })
    await observer.onModelRequest?.({
      modelTurn: 1, attempt: 1, routeId: 'route', currentUserMessageId: 'missing-user-id',
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [] }
    })
    expect(emitSessionEvent.mock.calls[0]?.[0].payload).toMatchObject({ requiredSurfaceSet: [] })
  })

  it('re-anchors the accepted response usage and final surface in the request context ledger', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't', model: 'claude-test', contextWindow: 1000,
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      emitFactEvent: (event) => facts.push(event)
    })
    await observer.onModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request: {
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      maxTokens: 100, tools: []
    } })
    await observer.onModelResponseCommitted?.({
      modelTurn: 2, finishReason: 'stop', usage: { type: 'usage', inputTokens: 80, outputTokens: 5, cacheReadInputTokens: 20 },
      message: { role: 'assistant', content: 'done' }
    })

    const contexts = events.filter((event) => event.type === 'request_context')
    expect(contexts).toHaveLength(2)
    expect(contexts[1]?.payload).toMatchObject({
      requestId: 'r:round:2',
      contextUsage: { pressureTokens: 100 },
      planningStatus: 'fits_without_headroom'
    })
    expect(facts.find((fact) => (fact as { type?: string }).type === 'context-projection-updated')).toMatchObject({ type: 'context-projection-updated', projection: { pressureTokens: 100, projectedTokens: expect.any(Number), anchorStatus: 'matched' } })
  })

  it('projects tool-result usage before the next Hosted request without changing provider-attempt usage', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'tool-projection', sessionId: 's', turnId: 't', model: 'claude-test', contextWindow: 100_000,
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      emitFactEvent: (event) => facts.push(event)
    })
    const requestOne = {
      messages: [{ role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'read file' }],
      maxTokens: 100, tools: [{ name: 'read_file', description: 'read file', inputSchema: { type: 'object' } }]
    }
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: requestOne })
    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1000, outputTokens: 50 },
      message: { role: 'assistant', toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }] }
    })
    const toolResultContent = 'file contents '.repeat(100)
    const requestTwo = {
      messages: [
        ...requestOne.messages,
        { role: 'assistant' as const, toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }] },
        { role: 'tool' as const, toolCallId: 'tool-1', content: toolResultContent, isError: false }
      ],
      maxTokens: 100, tools: requestOne.tools
    }

    await observer.onModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request: requestTwo })

    const projectedUsage = facts.find((fact) => (fact as { type?: string }).type === 'usage-updated' && (fact as { projected?: boolean }).projected)
    expect(projectedUsage).toMatchObject({ type: 'usage-updated', projected: true, usage: { input_tokens: expect.any(Number), output_tokens: 50 } })
    expect((projectedUsage as { usage: { input_tokens: number } }).usage.input_tokens)
      .toBe(1000 + estimateTokensFromToolResults([{ content: toolResultContent }]))
    const nextContext = events.find((event) => event.type === 'request_context' && event.payload.requestId === 'tool-projection:round:2')
    expect(nextContext?.payload).toMatchObject({
      contextUsage: { pressureTokens: expect.any(Number), projectedTokens: expect.any(Number), anchorStatus: 'matched' },
      phase: 'tool_loop', reason: 'proactive'
    })
    expect(events.find((event) => event.type === 'request_header' && event.payload.requestId === 'tool-projection:round:2')?.payload).toMatchObject({
      toolExecutionCheckpoint: { completedToolUseIds: ['tool-1'] }
    })
  })

  it('projects output-recovery retry and non-dispatched tool results before reconciling final text', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't',
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      emitFactEvent: (event) => facts.push(event)
    })
    const outputResult = { success: false, error: 'model_output_token_limit', userMessage: 'truncated tool was not dispatched', notExecuted: true, notExecutedReason: 'model_output_truncated' }
    const retryPayload = { turnId: 't', stepId: 'r', requestId: 'r:round:1', attempt: 1, backoffMs: 0, code: 'model_output_token_limit' }
    await observer.onOutputRecovery?.({ attempt: 1, modelTurn: 1, requestId: 'r:round:1', willRetry: true, toolCallErrorContent: 'truncated tool was not dispatched', sessionLedgerEvents: [
      { ...({ invocationId: 'r', turnId: 't', sequence: 1, schemaVersion: 1, eventId: 'e1', idempotencyKey: 'i1' }), kind: 'tool-call-not-dispatched', payload: { toolCallId: 'partial-tool', reason: 'MODEL_OUTPUT_TRUNCATED', sessionLedger: { location: { workDir: '/workspace', sessionId: 's', createdAt: 1 }, stepId: 'r', result: outputResult } } },
      { ...({ invocationId: 'r', turnId: 't', sequence: 2, schemaVersion: 1, eventId: 'e2', idempotencyKey: 'i2' }), kind: 'provider-retry-scheduled', payload: { requestId: retryPayload.requestId, sessionLedger: { location: { workDir: '/workspace', sessionId: 's', createdAt: 1 }, requestRetry: retryPayload } } }
    ], toolCalls: [
      { invocationId: 'r', toolCallId: 'partial-tool', toolName: 'write_file', input: { path: 'a.txt' } }
    ] })
    const result = { text: 'partial complete', messages: [], modelTurns: 2, finishReason: 'stop' as const, usage: { inputTokens: 2, outputTokens: 1 } }
    await observer.onTurnOutputReady?.(result)
    await observer.onTurnFinished?.(result)

    expect(events).toEqual([
      { type: 'tool_result', payload: { turnId: 't', stepId: 'r', toolUseId: 'partial-tool', result: outputResult, requestId: 'r', invocationRequestId: 'r' } },
      { type: 'request_retry', payload: { ...retryPayload, invocationRequestId: 'r' } }
    ])
    expect(facts).toContainEqual({ type: 'tool-result', id: 'partial-tool', result: expect.objectContaining({ notExecuted: true }) })
    expect(facts).toContainEqual({ type: 'content-reconciled', text: 'partial complete' })
  })

  it('prepares canonical provider retry ledger payload with exact session identity', async () => {
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't',
      sessionEventLocation: { workDir: '/workspace', sessionId: 's', createdAt: 123 }
    })
    await expect(observer.prepareProviderRetry?.({ attempt: 2, modelTurn: 3, routeId: 'route', requestId: 'r:round:3', code: 'provider_context_overflow' })).resolves.toEqual({
      location: { workDir: '/workspace', sessionId: 's', createdAt: 123 },
      requestRetry: { turnId: 't', stepId: 'r', requestId: 'r:round:3', attempt: 2, backoffMs: 0, code: 'provider_context_overflow' }
    })
  })

  it('projects accepted chunks and tool lifecycle into legacy session events and facts in source order', async () => {
    const order: string[] = []
    const projectedSessionEvents: Array<{ type: string; payload: Record<string, unknown> }> = []
    const diagnostics: Array<Readonly<Record<string, unknown>>> = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'request-1', sessionId: 'session-1', turnId: 'turn-1', assistantMessageId: 'assistant-1',
      emitSessionEvent: async (event) => { const normalized = event as { type: string; payload: Record<string, unknown> }; projectedSessionEvents.push(normalized); order.push(`session:${event.type}:${(event.payload as { toolUseId?: string }).toolUseId ?? ''}`) },
      onDispatchDiagnostic: (event) => { diagnostics.push(event) },
      emitFactEvent: (event) => { order.push(`fact:${event.type}:${'id' in event ? event.id : ''}`) }
    })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelChunk' | 'onModelResponseCommitted' | 'onToolStarted' | 'onToolFinished' | 'onTurnFinished'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } }] } })
    await typed.onModelChunk({ type: 'text-delta', text: 'hello' })
    await typed.onModelChunk({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: { query: 'q' } })
    await typed.onModelChunk({ type: 'usage', inputTokens: 2, outputTokens: 1 })
    await typed.onModelResponseCommitted({ modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 2, outputTokens: 1 }, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [{ id: 'tool-1', name: 'lookup', input: { query: 'q' } }] } })
    await typed.onToolStarted({ invocationId: 'request-1', toolCallId: 'tool-1', toolName: 'lookup', input: { query: 'q' } })
    await typed.onToolFinished({ invocationId: 'request-1', toolCallId: 'tool-1', toolName: 'lookup', input: { query: 'q' } }, {
      output: { rows: 1 }, executionOutcome: 'unknown-after-dispatch', executorEntry: 'entered',
      errorCode: 'TOOL_TIMEOUT', invocationDisposition: 'timed-out'
    })
    await typed.onTurnFinished({ text: 'hello', messages: [], modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } })

    expect(order).toEqual([
      'fact:content-delta:', 'fact:context-projection-updated:', 'session:request_context:',
      'session:assistant_chunk:', 'session:assistant_chunk:', 'session:assistant_chunk:',
      'session:assistant_chunk:', 'session:assistant_chunk:', 'session:assistant_chunk:', 'session:assistant_chunk:',
      'session:assistant_chunk:', 'session:tool_call:tool-1',
      'fact:tool-use:tool-1', 'fact:preview-commit:', 'session:tool_result:tool-1', 'fact:tool-result:tool-1'
    ])
    const sessionEvents = order.filter((entry) => entry.startsWith('session:'))
    expect(sessionEvents.slice(0, 10).map((entry) => entry.split(':')[1])).toEqual(['request_context', ...Array(8).fill('assistant_chunk'), 'tool_call'])
    expect(projectedSessionEvents[5]?.payload.delta).toEqual({ type: 'tool_call_delta', index: 1, partialJson: '' })
    expect(projectedSessionEvents[9]?.payload.args).toEqual({ query: 'q' })
    const toolResultEvent = projectedSessionEvents.find((event) => event.type === 'tool_result')
    expect(toolResultEvent?.payload.result).toMatchObject({
      executionOutcome: 'unknown-after-dispatch', executorEntry: 'entered',
      executionErrorCode: 'TOOL_TIMEOUT', invocationDisposition: 'timed-out'
    })
    expect(diagnostics.at(-1)).toMatchObject({ type: 'tools.execution_summary',
      proposalCount: 1, executorEntryCount: 1, knownFailureCount: 0, unknownOutcomeCount: 1, notDispatchedCount: 0 })
  })

  it('emits per-turn proposal, entry, outcome, and undispatched counts without tool inputs', async () => {
    const diagnostics: Array<Readonly<Record<string, unknown>>> = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'counts-request', sessionId: 'counts-session', turnId: 'counts-turn',
      onDispatchDiagnostic: (event) => { diagnostics.push(event) }
    })
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route',
      request: { messages: [{ role: 'user', content: 'query' }], maxTokens: 32, tools: [] } })
    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', toolCalls: [
        { id: 'count-unknown', name: 'lookup', input: { secret: 'private-input' } },
        { id: 'count-unstarted', name: 'lookup', input: { secret: 'private-input' } },
        { id: 'count-known-failure', name: 'lookup', input: { secret: 'private-input' } },
        { id: 'count-entry-unknown', name: 'lookup', input: { secret: 'private-input' } }
      ] }
    })
    await observer.onToolFinished?.({ invocationId: 'counts-request', toolCallId: 'count-unknown', toolName: 'lookup', input: { secret: 'private-input' } }, {
      output: 'unknown', isError: true, executionOutcome: 'unknown-after-dispatch', executorEntry: 'entered'
    })
    await observer.onToolNotDispatched?.({ invocationId: 'counts-request', toolCallId: 'count-unstarted', toolName: 'lookup', input: { secret: 'private-input' } }, 'TURN_STOPPED_BEFORE_DISPATCH')
    await observer.onToolFinished?.({ invocationId: 'counts-request', toolCallId: 'count-known-failure', toolName: 'lookup', input: { secret: 'private-input' } }, {
      output: { success: false, error: 'business failure' }, isError: true
    })
    await observer.onToolFinished?.({ invocationId: 'counts-request', toolCallId: 'count-entry-unknown', toolName: 'lookup', input: { secret: 'private-input' } }, {
      output: { success: false, executionOutcome: 'unknown-after-dispatch' }, isError: true,
      executionOutcome: 'unknown-after-dispatch', executorEntry: 'unknown'
    })
    await observer.onTurnFinished?.({ text: '', messages: [], modelTurns: 1, finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } })

    const summary = diagnostics.at(-1)
    expect(summary).toMatchObject({ type: 'tools.execution_summary', proposalCount: 4,
      executorEntryCount: 2, knownFailureCount: 1, unknownOutcomeCount: 2, notDispatchedCount: 1 })
    expect(JSON.stringify(summary)).not.toContain('private-input')
  })

  it('keeps text, tool, thinking, and later text in provider source order in the accepted activity timeline', async () => {
    const facts: AssistantFactEvent[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'ordered-response', sessionId: 'session-1', turnId: 'turn-1',
      emitFactEvent: (event) => facts.push(event)
    })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelChunk' | 'onModelResponseCommitted'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 100 } })
    await typed.onModelChunk({ type: 'text-delta', text: 'before' })
    await typed.onModelChunk({ type: 'tool-call', toolCallId: 'ordered-tool', toolName: 'lookup', input: { query: 'q' } })
    await typed.onModelChunk({ type: 'thinking-delta', text: 'reasoning' })
    await typed.onModelChunk({ type: 'text-delta', text: 'after' })
    await typed.onModelResponseCommitted({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 3, outputTokens: 2 },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'before' }, { type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'after' }],
        toolCalls: [{ id: 'ordered-tool', name: 'lookup', input: { query: 'q' } }]
      }
    })

    const initial: Message = { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 0, status: 'streaming', schemaVersion: 1 }
    const projected = facts.reduce((state, fact, index) => reduceAssistantFact(state, fact, { now: index + 1, createId: () => 'hint' }), initial)
    expect(buildAssistantActivityTimeline(projected).map((item) => item.kind)).toEqual(['text', 'tool', 'thinking', 'text'])
  })

  it('starts a new text segment when provider text resumes after a tool proposal', async () => {
    const facts: AssistantFactEvent[] = []
    const observer = createAgentSdkDesktopObserver({ requestId: 'ordered-text', sessionId: 'session-1', turnId: 'turn-1', emitFactEvent: (event) => facts.push(event) })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelChunk' | 'onModelResponseCommitted'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 100 } })
    await typed.onModelChunk({ type: 'text-delta', text: 'before' })
    await typed.onModelChunk({ type: 'tool-call', toolCallId: 'ordered-text-tool', toolName: 'lookup', input: { query: 'q' } })
    await typed.onModelChunk({ type: 'text-delta', text: 'after' })
    await typed.onModelResponseCommitted({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 3, outputTokens: 2 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }], toolCalls: [{ id: 'ordered-text-tool', name: 'lookup', input: { query: 'q' } }] }
    })
    const initial: Message = { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 0, status: 'streaming', schemaVersion: 1 }
    const projected = facts.reduce((state, fact, index) => reduceAssistantFact(state, fact, { now: index + 1, createId: () => 'hint' }), initial)
    expect(buildAssistantActivityTimeline(projected).map((item) => item.kind)).toEqual(['text', 'tool', 'text'])
    expect(projected.contentSegments?.map((segment) => segment.content)).toEqual(['before', 'after'])
  })

  it('rolls back a provisional preview and never commits tool facts after a failed turn', async () => {
    const emitFactEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitFactEvent })
    await observer.onModelChunk?.({ type: 'text-delta', text: 'partial' })
    await observer.onTurnFailed?.({ error: new Error('provider failed'), status: 'failed' })
    expect(emitFactEvent).toHaveBeenLastCalledWith({ type: 'preview-rollback' })
    expect(emitFactEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'preview-commit' }))
  })

  it('rolls back and clears provisional chunks from a discarded provider attempt before retry', async () => {
    const facts: unknown[] = []
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'retry-preview', sessionId: 's', turnId: 't',
      emitFactEvent: (event) => facts.push(event),
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> })
    })
    await observer.onModelChunk?.({ type: 'text-delta', text: 'discard this answer' })
    await observer.onModelAttemptDiscarded?.({ attempt: 1, modelTurn: 1, reasonCode: 'SILENT_CONTEXT_OVERFLOW' })
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 2, routeId: 'route', request: { messages: [], maxTokens: 10, tools: [] } })
    await observer.onModelChunk?.({ type: 'text-delta', text: 'keep this answer' })
    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'stop', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'keep this answer' }] }
    })

    expect(facts).toEqual(expect.arrayContaining([
      { type: 'preview-rollback' },
      expect.objectContaining({ type: 'content-delta', text: 'keep this answer' }),
      { type: 'preview-commit' }
    ]))
    expect(events.filter((event) => event.type === 'assistant_chunk').some((event) => JSON.stringify(event).includes('discard this answer'))).toBe(false)
    expect(facts.some((fact) => (fact as { type?: string }).type === 'content-delta' && (fact as { text?: string }).text === 'discard this answer')).toBe(true)
    expect(facts.findIndex((fact) => (fact as { type?: string }).type === 'preview-rollback'))
      .toBeGreaterThan(facts.findIndex((fact) => (fact as { type?: string }).text === 'discard this answer'))
  })

  it('does not re-project a host response whose session ledger and facts were already committed', async () => {
    const emitSessionEvent = vi.fn()
    const emitFactEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitSessionEvent, emitFactEvent })

    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'already projected' }], toolCalls: [{ id: 'already-tool', name: 'lookup', input: {} }] }, alreadyProjected: true
    })

    expect(emitSessionEvent).not.toHaveBeenCalled()
    expect(emitFactEvent).not.toHaveBeenCalled()
    await observer.onToolFinished?.({ invocationId: 'r', toolCallId: 'already-tool', toolName: 'lookup', input: {} }, { output: { success: true } })
    expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result', payload: expect.objectContaining({ toolUseId: 'already-tool', stepId: 'r:model:1' }) }))
  })

  it('projects executor ToolExecutorResult to the same fact shape as the legacy loop', async () => {
    const ordering: string[] = []
    const emitFactEvent = vi.fn((event) => { ordering.push(`fact:${event.type}`) })
    const notify = vi.fn(() => { ordering.push('notify') })
    const onFileTreeChanged = vi.fn(() => { ordering.push('file-tree') })
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't', emitFactEvent, notify, onFileTreeChanged,
      emitSessionEvent: async (event) => { ordering.push(`session:${event.type}`) }
    })
    await observer.onToolFinished?.(
      { invocationId: 'r', toolCallId: 'write-1', toolName: 'write_file', input: { path: 'a.txt' } },
      { output: { success: true, data: { path: 'a.txt', written: 3 } }, auditRef: 'audit:write-1' }
    )
    expect(emitFactEvent).toHaveBeenCalledWith({ type: 'tool-result', id: 'write-1', result: { success: true, data: { path: 'a.txt', written: 3 }, auditRef: 'audit:write-1' } })
    expect(notify).toHaveBeenCalledWith({ kind: 'tool-result', requestId: 'r', toolUseId: 'write-1' })
    expect(onFileTreeChanged).toHaveBeenCalledWith({ kind: 'paths', relPaths: ['a.txt'] })
    expect(ordering).toEqual(['session:tool_result', 'fact:tool-result', 'file-tree', 'notify'])
  })

  it('correlates Hosted tool results with the invocation request, turn, and lane', async () => {
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({
      requestId: 'trace-request', sessionId: 'trace-session', turnId: 'trace-turn', lane: 'feishu', emitSessionEvent
    } as never)

    await observer.onToolFinished?.(
      { invocationId: 'trace-request', toolCallId: 'trace-call', toolName: 'read_file', input: { path: 'a.txt' } },
      { output: { success: true, data: 'ok' } }
    )

    expect(emitSessionEvent).toHaveBeenCalledWith({
      type: 'tool_result',
      payload: expect.objectContaining({
        requestId: 'trace-request', turnId: 'trace-turn', lane: 'feishu', toolUseId: 'trace-call'
      })
    })
  })
})
