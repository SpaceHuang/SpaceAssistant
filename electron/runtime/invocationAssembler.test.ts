import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { markAgentSdkSafetyDecisionConfirmed } from '../confirmation/agentSdkSafetyPolicy'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { createAgentRuntime } from './agentRuntime'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './agentRuntimeDefaults'
import { assembleInvocation } from './invocationAssembler'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import type { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import type { McpConnectionManager } from '../mcp/mcpConnectionManager'
import { cancelToolConfirm, isPendingConfirm, submitToolConfirmResponse } from '../toolConfirmRegistry'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { SqliteDecisionCache } from '../confirmation/sqliteDecisionCache'
import { isBrowserSessionTrustedHost, resetBrowserSessionTrustForTests } from '../browser/browserSessionTrust'

describe('AcceptedTurn propagation', () => {
  it('carries the immutable accepted-turn snapshot into the runtime invocation', () => {
    const acceptedTurn = Object.freeze({
      turnId: 'accepted-turn', requestId: 'accepted-request', sessionId: 'accepted-session', lane: 'desktop' as const,
      startToken: 'accepted-start', currentUserMessageId: 'accepted-user', transcriptVersion: 4,
      config: Object.freeze({ lane: 'desktop' as const })
    })
    const { invocation } = assembleInvocation({
      requestId: acceptedTurn.requestId, sessionId: acceptedTurn.sessionId,
      acceptedTurn, model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    expect(invocation.acceptedTurn).toBe(acceptedTurn)
    expect(invocation.trace.turnId).toBe(acceptedTurn.turnId)
    expect(invocation.messages.currentUserMessageId).toBe(acceptedTurn.currentUserMessageId)
  })

  it('rejects an invocation whose current user message id conflicts with the accepted turn', () => {
    const acceptedTurn = Object.freeze({
      turnId: 'accepted-turn', requestId: 'accepted-request', sessionId: 'accepted-session', lane: 'desktop' as const,
      startToken: 'accepted-start', currentUserMessageId: 'accepted-user', transcriptVersion: 4,
      config: Object.freeze({ lane: 'desktop' as const })
    })

    expect(() => assembleInvocation({
      requestId: acceptedTurn.requestId, sessionId: acceptedTurn.sessionId,
      acceptedTurn, currentUserMessageId: 'different-user', model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })).toThrow('ACCEPTED_TURN_USER_MESSAGE_ID_MISMATCH')
  })
})

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

describe('assembleInvocation runtime tool revocation adapter', () => {
  let runtime: ReturnType<typeof createAgentRuntime>

  beforeEach(() => {
    resetDefaultAgentRuntimeForTests()
    const registeredTool = { name: 'probe-tool' }
    runtime = createAgentRuntime({
      toolRevocations: new ToolRevocationRegistry(),
      builtinRegistry: {
        getLegacyExecutor: () => undefined,
        get: (name) => name === 'probe-tool' ? registeredTool as never : undefined,
        entries: () => [registeredTool as never]
      }
    })
    setDefaultAgentRuntime(runtime)
  })

  afterEach(() => {
    resetDefaultAgentRuntimeForTests()
  })

  it('preserves registry methods and forwards revocation events to the runtime instance', () => {
    const { ports } = assembleInvocation({
      requestId: 'req-adapter',
      sessionId: 'session-adapter',
      model: 'test-model',
      locale: 'zh-CN',
      messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(),
      emitSessionEvent: vi.fn()
    })
    const adapter = ports.toolRevocations!
    const revoked = vi.fn()

    adapter.registerToolRevocationRequest('req-adapter', 'desktop', 'req-adapter')
    adapter.onRevocation(revoked)
    runtime.toolRevocations.revokeToolForLane('desktop', 'write_file')

    expect(adapter.isToolRevoked('req-adapter', 'write_file')).toBe(true)
    expect(revoked).toHaveBeenCalledWith({ requestId: 'req-adapter', executionId: 'req-adapter', lane: 'desktop', toolName: 'write_file' })
    expect(adapter.getRegisteredTool?.('probe-tool')).toBe(runtime.builtinRegistry.get('probe-tool'))
  })

  it('assembles the desktop SDK observer against the invocation fact and session sinks', async () => {
    const emitFactEvent = vi.fn()
    const emitSessionEvent = vi.fn()
    const { ports } = assembleInvocation({
      requestId: 'req-observer', sessionId: 'session-observer', turnId: 'turn-observer', assistantMessageId: 'assistant-observer',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent, emitSessionEvent
    })
    const observer = (ports as typeof ports & { observer: import('../../packages/agent-sdk/src/turn').AgentTurnObserver }).observer
    expect(observer.criticalModelResponseProjection).toBe(true)
    expect(observer.criticalModelAttemptUsageProjection).toBe(true)
    await observer.onModelChunk?.({ type: 'text-delta', text: 'accepted' })
    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'stop', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'accepted' }] }
    })
    expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant_chunk', payload: expect.objectContaining({
        requestId: 'req-observer', invocationRequestId: 'req-observer', turnId: 'turn-observer', lane: 'desktop',
        stepId: 'req-observer:model:1', messageId: 'assistant-observer'
      })
    }))
    expect(emitFactEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'content-delta', text: 'accepted' }))
  })

  it('stages assistant content in the observer for remote invocations', async () => {
    const emitFactEvent = vi.fn()
    const { ports } = assembleInvocation({
      requestId: 'req-remote-observer', sessionId: 'session-remote-observer', turnId: 'turn-remote-observer',
      model: 'test-model', locale: 'zh-CN', messages: [{ role: 'user', content: 'hello' }], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent, emitSessionEvent: vi.fn(),
      remoteContext: { source: 'feishu', messageId: 'im-message', confirmPolicy: 'always' }
    })
    await ports.observer.onModelChunk?.({ type: 'text-delta', text: 'not delivered until terminal' })

    expect(emitFactEvent).not.toHaveBeenCalled()
    await ports.observer.onTurnFailed?.({ error: new Error('provider failed'), status: 'failed' })
    expect(emitFactEvent).not.toHaveBeenCalled()
  })

  it('assembles Hosted SafetyPolicy gate args from current invocation policy, call input and current workspace', async () => {
    let currentWorkDir = '/workspace/initial'
    const supplement = vi.fn(() => ({ dangerAssessment: { dangerous: true, source: 'page-effect' as const, userReason: 'confirm', consequence: 'generic' as const, detail: 'test' } }))
    const { agentSdk } = assembleInvocation({
      requestId: 'req-hosted-gate', sessionId: 'session-hosted-gate', turnId: 'turn-hosted-gate',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/workspace/initial', resolveWorkDir: () => currentWorkDir, userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), resolveAgentSdkGateSupplement: supplement
    })
    currentWorkDir = '/workspace/active'
    const binding = {
      requestId: 'req-hosted-gate', turnId: 'turn-hosted-gate', invocationId: 'req-hosted-gate', toolCallId: 'tool-1',
      capabilityId: 'probe-tool', inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts',
      authorizationVersion: 'auth', phase: 'initial-compat' as const
    }
    const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: 'probe-tool', input: { value: 7 } }
    const args = await agentSdk.resolveGateArgs(binding, call)

    expect(args).toMatchObject({
      requestId: binding.requestId, toolUseId: binding.toolCallId, sessionId: 'session-hosted-gate',
      toolName: 'probe-tool', toolInput: { value: 7 }, workDir: '/workspace/active', userDataDir: '/tmp',
      dangerAssessment: { dangerous: true, detail: 'test' }
    })
    expect(Array.isArray(args.effectiveRules)).toBe(true)
    expect(args.decisionCache).toBeDefined()
    expect(args.shellPrecheck).toBeDefined()
    expect(supplement).toHaveBeenCalledWith({ binding, toolName: 'probe-tool', toolInput: { value: 7 } })
  })

  it('binds Hosted confirmation approval back to the exact SafetyPolicy tool call', async () => {
    const { agentSdk } = assembleInvocation({
      requestId: 'req-confirm-bind', sessionId: 'session-confirm-bind', turnId: 'turn-confirm-bind',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const markConfirmed = vi.fn()
    const policy = { evaluate: vi.fn(), markConfirmed }
    const channel = {
      request: vi.fn(async () => ({ kind: 'approved' as const, cause: 'user-approved' as const })),
      cancel: vi.fn()
    }
    const confirmation = agentSdk.createConfirmationPort(policy as never, {
      createChannel: () => channel as never,
      publish: vi.fn(),
      cancel: vi.fn()
    })
    const call = { invocationId: 'req-confirm-bind', toolCallId: 'tool-confirm-bind', toolName: 'read_file', input: { path: 'doc.md' } }

    await expect(confirmation({
      call, confirmationId: call.toolCallId, answerer: 'user', reasonCode: 'human',
      context: { facts: { toolName: 'read_file', actionClass: 'read', baseRiskLevel: 'medium', signals: [], summary: { text: 'read' } }, decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: null } }
    })).resolves.toMatchObject({ kind: 'approved' })

    expect(channel.request).toHaveBeenCalledOnce()
    expect(markConfirmed).toHaveBeenCalledWith(expect.objectContaining({ invocationId: call.invocationId, toolCallId: call.toolCallId }), 'user')
  })

  it('creates a route-bound Hosted host from invocation policy, runtime permits and canonical History', async () => {
    const { agentSdk } = assembleInvocation({
      requestId: 'req-host-factory', sessionId: 'session-host-factory', turnId: 'turn-host-factory',
      model: 'test-model', providerRouteId: 'hosted-route', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', agentSdkHistory: new MemoryHistory(),
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registeredTools = {
      prepareTool: vi.fn(), discardPreparedTool: vi.fn(), toolExecution: { execute: vi.fn() }, toolResourceKeys: vi.fn(() => []),
      getPreparedCall: vi.fn(), updateExecutionContext: vi.fn()
    }
    const registry = { get: vi.fn((name: string) => name === 'probe-tool' ? { name } : undefined), entries: vi.fn(() => [{ name: 'probe-tool' }]) }
    const policy = { evaluate: vi.fn(async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const })) }
    const providerRegistry = runtime.modelProviders as ModelProviderRegistry
    providerRegistry.register({ routeId: 'hosted-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'host-factory-test', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const host = agentSdk.createHostedTurnHost({ registeredTools: registeredTools as never, registry: registry as never, authorizedToolNames: new Set(['probe-tool']), policy: policy as never })
    const ports = await host.createPorts({ invocationId: 'turn-host-factory', turnId: 'turn-host-factory', routeId: 'hosted-route', request: { messages: [], maxTokens: 10, tools: [{ name: 'probe-tool', description: 'probe', inputSchema: {} }] } })

    expect(ports).toMatchObject({ invocationId: 'turn-host-factory', turnId: 'turn-host-factory', routeId: 'hosted-route', history: expect.any(Object), registry: runtime.modelProviders, observer: expect.any(Object) })
    expect(ports.prepareTool).toBe(registeredTools.prepareTool)
    expect(ports.discardPreparedTool).toBe(registeredTools.discardPreparedTool)
    expect(ports.toolExecution).toBe(registeredTools.toolExecution)
    expect(ports.maxConcurrentTools).toBe(runtime.toolExecutionConcurrency)
    await expect(ports.safetyGate.evaluate({ requestId: 'req-host-factory', turnId: 'turn-host-factory', invocationId: 'turn-host-factory', toolCallId: 'call', capabilityId: 'missing', inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'UNKNOWN_CAPABILITY' })
    await expect(ports.safetyGate.evaluate({ requestId: 'req-host-factory', turnId: 'turn-host-factory', invocationId: 'turn-host-factory', toolCallId: 'call', capabilityId: 'probe-tool', inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    expect(policy.evaluate).toHaveBeenCalledOnce()
  })

  it('creates an invocation-bound RegisteredTool adapter using runtime permit/admission and policy version ports', async () => {
    const { agentSdk } = assembleInvocation({
      requestId: 'req-registered-factory', sessionId: 'session-registered-factory', turnId: 'turn-registered-factory',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/workspace/start', resolveWorkDir: () => '/workspace/current', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'probe-tool', parseInput: (raw) => raw as { value: string }, plan: async (input) => input, execute: vi.fn(async () => ({ success: true })) }))
    const createExecutionContext = vi.fn((call) => ({ workDir: '/workspace/start', requestId: call.invocationId, signal: call.signal }))
    const refreshExecutionContext = vi.fn(() => ({ workDir: '/workspace/current', requestId: 'req-registered-factory' }))
    const registered = agentSdk.createRegisteredTools({ registry, createExecutionContext, refreshExecutionContext })
    const call = { invocationId: 'req-registered-factory', toolCallId: 'prepared-probe', toolName: 'probe-tool', input: { value: 'one' } }

    const binding = await registered.prepareTool(call, { kind: 'initial' })
    expect(binding).toMatchObject({ requestId: call.invocationId, turnId: 'turn-registered-factory', capabilityId: 'probe-tool', phase: 'initial-compat' })
    expect(binding.authorizationVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(createExecutionContext).toHaveBeenCalledWith(call)
    expect(registered.getPreparedCall(call)).toMatchObject(call)
    const recheck = await registered.prepareTool(call, { kind: 'recheck', confirmation: { receipt: 'approved' } })
    expect(recheck).toMatchObject({ phase: 'recheck', authorizationVersion: binding.authorizationVersion })
    expect(refreshExecutionContext).toHaveBeenCalledWith(call, { kind: 'recheck', confirmation: { receipt: 'approved' } }, expect.objectContaining({ workDir: '/workspace/current' }))
    registered.discardPreparedTool(call)
  })

  it('provides builtin-safe execution context defaults with dynamic workspace, cached files, lane and progress facts', async () => {
    let workDir = '/workspace/first'
    let browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: false }
    let plannedContext: Record<string, unknown> | undefined
    let validatedContext: Record<string, unknown> | undefined
    const { agentSdk } = assembleInvocation({
      requestId: 'req-context-defaults', sessionId: 'session-context-defaults', turnId: 'turn-context-defaults',
      model: 'test-model', lane: 'desktop', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      browserConfig, resolveBrowserConfig: () => browserConfig, shellConfig: {} as never, wikiConfig: {} as never,
      workDir, resolveWorkDir: () => workDir, userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'probe-tool', parseInput: (raw) => raw as { value: string }, plan: async (input, context) => {
      plannedContext = context.executionContext as Record<string, unknown>
      return input
    }, validate: (_plan, context) => { validatedContext = context.runtimeContext as Record<string, unknown> }, execute: async () => ({ success: true }) }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const call = { invocationId: 'req-context-defaults', toolCallId: 'probe-call', toolName: 'probe-tool', input: { value: 'ok' } }
    await registered.prepareTool(call, { kind: 'initial' })
    expect(plannedContext).toMatchObject({
      workDir: '/workspace/first', userDataDir: '/tmp', requestId: call.invocationId, toolUseId: call.toolCallId,
      sessionId: 'session-context-defaults', toolsConfig: DEFAULT_TOOLS_CONFIG, lane: 'desktop', requestLocale: 'zh-CN', toolUserConfirmed: false
    })
    expect(plannedContext?.fileStateCache).toBeDefined()
    expect(plannedContext?.signal).toBeInstanceOf(AbortSignal)
    workDir = '/workspace/current'
    browserConfig = { ...browserConfig, allowRemoteSessions: true }
    const gateArgs = await agentSdk.resolveGateArgs({
      requestId: call.invocationId, turnId: 'turn-context-defaults', invocationId: call.invocationId,
      toolCallId: call.toolCallId, capabilityId: call.toolName, inputSnapshotHash: 'input',
      planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'authorization', phase: 'recheck'
    }, call)
    expect(gateArgs.browserConfig).toEqual(browserConfig)
    await registered.prepareTool(call, { kind: 'recheck', confirmation: { receipt: 'approved' } })
    expect(validatedContext).toMatchObject({ workDir: '/workspace/current', browserConfig, toolUserConfirmed: true })
    expect(registered.getPreparedCall(call)).toMatchObject(call)
    registered.discardPreparedTool(call)
  })

  it.each(['write_file', 'edit_file'] as const)('rechecks an assembled Hosted %s against the current target identity before dispatch', async (toolName) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-sdk-assembled-${toolName}-target-`))
    const targetPath = path.join(workDir, 'approved.txt')
    await fs.writeFile(targetPath, 'original content')
    const input = toolName === 'edit_file'
      ? { path: 'approved.txt', old_string: 'original content', new_string: 'changed content' }
      : { path: 'approved.txt', content: 'changed content' }
    const assembled = assembleInvocation({
      requestId: 'assembled-edit-request', turnId: 'assembled-edit-turn', sessionId: 'assembled-edit-session', model: 'test-model', lane: 'desktop',
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 1, autoApproveMaxEditChars: 1 }, workDir, userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: toolName, parseInput: (raw) => raw as typeof input, plan: async (value) => value, execute: async () => ({ success: true }) }))
    const registered = assembled.agentSdk.createRegisteredTools({ registry })
    const policy = assembled.agentSdk.createSafetyPolicy(registered, (name) => name)
    const call = { invocationId: 'assembled-edit-request', toolCallId: `assembled-${toolName}-call`, toolName, input }
    try {
      const initialBinding = await registered.prepareTool(call, { kind: 'initial' })
      const capabilities = new CapabilityRegistry()
      capabilities.define(call.invocationId, [toolName])
      const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
      await expect(safetyGate.evaluate(initialBinding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'default-write-execute-ask' })
      markAgentSdkSafetyDecisionConfirmed(policy, initialBinding)
      await fs.rename(targetPath, `${targetPath}.approved`)
      await fs.writeFile(targetPath, 'replacement content')
      const recheckBinding = await registered.prepareTool(call, { kind: 'recheck', confirmation: { receipt: 'approved' } })
      await expect(safetyGate.evaluate(recheckBinding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'FACTS_CHANGED' })
      registered.discardPreparedTool(call)
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('replacement content')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('creates one composed Hosted runtime whose confirmation, policy and RegisteredTools share invocation identity', async () => {
    const requestId = 'req-hosted-runtime-composition'
    const turnId = 'turn-hosted-runtime-composition'
    const routeId = 'route-hosted-runtime-composition'
    ;(runtime.modelProviders as ModelProviderRegistry).register({ routeId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'host-runtime-composition', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'probe-tool', parseInput: (raw) => raw as { value: string }, plan: async (value) => value, execute: async () => ({ success: true }) }))
    const { agentSdk } = assembleInvocation({
      requestId, sessionId: 'session-hosted-runtime-composition', turnId, model: 'test-model', providerRouteId: routeId,
      locale: 'zh-CN', messages: [{ role: 'user', content: 'run probe' }], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', agentSdkHistory: new MemoryHistory(),
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const applicationAdmission = { park: vi.fn(() => 'parked'), resume: vi.fn(async () => true) }
    const deadlineAt = Date.now() + 10_000
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['probe-tool']), applicationAdmission, deadlineAt })
    const ports = await composed.host.createPorts({
      invocationId: turnId, turnId, routeId,
      request: { messages: [{ role: 'user', content: 'run probe' }], maxTokens: 10, tools: [{ name: 'probe-tool', description: 'probe', inputSchema: {} }] }
    })

    expect(ports).toMatchObject({ invocationId: turnId, turnId, routeId, confirmation: composed.confirmation, observer: expect.any(Object) })
    // FR12②：ports.prepareTool 是注册表 prepareTool 的结构化拒绝包装（共享同一 prepared 状态机，行为透传）
    expect(typeof ports.prepareTool).toBe('function')
    const binding = await ports.prepareTool!({ invocationId: turnId, toolCallId: 'probe-identity', toolName: 'probe-tool', input: { value: 1 } } as never, { kind: 'initial' })
    expect(binding).toMatchObject({ capabilityId: 'probe-tool' })
    expect(ports.toolExecution).toBe(composed.registeredTools.toolExecution)
    expect(ports.isApprovalCandidate).toBe(composed.registeredTools.isApprovalCandidate)
    expect(ports.applicationAdmission).toBe(applicationAdmission)
    expect(ports.deadlineAt).toBe(deadlineAt)
    expect(ports.isApprovalCandidate?.({ invocationId: requestId, toolCallId: 'probe', toolName: 'probe-tool', input: {} })).toBe(false)
  })

  it('binds the assembler MCP snapshot into the Hosted RegisteredTool registry', async () => {
    const requestId = 'req-hosted-mcp-assembler'
    const routeId = 'route-hosted-mcp-assembler'
    ;(runtime.modelProviders as ModelProviderRegistry).register({ routeId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'host-mcp-assembler', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const executor = { name: 'mcp_docs_search', execute: vi.fn(async () => ({ success: true })) }
    const resolveExecutor = vi.fn((name: string, _manager: McpConnectionManager) => name === executor.name ? executor : undefined)
    const { agentSdk, ports } = assembleInvocation({
      requestId, sessionId: 'session-hosted-mcp-assembler', turnId: 'turn-hosted-mcp-assembler', model: 'test-model', providerRouteId: routeId,
      locale: 'zh-CN', messages: [{ role: 'user', content: 'search' }], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', agentSdkHistory: new MemoryHistory(), emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    ports.mcp = {
      snapshot: {
        entries: new Map([['mcp_docs_search', { mappedName: 'mcp_docs_search', serverId: 'docs', serverName: 'Docs', originalName: 'search', description: 'Search', inputSchema: { type: 'object' } }]]),
        budgetDropped: []
      },
      resolveExecutor
    }

    const composed = agentSdk.createHostedTurnRuntime({ authorizedToolNames: new Set(['mcp_docs_search']) })
    const call = { invocationId: requestId, toolCallId: 'mcp-call', toolName: 'mcp_docs_search', input: { query: 'plan' } }
    const binding = await composed.registeredTools.prepareTool(call, { kind: 'initial' })
    expect(binding).toMatchObject({ requestId, toolCallId: call.toolCallId, capabilityId: 'mcp_docs_search' })
    expect(resolveExecutor).toHaveBeenCalledOnce()
    expect(resolveExecutor.mock.calls[0]?.[0]).toBe('mcp_docs_search')
    expect(resolveExecutor.mock.calls[0]?.[1]).toBeInstanceOf(Object)
    composed.registeredTools.discardPreparedTool(call)
    await composed.dispose()
  })

  it('preserves the caller confirmation cancellation adapter in the composed Hosted runtime', async () => {
    const requestId = 'req-hosted-runtime-cancel'
    const routeId = 'route-hosted-runtime-cancel'
    ;(runtime.modelProviders as ModelProviderRegistry).register({ routeId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'host-runtime-cancel', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const cancel = vi.fn()
    const channelCancel = vi.fn()
    const { agentSdk } = assembleInvocation({
      requestId, sessionId: 'session-hosted-runtime-cancel', turnId: 'turn-hosted-runtime-cancel', model: 'test-model', providerRouteId: routeId,
      locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: new MemoryHistory(), emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const composed = agentSdk.createHostedTurnRuntime({ registry: new TypedToolRegistry(), authorizedToolNames: new Set(), confirmationAdapter: {
      cancel,
      createChannel: () => ({ request: vi.fn(), cancel: channelCancel }),
      publish: vi.fn()
    } })
    const signal = new AbortController()
    signal.abort()
    await composed.confirmation({
      call: { invocationId: requestId, toolCallId: 'confirm-cancel', toolName: 'write_file', input: { path: 'a.txt' } },
      confirmationId: 'confirm-cancel', answerer: 'user', reasonCode: 'confirm', signal: signal.signal,
      context: {
        facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'user' }
      }
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(channelCancel).toHaveBeenCalledWith('confirm-cancel', 'cancelled')
  })

  it('uses the production confirmation channel and publish adapter by default for Hosted turns', async () => {
    const requestId = 'req-hosted-runtime-confirm-default'
    const routeId = 'route-hosted-runtime-confirm-default'
    ;(runtime.modelProviders as ModelProviderRegistry).register({ routeId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'host-runtime-confirm-default', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const onConfirmRequest = vi.fn()
    const manager = { onConfirmRequest, onToolResult: vi.fn(), onAllCancelledForRequest: vi.fn() }
    const emitFactEvent = vi.fn()
    const { agentSdk } = assembleInvocation({
      requestId, sessionId: 'session-hosted-runtime-confirm-default', turnId: 'turn-hosted-runtime-confirm-default', model: 'test-model', providerRouteId: routeId,
      lane: 'desktop', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: new MemoryHistory(), floatingNotificationManager: manager as never, emitFactEvent, emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', parseInput: (raw) => raw as { path: string }, plan: async (input) => input, execute: async () => ({ success: true }) }))
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['write_file']) })
    const call = { invocationId: requestId, toolCallId: 'confirm-default-call', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } }
    const binding = await composed.registeredTools.prepareTool(call, { kind: 'initial' })
    await composed.confirmation({
      call, confirmationId: call.toolCallId, answerer: 'user', reasonCode: 'confirm', signal: new AbortController().signal,
      context: { facts: { toolName: call.toolName, actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'user' } }
    })

    expect(binding.capabilityId).toBe('write_file')
    expect(onConfirmRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId, sessionId: 'session-hosted-runtime-confirm-default', toolUseId: call.toolCallId, toolName: 'write_file' }))
    expect(emitFactEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm-requested', id: call.toolCallId, requestId,
      turnId: 'turn-hosted-runtime-confirm-default', lane: 'desktop'
    }))
    await composed.dispose()
  })

  it('uses the runtime typed builtin registry by default so production composition cannot drift registries', async () => {
    const { agentSdk } = assembleInvocation({
      requestId: 'req-host-runtime-registry', sessionId: 'session-host-runtime-registry', turnId: 'turn-host-runtime-registry',
      model: 'test-model', providerRouteId: 'runtime-registry-route', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', agentSdkHistory: new MemoryHistory(),
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    ;(runtime.modelProviders as ModelProviderRegistry).register({ routeId: 'runtime-registry-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'host-factory-test', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const policy = { evaluate: vi.fn(async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const })) }
    const host = agentSdk.createHostedTurnHost({
      registeredTools: { prepareTool: vi.fn(), discardPreparedTool: vi.fn(), toolExecution: { execute: vi.fn() }, toolResourceKeys: vi.fn(() => []), getPreparedCall: vi.fn(), updateExecutionContext: vi.fn() } as never,
      authorizedToolNames: new Set(['probe-tool']),
      policy: policy as never
    } as never)
    const ports = await host.createPorts({ invocationId: 'turn-host-runtime-registry', turnId: 'turn-host-runtime-registry', routeId: 'runtime-registry-route', request: { messages: [], maxTokens: 10, tools: [{ name: 'probe-tool', description: 'probe', inputSchema: {} }] } })

    await expect(ports.safetyGate.evaluate({ requestId: 'req-host-runtime-registry', turnId: 'turn-host-runtime-registry', invocationId: 'turn-host-runtime-registry', toolCallId: 'call', capabilityId: 'probe-tool', inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    expect(policy.evaluate).toHaveBeenCalledOnce()
    expect(runtime.builtinRegistry.get('probe-tool')).toBeDefined()
  })

  it('fails closed when Hosted host composition lacks a provider route or canonical History', () => {
    const base = { requestId: 'req-host-factory-fail', sessionId: 'session-host-factory-fail', model: 'test-model', locale: 'zh-CN' as const,
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() }
    const args = { registeredTools: {} as never, registry: {} as never, policy: {} as never }
    expect(() => assembleInvocation(base).agentSdk.createHostedTurnHost(args)).toThrow('HOSTED_PROVIDER_ROUTE_REQUIRED')
    expect(() => assembleInvocation({ ...base, providerRouteId: 'route-without-db' }).agentSdk.createHostedTurnHost(args)).toThrow('HOSTED_HISTORY_REQUIRED')
  })

  it('projects Hosted confirmation requests into the existing Desktop fact and floating notification sinks', async () => {
    const emitFactEvent = vi.fn()
    const onConfirmRequest = vi.fn()
    const { agentSdk } = assembleInvocation({
      requestId: 'req-confirm-projection', sessionId: 'session-confirm-projection',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent, emitSessionEvent: vi.fn(),
      floatingNotificationManager: { onConfirmRequest } as never
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, {
      createChannel: () => ({ request: async () => ({ kind: 'approved' as const, cause: 'user-approved' as const }), cancel: vi.fn() }),
      cancel: vi.fn()
    })
    const call = { invocationId: 'req-confirm-projection', toolCallId: 'confirm-1', toolName: 'browser', input: { action: 'act' } }

    await confirmation({
      call, confirmationId: call.toolCallId, answerer: 'user', reasonCode: 'browser-danger',
      context: {
        facts: { toolName: 'browser', actionClass: 'write', baseRiskLevel: 'high', signals: [], summary: { text: 'browser action' } },
        decision: { riskLevel: 'high', memoryTiers: [], timeoutMs: 1000, answerer: 'user' },
        currentPageUrl: 'https://example.test/account',
        dangerAssessment: { dangerous: true, source: 'page-effect', userReason: 'submit form', consequence: 'account' }
      }
    })

    expect(emitFactEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm-requested', id: 'confirm-1', confirmId: 'confirm-1', riskLevel: 'high',
      currentPageUrl: 'https://example.test/account',
      dangerInfo: { userReason: 'submit form', consequence: 'account', source: 'page-effect' }
    }))
    expect(onConfirmRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-confirm-projection', sessionId: 'session-confirm-projection', toolUseId: 'confirm-1',
      toolName: 'browser', input: { action: 'act' }
    }))
  })

  it('routes Hosted remote confirmation through the invocation-bound IM channel without a Desktop notification', async () => {
    const inbound = { id: 'inbound-1' }
    const imRequest = vi.fn(async () => ({ kind: 'approved' as const, cause: 'user-approved' as const }))
    const cancelByRequestId = vi.fn()
    const onConfirmRequest = vi.fn()
    const remoteContext = {
      source: 'feishu', messageId: 'message-1', chatId: 'chat-1', userId: 'user-1', inboundRaw: inbound,
      authOwner: 'owner-1', authorizationGeneration: 7, imChannel: { request: imRequest, cancelByRequestId }
    }
    const { agentSdk } = assembleInvocation({
      requestId: 'req-remote-confirm', sessionId: 'session-remote-confirm', lane: 'feishu', remoteContext: remoteContext as never,
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      floatingNotificationManager: { onConfirmRequest } as never
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, { cancel: vi.fn() })
    await confirmation({
      call: { invocationId: 'req-remote-confirm', toolCallId: 'remote-1', toolName: 'write_file', input: { path: 'x' } },
      confirmationId: 'remote-1', answerer: 'user', reasonCode: 'confirm',
      context: { facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } }, decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'user' } }
    })

    expect(imRequest).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.any(Object) }), expect.objectContaining({
      requestId: 'req-remote-confirm', sessionId: 'session-remote-confirm', toolName: 'write_file', toolInput: { path: 'x' },
      messageId: 'message-1', matchKey: 'chat-1', context: 'chat-1', authOwner: 'owner-1', authorizationGeneration: 7
    }))
    expect(onConfirmRequest).not.toHaveBeenCalled()
  })

  it('passes Hosted agent answerer decisions to the injected AgentChannel factory', async () => {
    const { agentSdk } = assembleInvocation({
      requestId: 'req-agent-confirm', sessionId: 'session-agent-confirm', turnId: 'turn-agent-confirm', model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const requestChannel = { request: vi.fn(async () => ({ kind: 'approved' as const, cause: 'agent-approved' as const })), cancel: vi.fn() }
    const agentChannelFactory = vi.fn(() => requestChannel)
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, { cancel: vi.fn(), agentChannelFactory: agentChannelFactory as never })
    await confirmation({
      call: { invocationId: 'req-agent-confirm', toolCallId: 'agent-1', toolName: 'write_file', input: { path: 'x' } },
      confirmationId: 'agent-1', answerer: 'agent', reasonCode: 'auto-approval',
      context: { facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } }, decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'agent' } }
    })

    expect(agentChannelFactory).toHaveBeenCalledWith(expect.objectContaining({
      lane: 'desktop', requestId: 'req-agent-confirm', turnId: 'turn-agent-confirm', sessionId: 'session-agent-confirm', toolName: 'write_file',
      policy: { kind: 'agent' }
    }))
    expect(requestChannel.request).toHaveBeenCalledOnce()
  })

  it('falls back from an unavailable Hosted agent answerer to the existing Desktop confirmation card', async () => {
    const requestId = 'req-hosted-agent-fallback'
    const toolCallId = 'hosted-agent-fallback-call'
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-agent-fallback-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'before', 'utf8')
    const recordAudit = vi.spyOn(runtime.audit, 'record')
    const emitFactEvent = vi.fn()
    const onConfirmRequest = vi.fn()
    const { agentSdk } = assembleInvocation({
      requestId, sessionId: 'session-hosted-agent-fallback', model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir, userDataDir: workDir, getApiKey: async () => 'key',
      emitFactEvent, emitSessionEvent: vi.fn(), floatingNotificationManager: { onConfirmRequest } as never
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, {
      cancel: vi.fn(),
      agentChannelFactory: () => ({
        request: async () => ({ kind: 'rejected', cause: 'unavailable', answererKind: 'agent' }),
        cancel: vi.fn()
      }) as never
    })
    const pending = confirmation({
      call: { invocationId: requestId, toolCallId, toolName: 'write_file', input: { path: 'note.txt', content: 'after' } },
      confirmationId: toolCallId, answerer: 'agent', reasonCode: 'agent-approval',
      context: {
        facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'agent' }
      }
    })

    try {
      await vi.waitFor(() => expect(isPendingConfirm(requestId, toolCallId, 'session-hosted-agent-fallback')).toBe(true))
      expect(submitToolConfirmResponse(requestId, toolCallId, true, 'session-hosted-agent-fallback').accepted).toBe(true)
      await expect(pending).resolves.toMatchObject({ kind: 'approved', answerer: 'user', cause: 'user-approved' })
      expect(emitFactEvent).toHaveBeenCalledTimes(2)
      expect(emitFactEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'confirm-requested', id: toolCallId, autoAnswerer: false,
        autoApproveFallback: { reasonCode: 'approval_unavailable', reason: '服务暂不可用' },
        confirmDiff: { oldPath: 'note.txt', oldContent: 'before', newContent: 'after' }
      }))
      expect(onConfirmRequest).toHaveBeenCalledOnce()
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
        event: 'confirm.answerer-fallback-to-user', lane: 'desktop', requestId,
        sessionId: 'session-hosted-agent-fallback', toolName: 'write_file', cause: 'unavailable', actor: 'system'
      }))
    } finally {
      if (isPendingConfirm(requestId, toolCallId, 'session-hosted-agent-fallback')) submitToolConfirmResponse(requestId, toolCallId, false, 'session-hosted-agent-fallback')
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('cancels only the Hosted fallback confirmation waiter when the turn signal aborts', async () => {
    const requestId = 'req-hosted-agent-fallback-cancel'
    const toolCallId = 'hosted-agent-fallback-cancel-call'
    const { agentSdk } = assembleInvocation({
      requestId, sessionId: 'session-hosted-agent-fallback-cancel', model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, {
      cancel: (call) => { cancelToolConfirm(requestId, call.toolCallId, 'session-hosted-agent-fallback-cancel') },
      agentChannelFactory: () => ({
        request: async () => ({ kind: 'rejected', cause: 'unavailable', answererKind: 'agent' }),
        cancel: vi.fn()
      }) as never
    })
    const controller = new AbortController()
    const pending = confirmation({
      call: { invocationId: requestId, toolCallId, toolName: 'write_file', input: { path: 'note.txt', content: 'change' } },
      confirmationId: toolCallId, answerer: 'agent', reasonCode: 'agent-approval', signal: controller.signal,
      context: {
        facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'agent' }
      }
    })

    await vi.waitFor(() => expect(isPendingConfirm(requestId, toolCallId, 'session-hosted-agent-fallback-cancel')).toBe(true))
    controller.abort()
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', cause: 'cancelled' })
    expect(isPendingConfirm(requestId, toolCallId, 'session-hosted-agent-fallback-cancel')).toBe(false)
  })

  it('keeps a user rejection on the Hosted fallback attributed to user-denied', async () => {
    const requestId = 'req-hosted-agent-fallback-denied'
    const toolCallId = 'hosted-agent-fallback-denied-call'
    const { agentSdk } = assembleInvocation({
      requestId, sessionId: 'session-hosted-agent-fallback-denied', model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, {
      cancel: (call) => { cancelToolConfirm(requestId, call.toolCallId, 'session-hosted-agent-fallback-denied') },
      agentChannelFactory: () => ({
        request: async () => ({ kind: 'rejected', cause: 'unavailable', answererKind: 'agent' }),
        cancel: vi.fn()
      }) as never
    })
    const pending = confirmation({
      call: { invocationId: requestId, toolCallId, toolName: 'write_file', input: { path: 'note.txt', content: 'change' } },
      confirmationId: toolCallId, answerer: 'agent', reasonCode: 'agent-approval',
      context: {
        facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'agent' }
      }
    })

    try {
      await vi.waitFor(() => expect(isPendingConfirm(requestId, toolCallId, 'session-hosted-agent-fallback-denied')).toBe(true))
      expect(submitToolConfirmResponse(requestId, toolCallId, false, 'session-hosted-agent-fallback-denied').accepted).toBe(true)
      await expect(pending).resolves.toMatchObject({ kind: 'denied', answerer: 'user', cause: 'user-denied' })
    } finally {
      if (isPendingConfirm(requestId, toolCallId, 'session-hosted-agent-fallback-denied')) cancelToolConfirm(requestId, toolCallId, 'session-hosted-agent-fallback-denied')
    }
  })

  it('persists session trust only when a user approves a Hosted browser navigation fallback', async () => {
    const requestId = 'req-hosted-browser-fallback-trust'
    const toolCallId = 'hosted-browser-fallback-trust-call'
    const sessionId = 'session-hosted-browser-fallback-trust'
    const db = createMemoryAppDb('zh-CN')
    const key = { kind: 'domain' as const, domain: 'example.com', level: 'domain-any-action' as const, sessionId }
    const { agentSdk } = assembleInvocation({
      requestId, sessionId, model: 'test-model', locale: 'zh-CN', lane: 'desktop',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, navigateRequiresConfirm: true },
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', appDb: db,
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'browser', parseInput: (raw) => raw as Record<string, unknown>, plan: async (input) => input, execute: async () => ({ success: true }) }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const call = { invocationId: requestId, toolCallId, toolName: 'browser', input: { action: 'navigate', mode: 'open', url: 'https://example.com/path' } }
    const binding = await registered.prepareTool(call, { kind: 'initial' })
    const capabilities = new CapabilityRegistry()
    capabilities.define(requestId, ['browser'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    const gateDecision = await safetyGate.evaluate(binding)
    expect(gateDecision).toMatchObject({ kind: 'ask', reasonCode: 'browser-navigate-ask-desktop' })
    if (gateDecision.kind !== 'ask') throw new Error('EXPECTED_BROWSER_NAVIGATE_CONFIRMATION')
    const confirmation = agentSdk.createConfirmationPort(policy, {
      cancel: (call) => { cancelToolConfirm(requestId, call.toolCallId, sessionId) },
      agentChannelFactory: () => ({
        request: async () => ({ kind: 'rejected', cause: 'unavailable', answererKind: 'agent' }),
        cancel: vi.fn()
      }) as never
    })
    const pending = confirmation({
      call, confirmationId: gateDecision.confirmationId, answerer: gateDecision.answerer, reasonCode: gateDecision.reasonCode,
      context: gateDecision.context
    })

    try {
      await vi.waitFor(() => expect(isPendingConfirm(requestId, toolCallId, sessionId)).toBe(true))
      expect(submitToolConfirmResponse(requestId, toolCallId, true, sessionId).accepted).toBe(true)
      await expect(pending).resolves.toMatchObject({ kind: 'approved', answerer: 'user', cause: 'user-approved' })
      expect(isBrowserSessionTrustedHost(sessionId, 'example.com')).toBe(true)
      expect(new SqliteDecisionCache(getDbConnection(db)).lookup(key)).not.toBeNull()
    } finally {
      if (isPendingConfirm(requestId, toolCallId, sessionId)) cancelToolConfirm(requestId, toolCallId, sessionId)
      registered.discardPreparedTool(call)
      resetBrowserSessionTrustForTests()
    }
  })

  it('does not persist browser session trust when the original agent approves', async () => {
    const requestId = 'req-hosted-browser-agent-approval'
    const toolCallId = 'hosted-browser-agent-approval-call'
    const sessionId = 'session-hosted-browser-agent-approval'
    const db = createMemoryAppDb('zh-CN')
    const key = { kind: 'domain' as const, domain: 'example.com', level: 'domain-any-action' as const, sessionId }
    const { agentSdk } = assembleInvocation({
      requestId, sessionId, model: 'test-model', locale: 'zh-CN', lane: 'desktop',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, navigateRequiresConfirm: true },
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', appDb: db,
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'browser', parseInput: (raw) => raw as Record<string, unknown>, plan: async (input) => input, execute: async () => ({ success: true }) }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const call = { invocationId: requestId, toolCallId, toolName: 'browser', input: { action: 'navigate', mode: 'open', url: 'https://example.com/path' } }
    const binding = await registered.prepareTool(call, { kind: 'initial' })
    const capabilities = new CapabilityRegistry()
    capabilities.define(requestId, ['browser'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    await expect(safetyGate.evaluate(binding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'browser-navigate-ask-desktop' })

    markAgentSdkSafetyDecisionConfirmed(policy, binding, 'agent')

    expect(isBrowserSessionTrustedHost(sessionId, 'example.com')).toBe(false)
    expect(new SqliteDecisionCache(getDbConnection(db)).lookup(key)).toBeNull()
    registered.discardPreparedTool(call)
  })

  it('projects hosted provider usage from the assembled port into both desktop ledgers', async () => {
    const emitFactEvent = vi.fn()
    const emitSessionEvent = vi.fn()
    const { ports } = assembleInvocation({
      requestId: 'req-usage-assembly', sessionId: 'session-usage-assembly', turnId: 'turn-usage-assembly',
      model: 'test-model', baseUrl: 'https://api.anthropic.com', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent, emitSessionEvent
    })

    await ports.recordProviderAttemptUsage?.({
      invocationId: 'req-usage-assembly', modelTurn: 2, attempt: 1, routeId: 'route-1',
      usage: { inputTokens: 100, outputTokens: 8, cacheReadInputTokens: 20 }, finishReason: 'stop', disposition: 'discarded',
      reasonCode: 'SILENT_CONTEXT_OVERFLOW'
    })

    expect(emitSessionEvent).toHaveBeenCalledWith({ type: 'request_usage', payload: {
      schemaVersion: 1, requestId: 'req-usage-assembly:round:2', turnId: 'turn-usage-assembly', source: 'api',
      usage: { input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 20, cacheSemantics: 'additive' },
      resultDisposition: 'discarded_overflow'
    } })
    expect(emitFactEvent).toHaveBeenCalledWith({ type: 'usage-updated', usage: {
      input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 20, cacheSemantics: 'additive'
    } })
  })

  it('records usage from a failed Hosted provider attempt without classifying it as overflow', async () => {
    const emitFactEvent = vi.fn()
    const emitSessionEvent = vi.fn()
    const { ports } = assembleInvocation({
      requestId: 'req-failed-usage', sessionId: 'session-failed-usage', turnId: 'turn-failed-usage',
      model: 'test-model', baseUrl: 'https://api.anthropic.com', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent, emitSessionEvent
    })

    await ports.recordProviderAttemptUsage?.({
      invocationId: 'req-failed-usage', modelTurn: 1, attempt: 1, routeId: 'route-1',
      usage: { inputTokens: 1234, outputTokens: 0 }, disposition: 'failed', reasonCode: 'PROVIDER_STREAM_FAILED'
    })

    expect(emitSessionEvent).toHaveBeenCalledWith({ type: 'request_usage', payload: {
      schemaVersion: 1, requestId: 'req-failed-usage:round:1', turnId: 'turn-failed-usage', source: 'api',
      usage: { input_tokens: 1234, output_tokens: 0, cacheSemantics: 'additive' }
    } })
    expect(emitFactEvent).toHaveBeenCalledWith({ type: 'usage-updated', usage: {
      input_tokens: 1234, output_tokens: 0, cacheSemantics: 'additive'
    } })
  })

  it('publishes a stable authorization version for the frozen policy snapshot', () => {
    const first = assembleInvocation({
      requestId: 'req-policy-a', sessionId: 'session-policy', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const second = assembleInvocation({
      requestId: 'req-policy-b', sessionId: 'session-policy', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    expect(first.ports.policy.authorizationVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(second.ports.policy.authorizationVersion).toBe(first.ports.policy.authorizationVersion)
  })

  it('passes the runtime-owned dispatch admission and safety permit stores by identity', () => {
    const { ports } = assembleInvocation({
      requestId: 'req-runtime-security', sessionId: 'session-runtime-security', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    expect(ports.executionAdmission).toBe(runtime.executionAdmission)
    expect(ports.safetyPermits).toBe(runtime.safetyPermits)
  })

  it('passes the runtime-owned resource lock registry and tool concurrency by identity/value', () => {
    const { ports } = assembleInvocation({
      requestId: 'req-runtime-scheduling', sessionId: 'session-runtime-scheduling', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    expect(ports.resourceLocks).toBe(runtime.resourceLocks)
    expect(ports.toolExecutionConcurrency).toBe(runtime.toolExecutionConcurrency)
  })

  it('projects the SDK turn boundary into the existing Desktop compaction planner contract', async () => {
    const onTurnBoundary = vi.fn(async () => undefined)
    const { ports } = assembleInvocation({
      requestId: 'req-boundary-return', sessionId: 'session-boundary-return', turnId: 'turn-boundary-return',
      model: 'test-model', providerRouteId: 'test-route', contextWindow: 128, locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), onTurnBoundary
    })
    const required = { id: 'required-user', message: { role: 'user' as const, content: 'current request' } }
    await ports.observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'test-route', request: {
      messages: [{ role: 'system', content: 'real system prompt' }, required.message], maxTokens: 64,
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }]
    }, currentUserMessageId: required.id, requiredUserMessage: required })
    const responseProjection = await ports.observer.prepareModelResponseProjection?.({
      modelTurn: 1, finishReason: 'stop', usage: { type: 'usage', inputTokens: 100, outputTokens: 4 },
      message: { role: 'assistant', content: 'answer' }
    })
    await expect(ports.turnBoundary?.({
      invocationId: 'req-boundary-return', modelTurn: 1,
      response: { role: 'assistant', content: 'answer' },
      messages: [required.message, { role: 'assistant', content: 'answer' }], toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 4 }, requestProjection: responseProjection?.turnBoundaryProjection,
      currentUserMessageId: required.id, requiredUserMessage: required
    })).resolves.toBeUndefined()
    expect(onTurnBoundary).toHaveBeenCalledOnce()
    expect(onTurnBoundary).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-boundary-return:round:1', windowId: 'session-boundary-return', system: 'real system prompt',
      tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object' } }],
      messages: expect.arrayContaining([expect.objectContaining({ id: 'required-user', content: 'current request' })]),
      budget: expect.objectContaining({ totalInputBudget: expect.any(Number), bodyBudget: expect.any(Number) }),
      contextUsage: expect.objectContaining({ projectedTokens: expect.any(Number) }),
      requiredSurfaceSet: ['required-user'], toolExecutionCheckpoint: { completedToolUseIds: [], replayForbidden: false }
    }))
  })

  it('emits provider request_retry only after the SDK commits recovery and binds it to the retry request', async () => {
    const emitSessionEvent = vi.fn()
    const { ports } = assembleInvocation({
      requestId: 'req-overflow', sessionId: 'session-overflow', turnId: 'turn-overflow',
      model: 'test-model', providerRouteId: 'test-route', locale: 'zh-CN',
      messages: [{ role: 'user', content: 'earlier' }, { role: 'user', content: 'current' }],
      currentUserMessageId: 'current',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent
    })
    const result = await ports.recoverProviderAttempt?.({
      error: Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' }),
      attempt: 1, modelTurn: 2, routeId: 'test-route',
      messages: [{ role: 'user', content: 'earlier' }, { role: 'user', content: 'current' }],
      currentUserMessageId: 'current', requiredUserMessage: { id: 'current', message: { role: 'user', content: 'current' } }
    })
    expect(result).toMatchObject({ reasonCode: 'PROVIDER_CONTEXT_OVERFLOW', messages: [{ role: 'user', content: 'current' }] })
    expect(emitSessionEvent).not.toHaveBeenCalled()
    await ports.observer.onProviderRetry?.({ attempt: 1, modelTurn: 2, routeId: 'test-route', requestId: 'req-overflow:round:2', code: 'provider_context_overflow' })
    expect(emitSessionEvent).toHaveBeenCalledWith({
      type: 'request_retry',
      payload: { turnId: 'turn-overflow', stepId: 'req-overflow', requestId: 'req-overflow:round:2', attempt: 1, backoffMs: 0, code: 'provider_context_overflow' }
    })
  })

  it('preserves the stable session-event location needed by startup compaction recovery', () => {
    const location = { workDir: '/work/agent', sessionId: 'session-1', createdAt: 1234 }
    const { ports } = assembleInvocation({
      requestId: 'req-compaction-location', sessionId: 'session-1', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/work/agent', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      sessionEventLocation: location, emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })

    expect(ports.storage?.sessionEventLocation).toEqual(location)
  })
})
