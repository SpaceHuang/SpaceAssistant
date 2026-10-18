import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { markAgentSdkSafetyDecisionConfirmed } from '../confirmation/agentSdkSafetyPolicy'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { createAgentRuntime } from './agentRuntime'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './agentRuntimeDefaults'
import { createDesktopAgentRuntime } from './desktopAgentRuntime'
import { assembleInvocation } from '../testSupport/invocationAssembler'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import type { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import type { McpConnectionManager } from '../mcp/mcpConnectionManager'
import { cancelToolConfirm, isPendingConfirm, submitToolConfirmResponse } from '../toolConfirmRegistry'
import { createMemoryAppDb } from '../database/testHelpers'
import { acceptTurnContext } from '../database/acceptedTurnStorage'
import { getDbConnection, setConfigValue } from '../database'
import { createSession, getUsageStepFactsForTurn as readUsageStepFactsForTurn, updateSession } from '../database/operations'
import { SqliteDecisionCache } from '../confirmation/sqliteDecisionCache'
import { isBrowserSessionTrustedHost, resetBrowserSessionTrustForTests } from '../browser/browserSessionTrust'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createImOrchestrationToolRegistry } from '../remote/imOrchestrationTools'
import { ImChannel } from '../confirmation/imChannel'
import { getToolCache, saveProfiles, saveToolCache } from '../mcp/mcpConfigStore'
import { buildMappedToolDescriptors, hashMcpToolDescription, hashMcpToolSchema } from '../mcp/mcpToolRegistry'
import { executeToolSearch } from '../tools/toolSearchTool'
import { commitImPolicySnapshot, readImPolicySnapshot } from '../confirmation/imPolicyStore'
import { evaluateToolCallGate } from '../confirmation/toolCallGate'
import { AgentChannel } from '../confirmation/agentChannel'
import { RunShellPlanError } from '../tools/runShellPlan'
import { PlanRejectedError } from '../../packages/agent-sdk/src/turn'

const TEST_USER_DATA_DIR = path.join(os.tmpdir(), 'spaceassistant-invocation-test-user-data')

function createImPolicyTestDb(name: string) {
  const db = createMemoryAppDb(name)
  commitImPolicySnapshot(getDbConnection(db), {
    policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: `${name}-policy`
  })
  return db
}

describe('AcceptedTurn propagation', () => {
  it('does not expose an AGENTS.md session toggle in the invocation profile', () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'agents-md-setting' })
    const { invocation } = assembleInvocation({ requestId: 'agents-md-disabled', sessionId: session.id, model: 'test', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    expect(invocation.profile.agentsMdEnabled).toBeUndefined()
    db.close()
  })

  it('does not associate IM confirmations with a Track while the confirmation-link gate is off', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'track-confirmation-link-disabled' })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true' })) setConfigValue(db, key, value)
    const imChannel = new ImChannel({ lane: 'wechat', timeoutMs: 60_000, sendPrompt: async () => ({ messageId: 'prompt-1' }),
      onTrackConfirmationChild: vi.fn() })
    const trackContext = { trackId: 'track-1', channel: 'wechat' as const, identityKey: 'user-1', ownerId: 'owner-1',
      authorizationEpoch: 1, rootMessageId: 'root-1', attributionEventId: 'event-1' }
    const { agentSdk } = assembleInvocation({
      requestId: 'track-confirmation-link-disabled', sessionId: session.id, lane: 'wechat', model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'wechat', messageId: 'inbound-1', confirmPolicy: 'always', userId: 'user-1', authorizationGeneration: 1, imChannel,
        trackContext } as never
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, { cancel: vi.fn() })
    const pending = confirmation({
      call: { invocationId: 'track-confirmation-link-disabled', toolCallId: 'tool-1', toolName: 'browser', input: { action: 'navigate' } },
      confirmationId: 'tool-1', answerer: 'user', reasonCode: 'browser-confirm',
      context: { facts: { toolName: 'browser', actionClass: 'outbound', baseRiskLevel: 'medium', signals: [], summary: { text: 'visit' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 60_000, answerer: 'user' } }
    })

    try {
      await vi.waitFor(() => expect(imChannel.listPending()).toHaveLength(1))
      expect(imChannel.listPending()[0]).not.toHaveProperty('trackId')
      expect(imChannel.listPending()[0]).not.toHaveProperty('trackAttributionEventId')
      imChannel.resolveFromDesktop(imChannel.listPending()[0]!.id, false)
      await expect(pending).resolves.toMatchObject({ kind: 'denied' })
    } finally {
      for (const entry of imChannel.listPending()) imChannel.resolveFromDesktop(entry.id, false)
      db.close()
    }
  })

  it('associates IM confirmations with the exact Track when the confirmation-link gate is on', async () => {
    const db = createImPolicyTestDb('zh-CN')
    const session = createSession(db, { name: 'track-confirmation-link-enabled' })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackConfirmationLink: 'true' })) setConfigValue(db, key, value)
    const onTrackConfirmationChild = vi.fn()
    const imChannel = new ImChannel({ lane: 'wechat', timeoutMs: 60_000, sendPrompt: async () => ({ messageId: 'prompt-1' }), onTrackConfirmationChild })
    const trackContext = { trackId: 'track-1', channel: 'wechat' as const, identityKey: 'user-1', ownerId: 'owner-1',
      authorizationEpoch: 1, rootMessageId: 'root-1', attributionEventId: 'event-1' }
    const { agentSdk } = assembleInvocation({
      requestId: 'track-confirmation-link-enabled', turnId: 'track-confirmation-turn', sessionId: session.id, lane: 'wechat', model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'wechat', messageId: 'inbound-1', confirmPolicy: 'always', userId: 'user-1', authorizationGeneration: 1, imChannel,
        trackContext } as never
    })
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, { cancel: vi.fn() })
    const pending = confirmation({
      call: { invocationId: 'track-confirmation-link-enabled', toolCallId: 'tool-1', toolName: 'browser', input: { action: 'navigate' } },
      confirmationId: 'tool-1', answerer: 'user', reasonCode: 'browser-confirm',
      context: { facts: { toolName: 'browser', actionClass: 'outbound', baseRiskLevel: 'medium', signals: [], summary: { text: 'visit' } },
        decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 60_000, answerer: 'user' } }
    })

    try {
      await vi.waitFor(() => expect(imChannel.listPending()).toHaveLength(1))
      expect(imChannel.listPending()[0]).toMatchObject({ trackId: 'track-1', trackAttributionEventId: 'event-1',
        requestId: 'track-confirmation-link-enabled', turnId: 'track-confirmation-turn', toolUseId: 'tool-1', authorizationGeneration: 1,
        envelopeHash: expect.stringMatching(/^[a-f0-9]{64}$/), factsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        policyBehaviorVersion: 'im-v1.6', policySnapshotRevision: 1, policyRevision: expect.any(String) })
      expect(onTrackConfirmationChild).toHaveBeenCalledWith(expect.objectContaining({ trackId: 'track-1', trackAttributionEventId: 'event-1',
        requestId: 'track-confirmation-link-enabled', turnId: 'track-confirmation-turn', toolUseId: 'tool-1', authorizationGeneration: 1,
        envelopeHash: expect.stringMatching(/^[a-f0-9]{64}$/), factsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        policyBehaviorVersion: 'im-v1.6', policySnapshotRevision: 1, policyRevision: expect.any(String) }), 'pending')
      imChannel.resolveFromDesktop(imChannel.listPending()[0]!.id, false)
      await expect(pending).resolves.toMatchObject({ kind: 'denied' })
      expect(onTrackConfirmationChild).toHaveBeenLastCalledWith(expect.objectContaining({ trackId: 'track-1' }), 'settled')
    } finally {
      for (const entry of imChannel.listPending()) imChannel.resolveFromDesktop(entry.id, false)
      db.close()
    }
  })

  it.each(['feishu', 'wechat', 'automation'] as const)('%s receives the enabled MCP request snapshot', async (lane) => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: `mcp-${lane}` })
    const serverId = '11111111-2222-4333-8444-555555555555'
    const saved = await saveProfiles(db, [{
      id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 10,
      auth: { mode: 'none' }, stdio: { command: 'node', args: ['server.js'], env: [] },
      enabledToolNames: ['search']
    }])
    await saveToolCache(db, serverId, {
      tools: [{ serverId, originalName: 'search', mappedName: 'mcp_docs_search_12345678', description: 'Search docs', inputSchema: { type: 'object' }, discoveredAt: new Date().toISOString() }],
      protocolVersion: '2025-06-18', discoveredAt: new Date().toISOString()
    })
    const { ports } = assembleInvocation({
      requestId: `mcp-${lane}`, sessionId: session.id, lane, model: 'test', locale: 'zh-CN', messages: [],
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'always' }, appDb: db,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    expect((ports.mcp?.snapshot as { entries: Map<string, unknown> }).entries.has('mcp_docs_search_12345678')).toBe(true)
    expect(saved[0]?.enabledToolNames).toEqual(['search'])
    db.close()
  })

  it('injects public source and account authorization only from their separate current descriptor grants', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'mcp-public-trust' })
    const serverId = 'mcp-public-trust-server'
    const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    const annotations = { readOnlyHint: true, destructiveHint: false }
    const description = 'Search public documentation'
    const descriptorHash = hashMcpToolDescription({ serverId, originalName: 'search', description, inputSchema: schema, annotations })
    const profileInput = { id: serverId, name: 'Docs', enabled: true, transport: 'stdio' as const, timeoutSec: 10,
      auth: { mode: 'none' as const }, stdio: { command: 'node', args: ['server.js'], env: [] },
      enabledToolNames: ['search'], publicReadOnlyTools: { search: descriptorHash } }
    await saveProfiles(db, [profileInput], { allowPublicReadTrustChanges: true })
    await saveToolCache(db, serverId, { tools: [{ serverId, originalName: 'search', mappedName: 'mcp_docs_search_12345678', description,
      inputSchema: schema, annotations, schemaHash: hashMcpToolSchema(schema), descriptorHash, discoveredAt: new Date().toISOString() }],
      protocolVersion: '2025-06-18', discoveredAt: new Date().toISOString() })
    const { agentSdk } = assembleInvocation({ requestId: 'mcp-public-trust', sessionId: session.id, lane: 'feishu', model: 'test',
      locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const binding = { requestId: 'mcp-public-trust', turnId: 'turn-mcp-public-trust', invocationId: 'mcp-public-trust',
      toolCallId: 'search-call', capabilityId: 'mcp_docs_search_12345678', inputSnapshotHash: 'hash', planDigest: 'plan',
      factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: binding.capabilityId,
      input: { query: 'public docs' } }
    await expect(agentSdk.resolveGateArgs(binding, call)).resolves.toMatchObject({
      mcpQuerySource: 'public', mcpAccountAuthorization: 'unknown'
    })

    await saveProfiles(db, [{ ...profileInput, accountAuthorizedTools: { search: descriptorHash } }],
      { allowAccountAuthorizationChanges: true })
    await expect(agentSdk.resolveGateArgs(binding, call)).resolves.toMatchObject({
      mcpQuerySource: 'public', mcpAccountAuthorization: 'authorized'
    })

    const mismatchedTrustInput = { ...profileInput, publicReadOnlyTools: { search: 'b'.repeat(64) } }
    await saveProfiles(db, [mismatchedTrustInput], { allowPublicReadTrustChanges: true })
    await expect(agentSdk.resolveGateArgs(binding, call)).resolves.toMatchObject({
      mcpQuerySource: 'unknown', mcpAccountAuthorization: 'authorized'
    })
    db.close()
  })

  it.each(['feishu', 'wechat', 'automation'] as const)('%s tool_search only returns MCP entries in the turn authorization set', async (lane) => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: `mcp-trim-${lane}` })
    const serverId = '11111111-2222-4333-8444-555555555555'
    await saveProfiles(db, [{ id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 10,
      auth: { mode: 'none' }, stdio: { command: 'node', args: ['server.js'], env: [] }, enabledToolNames: ['private_search', 'public_search'] }])
    await saveToolCache(db, serverId, { tools: [
      { serverId, originalName: 'private_search', mappedName: 'mcp_docs_private_search_12345678', description: 'private description marker', inputSchema: { type: 'object', properties: { secret: { type: 'string', description: 'private schema marker' } } }, discoveredAt: new Date().toISOString() },
      { serverId, originalName: 'public_search', mappedName: 'mcp_docs_public_search_87654321', description: 'public description', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, discoveredAt: new Date().toISOString() }
    ], protocolVersion: '2025-06-18', discoveredAt: new Date().toISOString() })
    const { agentSdk } = assembleInvocation({ requestId: `mcp-trim-${lane}`, sessionId: session.id, lane, model: 'test', providerRouteId: 'hosted-route', locale: 'zh-CN', messages: [],
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'always' }, appDb: db, agentSdkHistory: new MemoryHistory(),
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const registry = new TypedToolRegistry()
    let capturedContext: Record<string, unknown> | undefined
    registry.register(definePlannedTool({ name: 'context_probe', parseInput: (raw) => raw as Record<string, unknown>,
      plan: async (_input, planning) => { capturedContext = planning.executionContext as Record<string, unknown>; return {} }, execute: async () => ({ success: true }) }))
    const registeredTools = agentSdk.createRegisteredTools({ registry })
    const createHost = (authorizedToolNames: ReadonlySet<string>) => agentSdk.createHostedTurnHost({ registeredTools, registry, authorizedToolNames,
      policy: { evaluate: vi.fn(async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' })) } as never })

    createHost(new Set(['tool_search', 'mcp_docs_public_search_87654321']))
    await registeredTools.prepareTool({ invocationId: `mcp-trim-${lane}`, toolCallId: 'probe-allow-public', toolName: 'context_probe', input: {} }, { kind: 'initial' })
    const denyFilteredResult = executeToolSearch({ query: '' }, capturedContext as never)

    expect(denyFilteredResult.matches.map(({ name }) => name)).toEqual(['mcp_docs_public_search_87654321'])
    expect(JSON.stringify(denyFilteredResult)).not.toContain('private description marker')
    expect(JSON.stringify(denyFilteredResult)).not.toContain('private schema marker')

    createHost(new Set(['tool_search']))
    await registeredTools.prepareTool({ invocationId: `mcp-trim-${lane}`, toolCallId: 'probe-allow-search-only', toolName: 'context_probe', input: {} }, { kind: 'initial' })
    const allowFilteredResult = executeToolSearch({ query: '' }, capturedContext as never)
    expect(allowFilteredResult.matches).toEqual([])
    expect(JSON.stringify(allowFilteredResult)).not.toContain('mcp_docs_private_search_12345678')
    db.close()
  })

  it('approval-agent invocation has an empty MCP snapshot even when tools are enabled', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'mcp-approval', ownership: 'internal', visibility: 'hidden' })
    const serverId = '11111111-2222-4333-8444-555555555555'
    await saveProfiles(db, [{ id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 10,
      auth: { mode: 'none' }, stdio: { command: 'node', args: ['server.js'], env: [] }, enabledToolNames: ['search'] }])
    await saveToolCache(db, serverId, { tools: [{ serverId, originalName: 'search', mappedName: 'mcp_docs_search_12345678', description: '', inputSchema: {}, discoveredAt: new Date().toISOString() }], protocolVersion: '2025-06-18', discoveredAt: new Date().toISOString() })
    const { ports } = assembleInvocation({ requestId: 'mcp-approval-agent', sessionId: session.id, lane: 'automation', internalConfirmExemption: 'approval-agent', model: 'test', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    expect((ports.mcp?.snapshot as { entries: Map<string, unknown> }).entries.size).toBe(0)
    db.close()
  })

  it('allows approved MCP executor after OAuth refresh, but blocks endpoint and schema changes', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'mcp-recheck' })
    const serverId = '11111111-2222-4333-8444-555555555555'
    const input = { id: serverId, name: 'Docs', enabled: true, transport: 'streamable-http' as const, timeoutSec: 10,
      auth: { mode: 'oauth' as const, oauthClientId: 'client-id', oauthScopes: ['docs.read'], accessTokenExpiresAt: '2026-10-10T09:00:00.000Z' },
      http: { endpoint: 'https://docs.example.com/mcp' }, enabledToolNames: ['search'] }
    await saveProfiles(db, [input])
    saveToolCache(db, serverId, { tools: [{ serverId, originalName: 'search', mappedName: 'mcp_docs_search_12345678', description: '', inputSchema: { type: 'object' }, discoveredAt: new Date().toISOString() }], protocolVersion: '2025-06-18', discoveredAt: new Date().toISOString() })
    const { ports } = assembleInvocation({ requestId: 'mcp-recheck', sessionId: session.id, lane: 'feishu', model: 'test', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const resolveExecutor = ports.mcp?.resolveExecutor as (name: string, manager: McpConnectionManager) => import('../tools/types').ToolExecutor | undefined
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const manager = { connect: vi.fn(async () => ({ client: { callTool } })), disconnect: vi.fn() } as never as McpConnectionManager
    const executor = resolveExecutor('mcp_docs_search_12345678', manager)!
    const getSession = vi.spyOn(manager, 'connect')

    await saveProfiles(db, [{ ...input, auth: { ...input.auth, accessTokenExpiresAt: '2026-10-10T10:00:00.000Z' } }])
    await expect(executor.execute({}, { requestId: 'mcp-recheck', toolUseId: 'tool-refresh-1', signal: new AbortController().signal } as never)).resolves.toMatchObject({ success: true })
    expect(getSession).toHaveBeenCalledOnce()

    await saveProfiles(db, [{ ...input, http: { endpoint: 'https://changed.example.com/mcp' } }])
    await expect(executor.execute({}, { requestId: 'mcp-recheck', toolUseId: 'tool-endpoint', signal: new AbortController().signal } as never).then((r) => r.success)).resolves.toBe(false)
    expect(getSession).toHaveBeenCalledOnce()

    await saveProfiles(db, [input])
    saveToolCache(db, serverId, { ...getToolCache(db, serverId)!, tools: [{ ...getToolCache(db, serverId)!.tools[0]!, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] })
    const schemaChanged = resolveExecutor('mcp_docs_search_12345678', manager)!
    await expect(schemaChanged.execute({}, { requestId: 'mcp-recheck', toolUseId: 'tool-schema', signal: new AbortController().signal } as never).then((r) => r.success)).resolves.toBe(false)
    expect(getSession).toHaveBeenCalledOnce()
    db.close()
  })

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

  it('uses frozen IM effective effort without recomputing model capability in the assembler', () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'frozen-reasoning' })
    setConfigValue(db, 'config.models', JSON.stringify([{ id: 'model-id', name: 'test-model', enabled: true, supportsThinking: false }]))
    const acceptedTurn = Object.freeze({
      turnId: 'frozen-reasoning-turn', requestId: 'frozen-reasoning-request', sessionId: session.id,
      lane: 'feishu' as const, startToken: 'frozen-reasoning-start', currentUserMessageId: 'frozen-reasoning-user',
      transcriptVersion: 1,
      config: Object.freeze({ lane: 'feishu' as const, model: 'test-model', llmServiceId: 'service-id', thinkingEffort: 'medium' as const, requestedThinkingEffort: 'low' as const })
    })
    acceptTurnContext(db, acceptedTurn as never)
    const { invocation } = assembleInvocation({
      requestId: acceptedTurn.requestId, sessionId: session.id, lane: 'feishu', acceptedTurn,
      model: 'test-model', modelId: 'model-id', effort: 'medium', requestedThinkingEffort: 'low',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, getApiKey: async () => 'key',
      workDir: '/tmp', userDataDir: '/tmp', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })

    expect(invocation.profile.reasoning).toEqual({ effort: 'medium', degraded: { from: 'low', to: 'medium' } })
    db.close()
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

  it('4.1.2a RED: rejects caller lane and remote source conflicts with the accepted turn', () => {
    const acceptedTurn = Object.freeze({
      turnId: 'origin-turn', requestId: 'origin-request', sessionId: 'origin-session', lane: 'feishu' as const,
      startToken: 'origin-start', currentUserMessageId: 'origin-user', transcriptVersion: 1,
      config: Object.freeze({ lane: 'feishu' as const })
    })
    expect(() => assembleInvocation({
      requestId: acceptedTurn.requestId, sessionId: acceptedTurn.sessionId, acceptedTurn,
      lane: 'wechat', remoteContext: { source: 'feishu' } as never,
      model: 'test-model', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })).toThrow('ACCEPTED_TURN_ORIGIN_MISMATCH')
  })

  it('4.1.2a RED: rejects missing or unknown remote source at runtime', () => {
    const base = { requestId: 'unknown-origin-request', sessionId: 'unknown-origin-session', lane: 'wechat' as const,
      model: 'test-model', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() }
    expect(() => assembleInvocation({ ...base, remoteContext: {} as never })).toThrow('INVOCATION_REMOTE_SOURCE_INVALID')
    expect(() => assembleInvocation({ ...base, remoteContext: { source: 'desktop' } as never })).toThrow('INVOCATION_REMOTE_SOURCE_INVALID')
  })

  it('4.1.2a RED: rejects stale session metadata when it conflicts with the persisted accepted origin', () => {
    const persisted = Object.freeze({
      turnId: 'persisted-turn', requestId: 'persisted-request', sessionId: 'persisted-session', lane: 'feishu' as const,
      startToken: 'persisted-start', currentUserMessageId: 'persisted-user', transcriptVersion: 7,
      config: Object.freeze({ lane: 'feishu' as const, model: 'trusted-model' })
    })
    const staleMetadataAcceptedTurn = Object.freeze({
      ...persisted, lane: 'wechat' as const, config: Object.freeze({ lane: 'wechat' as const, model: 'trusted-model' })
    })
    const readAccepted = vi.fn(() => persisted)

    expect(() => assembleInvocation({
      requestId: persisted.requestId, sessionId: persisted.sessionId, lane: 'wechat',
      acceptedTurn: staleMetadataAcceptedTurn,
      remoteContext: { source: 'wechat' } as never,
      sessionStorage: { execution: { readAccepted } } as never,
      model: 'trusted-model', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })).toThrow('ACCEPTED_TURN_PERSISTED_CONTEXT_MISMATCH')
    expect(readAccepted).toHaveBeenCalledWith({ sessionId: persisted.sessionId, requestId: persisted.requestId })
  })
})

describe('selected directory prompt context', () => {
  it('通过组合根注入的 SessionStorage 查询会话授权资料', () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'query-port' })
    const storage = createSqliteSessionStorage(db)
    const readSession = vi.fn(storage.queries.readSession)
    const sessionStorage = { ...storage, queries: { ...storage.queries, readSession } }

    assembleInvocation({ requestId: 'query-port', sessionId: session.id, model: 'test', locale: 'zh-CN', lane: 'desktop', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, system: 'base', workDir: '/tmp', userDataDir: '/tmp', appDb: db, sessionStorage, getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })

    expect(readSession).toHaveBeenCalledWith(session.id)
    db.close()
  })

  it('adds only current, valid desktop session grants to the system prompt and rechecks revocation', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'invocation-session-grant-')))
    try {
      const db = createMemoryAppDb('zh-CN')
      const session = createSession(db, { name: 'directory context' })
      const stat = await fs.stat(root)
      const grant = { grantId: 'grant-prompt', sessionId: session.id, path: root, realPath: root, identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode }, createdAt: 1, source: 'user-selected-directory' as const }
      updateSession(db, session.id, { metadata: { ...session.metadata, sessionDirectoryGrants: [grant] } })
      const desktop = assembleInvocation({ requestId: 'prompt-desktop', sessionId: session.id, model: 'test', locale: 'zh-CN', lane: 'desktop', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, system: 'base system', workDir: '/tmp', userDataDir: '/tmp', appDb: db, sessionStorage: createSqliteSessionStorage(db), getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
      expect(desktop.invocation.profile.system).toContain(root)
      expect(desktop.invocation.profile.system).toContain('不表示要求立即扫描全部内容')
      let runtimeContext: Record<string, unknown> | undefined
      const registry = new TypedToolRegistry()
      registry.register(definePlannedTool({
        name: 'grant-probe', parseInput: (raw) => raw as Record<string, unknown>,
        plan: async (input, planning) => { runtimeContext = planning.executionContext as Record<string, unknown>; return input },
        execute: async () => ({ success: true })
      }))
      const registered = desktop.agentSdk.createRegisteredTools({ registry })
      await registered.prepareTool({ invocationId: 'prompt-desktop', toolCallId: 'grant-probe-1', toolName: 'grant-probe', input: {} }, { kind: 'initial' })
      const isGrantActive = runtimeContext?.isSessionDirectoryGrantActive as (value: typeof grant) => boolean
      expect(isGrantActive(grant)).toBe(true)
      updateSession(db, session.id, { metadata: { ...session.metadata, sessionDirectoryGrants: [] } })
      expect(isGrantActive(grant)).toBe(false)
      const remote = assembleInvocation({ requestId: 'prompt-remote', sessionId: session.id, model: 'test', locale: 'zh-CN', lane: 'feishu', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, system: 'base system', workDir: '/tmp', userDataDir: '/tmp', appDb: db, getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
      expect(remote.invocation.profile.system).toBe('base system')
      db.close()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

describe('IM task orchestration invocation contract', () => {
  it('injects the dedicated orchestration skill and Inbox/workflow tools only for IM lanes', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'im-orchestration-assembler' })
    const storage = createSqliteSessionStorage(db)
    const productionRegistry = createImOrchestrationToolRegistry(db)
    const im = assembleInvocation({
      requestId: 'im-orchestration', sessionId: session.id, model: 'test', locale: 'zh-CN', lane: 'feishu',
      remoteContext: { source: 'feishu' } as never, messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      imOrchestrationToolRegistry: productionRegistry,
      workDir: '/tmp', userDataDir: '/tmp', appDb: db, sessionStorage: storage, getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const desktop = assembleInvocation({
      requestId: 'desktop-orchestration', sessionId: session.id, model: 'test', locale: 'zh-CN', lane: 'desktop',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', appDb: db,
      sessionStorage: storage, getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const imSkillFragments = im.invocation.profile.skillFragments ?? []
    expect(imSkillFragments.filter((fragment) => fragment.includes('im-task-orchestration'))).toHaveLength(1)
    expect((desktop.invocation.profile.skillFragments ?? []).some((fragment) => fragment.includes('im-task-orchestration'))).toBe(false)

    const names = productionRegistry.entries().map(({ name }) => name)
    expect(names).toEqual(expect.arrayContaining(['im_inbox_list', 'im_inbox_claim', 'im_inbox_ack', 'im_inbox_release', 'im_inbox_renew', 'im_workflow_state_get', 'im_workflow_state_put']))
    const { bindImInboxToolContext } = await import('../remote/imInboxToolContext')
    const bound = bindImInboxToolContext({
      sessionId: 'model-session', ownerId: 'model-owner', channel: 'wechat',
      queueScope: { kind: 'desktop' }
    }, {
      sessionId: 'authenticated-session', lane: 'feishu',
      remoteContext: { source: 'feishu', authOwner: 'authenticated-owner' }
    } as never)
    expect(bound).toEqual({
      input: {}, sessionId: 'authenticated-session', ownerId: 'authenticated-owner',
      queueScope: { kind: 'im', channel: 'feishu', sessionId: 'authenticated-session' }
    })
    db.close()
  })

  it('rejects forged or missing authenticated Inbox context', async () => {
    const { bindImInboxToolContext } = await import('../remote/imInboxToolContext')
    expect(bindImInboxToolContext({ sessionId: 'forged' }, {
      sessionId: 'trusted-session', lane: 'wechat',
      remoteContext: { source: 'wechat', authOwner: 'trusted-owner' } as never
    })).toMatchObject({
      input: {}, sessionId: 'trusted-session', ownerId: 'trusted-owner',
      queueScope: { kind: 'im', channel: 'wechat', sessionId: 'trusted-session' }
    })
    expect(() => bindImInboxToolContext({ ownerId: 'model-owner' }, {
      sessionId: 'trusted-session', lane: 'wechat', remoteContext: { source: 'wechat' } as never
    })).toThrow('IM_TOOL_CONTEXT_OWNER_REQUIRED')
    expect(() => bindImInboxToolContext({}, {
      sessionId: 'trusted-session', lane: 'wechat',
      remoteContext: { source: 'feishu', authOwner: 'trusted-owner' } as never
    })).toThrow('IM_TOOL_CONTEXT_LANE_MISMATCH')
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

  it.each(['wechat', 'feishu'] as const)('loads the same validated IM policy snapshot for %s runtime gates', async (lane) => {
    const db = createMemoryAppDb(`im-policy-assembly-${lane}`)
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: 'im-standard-v2', snapshot: { denyOutbound: true, selectedPackage: 'strict' }, updatedAt: 1, eventId: `assembly-${lane}`
    })
    const { agentSdk } = assembleInvocation({
      requestId: `assembly-${lane}`, sessionId: `session-${lane}`, lane, model: 'test-model', locale: 'zh-CN',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: lane, messageId: 'inbound', confirmPolicy: 'always' } as never
    })
    const binding = { requestId: `assembly-${lane}`, turnId: `turn-${lane}`, invocationId: `assembly-${lane}`, toolCallId: 'tool',
      capabilityId: 'probe-tool', inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const args = await agentSdk.resolveGateArgs(binding, { invocationId: binding.invocationId, toolCallId: 'tool', toolName: 'probe-tool', input: {} })
    expect(args.imPolicySnapshot).toEqual(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }))
    expect(args.lanePackage).toBe('strict')
    db.close()
  })

  it('carries the current versioned IM package from assembler into the real gate decision without a release switch', async () => {
    const db = createImPolicyTestDb('zh-CN')
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-v2-agent-workdir-'))
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'im-standard-v2-assembler-gate' })
    const { agentSdk } = assembleInvocation({ requestId: 'im-standard-v2-assembler-gate', sessionId: 'im-v2-session', lane: 'feishu',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: path.join(os.tmpdir(), 'im-v2-agent-user-data'),
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'feishu', messageId: 'inbound-v2', confirmPolicy: 'always' } as never })
    const binding = { requestId: 'im-standard-v2-assembler-gate', turnId: 'im-v2-turn', invocationId: 'im-standard-v2-assembler-gate',
      toolCallId: 'browser-tool', capabilityId: 'browser', inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts',
      authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const gateArgs = await agentSdk.resolveGateArgs(binding, { invocationId: binding.invocationId, toolCallId: binding.toolCallId,
      toolName: 'browser', input: { action: 'navigate', url: 'https://example.com' } })
    expect(gateArgs.imPolicySnapshot?.policyBehaviorVersion).toBe('im-standard-v2')
    await expect(evaluateToolCallGate(gateArgs)).resolves.toMatchObject({ decision: {
      type: 'require-confirm', ruleId: 'browser-navigate-ask-remote', answerer: 'agent', disposition: 'auto-eligible'
    } })
    const invokeApproval = vi.fn(async () => ({ ok: true as const, verdict: { kind: 'approve' as const, reason: { summary: 'approved' } } }))
    const agentChannelFactory = vi.fn((deps) => new AgentChannel({ ...deps, invokeApproval }))
    const confirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never,
      { cancel: vi.fn(), agentChannelFactory: agentChannelFactory as never })
    const decision = (await evaluateToolCallGate(gateArgs)).decision
    if (decision.type !== 'require-confirm' || decision.answerer !== 'agent') throw new Error('EXPECTED_AGENT_DECISION')
    await expect(confirmation({ call: { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: 'browser',
      input: { action: 'navigate', url: 'https://example.com' } }, modelTurn: 1, confirmationId: binding.toolCallId,
      answerer: decision.answerer, reasonCode: decision.ruleId,
      context: { facts: decision.facts, decision: { riskLevel: decision.riskLevel, memoryTiers: decision.memoryTiers,
        timeoutMs: decision.timeoutMs, answerer: decision.answerer, disposition: decision.disposition }, lane: 'feishu' } }))
      .resolves.toMatchObject({ kind: 'approved', answerer: 'agent', cause: 'agent-approved' })
    expect(agentChannelFactory).toHaveBeenCalledOnce()
    expect(invokeApproval).toHaveBeenCalledOnce()
    expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })

    const writeCall = { invocationId: binding.invocationId, toolCallId: 'write-candidate-call', toolName: 'write_file',
      input: { path: 'new-review.md', content: 'ordinary new workspace file' } }
    const writeBinding = { ...binding, toolCallId: writeCall.toolCallId, capabilityId: writeCall.toolName }
    const writeGateArgs = await agentSdk.resolveGateArgs(writeBinding, writeCall)
    const writeGate = await evaluateToolCallGate(writeGateArgs)
    expect(writeGate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'im-low-risk-create', answerer: 'agent', disposition: 'auto-eligible' })
    await expect(confirmation({ call: writeCall, modelTurn: 2, confirmationId: writeCall.toolCallId,
      answerer: 'agent', reasonCode: writeGate.decision.type === 'require-confirm' ? writeGate.decision.ruleId : '',
      context: { facts: writeGate.facts, decision: writeGate.decision.type === 'require-confirm' ? {
        riskLevel: writeGate.decision.riskLevel, memoryTiers: writeGate.decision.memoryTiers,
        timeoutMs: writeGate.decision.timeoutMs, answerer: writeGate.decision.answerer, disposition: writeGate.decision.disposition
      } : {}, lane: 'feishu' } }))
      .resolves.toMatchObject({ kind: 'approved', answerer: 'agent', cause: 'agent-approved' })
    expect(agentChannelFactory).toHaveBeenCalledTimes(2)
    expect(invokeApproval).toHaveBeenCalledTimes(2)
    db.close()
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('preserves a persisted user ask override from assembler through the real IM gate', async () => {
    const db = createImPolicyTestDb('im-standard-v2-user-ask-override')
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-user-ask-override-'))
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'standard', ruleOverrides: { 'im-time-query-review': 'ask' } },
      updatedAt: 1, eventId: 'im-standard-v2-user-ask-override' })
    const { agentSdk } = assembleInvocation({ requestId: 'im-standard-v2-user-ask-override', sessionId: 'im-user-ask-session', lane: 'wechat',
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'wechat', messageId: 'inbound-user-ask', confirmPolicy: 'always' } as never })
    const binding = { requestId: 'im-standard-v2-user-ask-override', turnId: 'im-user-ask-turn',
      invocationId: 'im-standard-v2-user-ask-override', toolCallId: 'time-query-tool', capabilityId: 'toolkit.call',
      inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const gateArgs = await agentSdk.resolveGateArgs(binding, { invocationId: binding.invocationId, toolCallId: binding.toolCallId,
      toolName: 'toolkit.call', input: { id: 'env.time', params: {} } })
    const gate = await evaluateToolCallGate(gateArgs)
    expect(gateArgs.effectiveRules.find((rule) => rule.id === 'im-time-query-review')?.action).toBe('ask')
    expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'im-time-query-review', answerer: 'user', disposition: 'human-required' })
    db.close()
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it.each([
    { override: 'ask' as const, expected: { type: 'require-confirm', answerer: 'user', ruleId: 'mcp-tool-ask', disposition: 'human-required' } },
    { override: 'deny' as const, expected: { type: 'deny', ruleId: 'mcp-tool-ask' } }
  ])('honors persisted MCP $override override over the generic IM write candidate after real assembly', async ({ override, expected }) => {
    const db = createImPolicyTestDb(`im-standard-v2-mcp-${override}-override`)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `im-mcp-${override}-override-`))
    const schema = { type: 'object', properties: { body: { type: 'string' } } }
    const entry = buildMappedToolDescriptors('im-mcp-override-server', 'MCP Override Server', [{
      name: 'create_record', description: 'Create a record', inputSchema: schema
    }]).descriptors[0]!
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'standard', ruleOverrides: { 'mcp-tool-ask': override } }, updatedAt: 1,
      eventId: `im-standard-v2-mcp-${override}-override` })
    const { agentSdk } = assembleInvocation({ requestId: `im-standard-v2-mcp-${override}-override`,
      sessionId: `im-mcp-${override}-session`, lane: 'wechat', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: path.join(workDir, '.userdata'),
      getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'wechat', messageId: `mcp-${override}-override`, confirmPolicy: 'always' } as never })
    const binding = { requestId: `im-standard-v2-mcp-${override}-override`, turnId: `im-mcp-${override}-turn`,
      invocationId: `im-standard-v2-mcp-${override}-override`, toolCallId: `mcp-${override}-call`,
      capabilityId: entry.mappedName, inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts',
      authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: entry.mappedName,
      input: { body: 'record' } }
    try {
      const args = await agentSdk.resolveGateArgs(binding, call)
      args.mcpEntry = { ...entry, serverName: 'MCP Override Server' }
      expect(args.effectiveRules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe(override)
      expect(args.effectiveRules.find((rule) => rule.id === 'mcp-tool-ask')?.userOverride).toBe(true)
      const gate = await evaluateToolCallGate(args)
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'mcp-invocation', completeness: 'complete' }))
      expect(gate.decision).toMatchObject(expected)
    } finally { db.close(); await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it('invalidates an IM Agent candidate when the write target changes before the Hosted recheck', async () => {
    const db = createMemoryAppDb('im-write-candidate-facts-change')
    const session = createSession(db, { name: 'im-write-candidate-facts-change' })
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-write-recheck-'))
    const target = path.join(workDir, 'new.md')
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'im-write-candidate-facts-change' })
    const { agentSdk } = assembleInvocation({ requestId: 'im-write-candidate-facts-change', sessionId: session.id, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'candidate-origin', chatId: 'candidate-chat', userId: 'owner' } as never,
      model: 'test-model', providerRouteId: 'route-im-write-candidate', agentSdkHistory: new MemoryHistory(), locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      workDir, userDataDir: TEST_USER_DATA_DIR, getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const execute = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => input, execute }))
    const agentRequest = vi.fn(async () => {
      await fs.writeFile(target, 'created between review and recheck')
      return { kind: 'approved' as const, cause: 'agent-approved' as const, answererKind: 'agent' as const }
    })
    const defer = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ kind: 'deferred' as const, todoId: 'fresh-human-write-todo',
      invocationId: 'im-write-candidate-facts-change', cause: 'human-required' as const,
      executionState: 'not-executed' as const, retryable: false, nextStep: 'await-user' as const,
      checkpointRef: { checkpointId: 'fresh-human-write-checkpoint', workflowRevision: 2 } })
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['write_file']), confirmationAdapter: {
      cancel: vi.fn(), defer, createChannel: () => ({ request: agentRequest, cancel: vi.fn() }) as never
    } })
    const call = { invocationId: 'im-write-candidate-facts-change', toolCallId: 'write-candidate', toolName: 'write_file',
      input: { path: 'new.md', content: 'reviewed content' } }
    const capabilities = new CapabilityRegistry()
    capabilities.define(call.invocationId, ['write_file'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: composed.policy })
    try {
      const initial = await composed.registeredTools.prepareTool(call, { kind: 'initial' })
      const decision = await safetyGate.evaluate(initial)
      expect(decision).toMatchObject({ kind: 'ask', answerer: 'agent', reasonCode: 'im-low-risk-create' })
      if (decision.kind !== 'ask') throw new Error('EXPECTED_AGENT_WRITE_CANDIDATE')
      await expect(composed.confirmation({ call, confirmationId: decision.confirmationId, answerer: decision.answerer,
        reasonCode: decision.reasonCode, context: decision.context })).resolves.toMatchObject({ kind: 'approved', answerer: 'agent' })
      expect(agentRequest).toHaveBeenCalledOnce()
      expect(await fs.readFile(target, 'utf8')).toBe('created between review and recheck')

      const recheck = await composed.registeredTools.prepareTool(call, { kind: 'recheck', confirmation: { receipt: 'confirmation:agent-1' } })
      const renewedDecision = await safetyGate.evaluate(recheck)
      expect(renewedDecision).toMatchObject({ kind: 'ask', answerer: 'user', reasonCode: 'im-write-ask',
        context: { decision: { disposition: 'human-required' } } })
      if (renewedDecision.kind !== 'ask') throw new Error('EXPECTED_FRESH_HUMAN_WRITE_CONFIRMATION')
      await expect(composed.confirmation({ call, confirmationId: renewedDecision.confirmationId, answerer: renewedDecision.answerer,
        reasonCode: renewedDecision.reasonCode, context: renewedDecision.context })).resolves.toMatchObject({
        kind: 'deferred', todoId: 'fresh-human-write-todo', executionState: 'not-executed'
      })
      expect(execute).not.toHaveBeenCalled()
      expect(defer).toHaveBeenCalledTimes(2)
    } finally {
      composed.registeredTools.discardPreparedTool(call)
      await composed.dispose()
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('keeps the real assembled legacy write gate on the human answerer after a v2 rollout', async () => {
    const db = createImPolicyTestDb('im-legacy-write-after-rollout')
    const conn = getDbConnection(db)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-legacy-write-after-rollout-'))
    // Simulate upgrade/restart: migration retained the persisted v1.6 package even though the
    // current configuration is capable of selecting v2.
    const { agentSdk } = assembleInvocation({ requestId: 'im-legacy-write-after-rollout', sessionId: 'im-legacy-write-session',
      lane: 'feishu', model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      workDir, userDataDir: path.join(workDir, '.userdata'), getApiKey: async () => 'test-key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'feishu', messageId: 'legacy-after-rollout', confirmPolicy: 'always' } as never })
    const binding = { requestId: 'im-legacy-write-after-rollout', turnId: 'im-legacy-write-turn', invocationId: 'im-legacy-write-after-rollout',
      toolCallId: 'legacy-write', capabilityId: 'write_file', inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts',
      authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: 'write_file',
      input: { path: 'new-legacy.md', content: 'draft' } }
    try {
      expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })?.policyBehaviorVersion).toBe('im-v1.6')
      const args = await agentSdk.resolveGateArgs(binding, call)
      const gate = await evaluateToolCallGate(args)
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', zone: 'workdir-normal' }))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'im-write-ask', answerer: 'user' })
      const agentChannelFactory = vi.fn(() => ({ request: vi.fn(), cancel: vi.fn() }) as never)
      const userRequest = vi.fn(async () => ({ kind: 'approved' as const, cause: 'user-approved' as const }))
      const userConfirmation = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, {
        cancel: vi.fn(), agentChannelFactory, createChannel: () => ({ request: userRequest, cancel: vi.fn() }) as never
      })
      const result = await userConfirmation({ call, confirmationId: binding.toolCallId, answerer: 'user', reasonCode: 'im-write-ask',
        context: { facts: gate.facts, decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: null,
          answerer: 'user', disposition: 'human-required' }, lane: 'feishu' } })
      expect(result).toMatchObject({ kind: 'approved', answerer: 'user' })
      expect(userRequest).toHaveBeenCalledOnce()
      expect(agentChannelFactory).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally { db.close(); await fs.rm(workDir, { recursive: true, force: true }) }
  })
  it('refuses a source request tool recheck after the session work directory changes', async () => {
    let currentWorkDir = '/workspace/A'
    const requestId = 'workdir-source-binding'
    const { agentSdk, ports: invocationPorts } = assembleInvocation({
      requestId, sessionId: requestId, turnId: requestId, model: 'test-model', providerRouteId: 'hosted-route',
      messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/workspace/A', resolveWorkDir: () => currentWorkDir,
      userDataDir: '/tmp', getApiKey: async () => 'key', agentSdkHistory: new MemoryHistory(),
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'probe-tool', parseInput: (raw) => raw as Record<string, unknown>, plan: async () => ({}), execute: async () => ({ success: true }) }))
    runtime.modelProviders.register({ routeId: 'hosted-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'workdir-source-binding', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const hosted = await agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['probe-tool']) })
    const ports = await hosted.host.createPorts({ invocationId: requestId, turnId: requestId, routeId: 'hosted-route', request: { messages: [], maxTokens: 10 } })
    const call = { invocationId: requestId, toolCallId: 'stale-call', toolName: 'probe-tool', input: {} }
    await ports.prepareTool(call, { kind: 'initial' })
    const currentBinding = invocationPorts.workspace.snapshot() as { profileId?: string; key?: string; revision?: number }
    const sourceBinding = { workDir: '/workspace/B', profileId: currentBinding.profileId, key: currentBinding.key, revision: currentBinding.revision }
    await expect(ports.prepareTool(call, {
      kind: 'recheck', requestMetadata: { workspaceBinding: sourceBinding }
    })).rejects.toMatchObject({ reasonCode: 'WORKDIR_BINDING_CHANGED' })
    await hosted.dispose()
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
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['probe-tool']) })
    const ports = await composed.host.createPorts({
      invocationId: turnId, turnId, routeId,
      request: { messages: [{ role: 'user', content: 'run probe' }], maxTokens: 10, tools: [{ name: 'probe-tool', description: 'probe', inputSchema: {} }] }
    })

    expect(ports).toMatchObject({ invocationId: turnId, turnId, routeId, confirmation: composed.confirmation, observer: expect.any(Object), maxModelTurns: 1000 })
    // FR12②：ports.prepareTool 是注册表 prepareTool 的结构化拒绝包装（共享同一 prepared 状态机，行为透传）
    expect(typeof ports.prepareTool).toBe('function')
    const binding = await ports.prepareTool!({ invocationId: turnId, toolCallId: 'probe-identity', toolName: 'probe-tool', input: { value: 1 } } as never, { kind: 'initial' })
    expect(binding).toMatchObject({ capabilityId: 'probe-tool' })
    expect(ports.toolExecution).toBe(composed.registeredTools.toolExecution)
    expect(ports.isApprovalCandidate).toBe(composed.registeredTools.isApprovalCandidate)
    expect(ports).not.toHaveProperty('deadlineAt')
    expect(ports.isApprovalCandidate?.({ invocationId: requestId, toolCallId: 'probe', toolName: 'probe-tool', input: {} })).toBe(false)
  })

  it('executes an approved deferred RegisteredTool through the composed Hosted SafetyGate without calling a model provider', async () => {
    const requestId = 'req-deferred-execute'
    const turnId = 'turn-deferred-execute'
    const routeId = 'route-deferred-execute'
    const providerStream = vi.fn(async function* () { yield { type: 'finish' as const, reason: 'stop' as const } })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'deferred-execute-provider', stream: providerStream
    })
    const execute = vi.fn(async () => ({ success: true, data: 'executed without a model' }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, plan: async (input) => input, execute }))
    const appDb = createImPolicyTestDb('deferred-execute-policy')
    const { agentSdk } = assembleInvocation({ requestId, turnId, sessionId: 'session-deferred-execute', model: 'test-model', providerRouteId: routeId,
      lane: 'wechat', appDb, messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: new MemoryHistory(), emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['write_file']) })
    try {
      await expect(composed.executeDeferred({ invocationId: turnId, toolCallId: 'persisted-tool-call', toolName: 'write_file',
        input: { path: 'deferred.txt', content: 'approved' } }, 'approval:reply-1')).resolves.toMatchObject({
        output: { success: true, data: 'executed without a model' }, isError: false
      })
      expect(execute).toHaveBeenCalledOnce()
      expect(providerStream).not.toHaveBeenCalled()
    } finally {
      await composed.dispose()
      appDb.close()
    }
  })

  it('executes a deferred call with distinct persisted invocation and turn identities', async () => {
    const routeId = 'route-deferred-distinct-identity'
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'deferred-distinct-provider', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const execute = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => input, execute }))
    const appDb = createImPolicyTestDb('deferred-distinct-policy')
    const { agentSdk } = assembleInvocation({ requestId: 'request-origin', turnId: 'turn-origin', sessionId: 'session-origin', model: 'test-model',
      providerRouteId: routeId, lane: 'wechat', appDb, messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', agentSdkHistory: new MemoryHistory(), emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['write_file']) })
    try {
      await expect(composed.executeDeferred({ invocationId: 'request-origin', toolCallId: 'persisted-tool-call', toolName: 'write_file',
        input: { path: 'deferred.txt', content: 'approved' } }, 'approval:reply-2')).resolves.toMatchObject({ isError: false })
    } finally { await composed.dispose(); appDb.close() }
    expect(execute).toHaveBeenCalledOnce()
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
    const emitFactEvent = vi.fn()
    const remoteContext = {
      source: 'feishu', messageId: 'message-1', chatId: 'chat-1', userId: 'user-1', inboundRaw: inbound,
      authOwner: 'owner-1', authorizationGeneration: 7, imChannel: { request: imRequest, cancelByRequestId }
    }
    const { agentSdk } = assembleInvocation({
      requestId: 'req-remote-confirm', sessionId: 'session-remote-confirm', lane: 'feishu', remoteContext: remoteContext as never,
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent, emitSessionEvent: vi.fn(),
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
    expect(emitFactEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm-requested', id: 'remote-1', requestId: 'req-remote-confirm', lane: 'feishu'
    }))
    expect(onConfirmRequest).not.toHaveBeenCalled()
    expect(isPendingConfirm('req-remote-confirm', 'remote-1', 'session-remote-confirm')).toBe(false)
  })

  it('keeps a real assembled IM confirmation on the synchronous user path while async approval is default-off', async () => {
    const requestId = 'req-async-gate-disabled'
    const sessionId = 'session-async-gate-disabled'
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: sessionId })
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'async-gate-disabled-policy' })
    const imRequest = vi.fn(async () => ({ kind: 'rejected' as const, cause: 'unavailable' as const }))
    const agentRequest = vi.fn(async () => ({ kind: 'approved' as const, cause: 'agent-approved' as const }))
    const { agentSdk } = assembleInvocation({ requestId, sessionId: session.id, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'inbound-disabled', chatId: 'chat-disabled', userId: 'owner-disabled',
        imChannel: { request: imRequest, cancelByRequestId: vi.fn() } } as never,
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => input, execute: async () => ({ success: true }) }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const call = { invocationId: requestId, toolCallId: 'async-gate-disabled-call', toolName: 'write_file', input: { path: 'note.txt', content: 'write' } }
    try {
      const binding = await registered.prepareTool(call, { kind: 'initial' })
      const capabilities = new CapabilityRegistry()
      capabilities.define(requestId, ['write_file'])
      const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
      const decision = await gate.evaluate(binding)
      expect(decision).toMatchObject({ kind: 'ask', answerer: 'user' })
      if (decision.kind !== 'ask') throw new Error('EXPECTED_CONFIRMATION_WHILE_ASYNC_GATE_DISABLED')
      const confirmation = agentSdk.createConfirmationPort(policy, { cancel: vi.fn(), agentChannelFactory: () => ({
        request: agentRequest, cancel: vi.fn()
      }) as never })

      await expect(confirmation({ call, confirmationId: decision.confirmationId, answerer: decision.answerer, reasonCode: decision.reasonCode,
        context: decision.context })).resolves.toMatchObject({ kind: 'unavailable' })

      expect(imRequest).toHaveBeenCalledOnce()
      expect(imRequest.mock.calls[0]?.[0]).toMatchObject({
        facts: expect.objectContaining({ toolName: 'write_file', actionClass: 'write', summary: { text: expect.stringContaining('write_file') }, signals: expect.any(Array) }),
        riskLevel: 'medium', memoryTiers: [], timeoutMs: null, answerer: 'user'
      })
      expect(agentRequest).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally {
      registered.discardPreparedTool(call)
      db.close()
    }
  })

  it.each([
    ['unavailable', { kind: 'rejected', cause: 'unavailable', answererKind: 'agent' }],
    ['timeout', { kind: 'rejected', cause: 'timeout', answererKind: 'agent' }],
    ['undetermined', { kind: 'rejected', cause: 'agent-undetermined', answererKind: 'agent' }],
    ['deny', { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }]
  ] as const)('does not route IM Agent %s into a desktop confirmation or approval todo', async (_name, agentOutcome) => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: `im-agent-${_name}` })
    const imRequest = vi.fn(async () => ({ kind: 'approved' as const, cause: 'user-approved' as const }))
    const onConfirmRequest = vi.fn()
    const agentRequest = vi.fn(async () => agentOutcome as never)
    const agentChannelFactory = vi.fn(() => ({ request: agentRequest, cancel: vi.fn() }))
    const { agentSdk } = assembleInvocation({ requestId: `im-agent-${_name}`, sessionId: session.id, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'inbound', chatId: 'chat', userId: 'owner',
        imChannel: { request: imRequest, cancelByRequestId: vi.fn() } } as never,
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      floatingNotificationManager: { onConfirmRequest } as never })
    const policy = { evaluate: vi.fn(), markConfirmed: vi.fn() } as never
    const confirmation = agentSdk.createConfirmationPort(policy, { cancel: vi.fn(), agentChannelFactory: agentChannelFactory as never })
    try {
      const outcome = await confirmation({
        call: { invocationId: `im-agent-${_name}`, toolCallId: `call-${_name}`, toolName: 'write_file', input: { path: 'x', content: 'y' } },
        confirmationId: `call-${_name}`, answerer: 'agent', reasonCode: 'im-auto-evaluator',
        context: { lane: 'feishu', facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write' } },
          decision: { riskLevel: 'medium', memoryTiers: [], timeoutMs: 1000, answerer: 'agent' } }
      })

      expect(outcome.kind).not.toBe('approved')
      expect(agentChannelFactory).toHaveBeenCalledOnce()
      expect(agentRequest).toHaveBeenCalledOnce()
      expect(imRequest).not.toHaveBeenCalled()
      expect(onConfirmRequest).not.toHaveBeenCalled()
      expect(policy.markConfirmed).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
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

  it('routes policy-selected IM auto-review to the Agent without a release gate row', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'im-test-auto-review' })
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-test-auto-review-'))
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'im-test-auto-review-policy' })
    expect(getDbConnection(db).prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_async_approval_gate_state'").get()).toBeUndefined()
    const { agentSdk } = assembleInvocation({ requestId: 'im-test-auto-review', sessionId: session.id, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'origin', chatId: 'chat', userId: 'owner', imChannel: { request: vi.fn(), cancelByRequestId: vi.fn() } } as never,
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      appDb: db, workDir, userDataDir: TEST_USER_DATA_DIR, getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, plan: async (input) => input, execute: async () => ({ success: true }) }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const agentRequest = vi.fn(async () => ({ kind: 'approved' as const, cause: 'agent-approved' as const }))
    const agentChannelFactory = vi.fn(() => ({ request: agentRequest, cancel: vi.fn() }))
    const confirmation = agentSdk.createConfirmationPort(policy, { cancel: vi.fn(), agentChannelFactory: () => agentChannelFactory() as never })
    const call = { invocationId: 'im-test-auto-review', toolCallId: 'auto-review-call', toolName: 'write_file',
      input: { path: 'new-review.md', content: 'candidate for review' } }
    try {
      const binding = await registered.prepareTool(call, { kind: 'initial' })
      const capabilities = new CapabilityRegistry()
      capabilities.define('im-test-auto-review', ['write_file'])
      const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
      const decision = await gate.evaluate(binding)
      expect(decision).toMatchObject({ kind: 'ask', answerer: 'agent' })
      if (decision.kind !== 'ask') throw new Error('EXPECTED_AGENT_AUTO_REVIEW_CANDIDATE')
      await expect(confirmation({ call, confirmationId: decision.confirmationId, answerer: decision.answerer,
        reasonCode: decision.reasonCode, context: decision.context })).resolves.toMatchObject({ kind: 'approved', answerer: 'agent' })
      expect(agentChannelFactory).toHaveBeenCalledOnce()
      expect(agentRequest).toHaveBeenCalledOnce()
    } finally {
      registered.discardPreparedTool(call)
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('4.1.14 RED: resolves an IM standard-v2 low-risk navigation candidate to the Agent answerer', async () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'im-standard-navigation-answerer' })
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'im-standard-navigation' })
    const { agentSdk } = assembleInvocation({ requestId: 'im-standard-navigation', sessionId: session.id, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'origin', chatId: 'chat', userId: 'owner', imChannel: { request: vi.fn(), cancelByRequestId: vi.fn() } } as never,
      model: 'test-model', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, navigateRequiresConfirm: true }, appDb: db,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'browser', parseInput: (raw) => raw as Record<string, unknown>, plan: async (input) => input,
      execute: async () => ({ success: true }) }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const call = { invocationId: 'im-standard-navigation', toolCallId: 'navigation-call', toolName: 'browser',
      input: { action: 'navigate', mode: 'open', url: 'https://public.example/path' } }
    try {
      const binding = await registered.prepareTool(call, { kind: 'initial' })
      const args = await agentSdk.resolveGateArgs(binding, call)
      const result = await evaluateToolCallGate(args)
      expect(result.decision).toMatchObject({ type: 'require-confirm', answerer: 'agent', ruleId: 'browser-navigate-ask-remote' })
    } finally {
      registered.discardPreparedTool(call)
      db.close()
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

  it('persists trusted model catalog identity and provider route from the assembled invocation', async () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.models', JSON.stringify([{ id: 'catalog-test-model', name: 'test-model' }]))
    const { ports } = assembleInvocation({
      requestId: 'req-usage-identity', sessionId: 'session-usage-identity', turnId: 'turn-usage-identity',
      model: 'test-model', modelId: 'catalog-test-model', providerRouteId: 'route-provider-identity',
      baseUrl: 'https://api.anthropic.com', locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', appDb: db,
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })

    await ports.recordProviderAttemptUsage?.({
      invocationId: 'req-usage-identity', modelTurn: 1, attempt: 1,
      usage: { inputTokens: 10, outputTokens: 2 }, disposition: 'accepted'
    })

    expect(readUsageStepFactsForTurn(db, 'session-usage-identity', 'turn-usage-identity')[0]).toMatchObject({
      modelId: 'catalog-test-model', providerModelName: 'test-model', routeIdentity: 'route-provider-identity'
    })
    db.close()
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

  it('4.1.4a RED: authorization version changes when the shared IM policy revision changes', () => {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: 'im-policy-revision-fence' })
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'revision-fence-1' })
    const compose = (requestId: string) => assembleInvocation({ requestId, sessionId: session.id, lane: 'feishu', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const first = compose('revision-fence-a')
    commitImPolicySnapshot(getDbConnection(db), { expectedRevision: 1, policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'standard' }, updatedAt: 2, eventId: 'revision-fence-2' })
    const second = compose('revision-fence-b')
    expect(second.ports.policy.authorizationVersion).not.toBe(first.ports.policy.authorizationVersion)
    db.close()
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
    const onContextReplacementPlan = vi.fn(async () => undefined)
    const { ports } = assembleInvocation({
      requestId: 'req-boundary-return', sessionId: 'session-boundary-return', turnId: 'turn-boundary-return',
      model: 'test-model', providerRouteId: 'test-route', contextWindow: 128, locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), onContextReplacementPlan
    })
    const required = { id: 'required-user', message: { role: 'user' as const, content: 'current request' } }
    await ports.observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'test-route', request: {
      messages: [{ role: 'system', content: 'real system prompt' }, required.message], maxTokens: 64,
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }]
    }, currentUserMessageId: required.id, requiredUserMessage: required })
    const responseProjection = await ports.observer.prepareContextBoundaryEvidence?.({
      modelTurn: 1, finishReason: 'stop', usage: { type: 'usage', inputTokens: 100, outputTokens: 4 },
      message: { role: 'assistant', content: 'answer' }
    })
    await expect(ports.planContextReplacement?.({
      phase: 'turn-boundary',
      invocationId: 'req-boundary-return', modelTurn: 1,
      response: { role: 'assistant', content: 'answer' },
      messages: [required.message, { role: 'assistant', content: 'answer' }], toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 4 }, requestProjection: responseProjection?.contextBoundaryEvidence,
      currentUserMessageId: required.id, requiredUserMessage: required
    })).resolves.toBeUndefined()
    expect(onContextReplacementPlan).toHaveBeenCalledOnce()
    expect(onContextReplacementPlan).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-boundary-return:round:1', windowId: 'session-boundary-return', system: expect.stringContaining('real system prompt'),
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

  it('keeps session-event ledger location out of the generic SDK storage port', () => {
    const location = { workDir: '/work/agent', sessionId: 'session-1', createdAt: 1234 }
    const { ports } = assembleInvocation({
      requestId: 'req-compaction-location', sessionId: 'session-1', model: 'test-model', locale: 'zh-CN', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/work/agent', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      sessionEventLocation: location, emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })

    expect(ports).not.toHaveProperty('storage')
  })
})

describe('P0-A：计划期失败降级为可回传拒绝（T-3，断言打在生产包装层 ports.prepareTool 上）', () => {
  let runtime: ReturnType<typeof createAgentRuntime>
  beforeEach(() => {
    resetDefaultAgentRuntimeForTests()
    runtime = createAgentRuntime({ builtinRegistry: { getLegacyExecutor: () => undefined, get: () => undefined, entries: () => [] } })
    setDefaultAgentRuntime(runtime)
    ;(runtime.modelProviders as ModelProviderRegistry).register(
      { routeId: 'route-plan-reject', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' },
      { providerId: 'plan-reject-provider', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } } }
    )
  })
  afterEach(() => { resetDefaultAgentRuntimeForTests() })

  const MISMATCH_DETAILS = {
    code: 'SHELL_DIALECT_MISMATCH', detectedSyntax: 'posix-bash', expectedDialect: 'windows-powershell',
    shellProfileId: 'windows-powershell', executable: 'powershell.exe',
    signals: ['posix-variable'], hints: ['使用 PowerShell 语法重写命令', '环境变量使用 $env:NAME，空输出使用 $null']
  }
  const buildComposed = (plan: (input: Record<string, unknown>) => Promise<unknown>) => {
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'run_shell', actionClass: 'write',
      parseInput: (raw) => raw as { command: string },
      plan: plan as never,
      execute: async () => ({ success: true })
    }))
    const { agentSdk } = assembleInvocation({
      requestId: 'req-plan-reject', sessionId: 'session-plan-reject', turnId: 'turn-plan-reject',
      model: 'test-model', providerRouteId: 'route-plan-reject', locale: 'zh-CN',
      messages: [{ role: 'user', content: 'run shell' }], toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      agentSdkHistory: new MemoryHistory(), emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    return agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['run_shell']) })
  }
  const prepareCall = { invocationId: 'turn-plan-reject', toolCallId: 'shell-call-1', toolName: 'run_shell', input: { command: 'export A=1 && echo $A' } }

  it('run_shell plan 抛 SHELL_DIALECT_MISMATCH 时被转换为 PlanRejectedError，携带可解析的 D-7 JSON 提示', async () => {
    const composed = buildComposed(async () => {
      throw new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', { ...MISMATCH_DETAILS })
    })
    try {
      const ports = await composed.host.createPorts({
        invocationId: 'turn-plan-reject', turnId: 'turn-plan-reject', routeId: 'route-plan-reject',
        request: { messages: [{ role: 'user', content: 'run shell' }], maxTokens: 10, tools: [{ name: 'run_shell', description: 'shell', inputSchema: {} }] }
      })
      const rejection = await ports.prepareTool!(prepareCall as never, { kind: 'initial' }).then(
        () => { throw new Error('expected prepareTool to reject') },
        (error: unknown) => error
      )
      expect(rejection).toBeInstanceOf(PlanRejectedError)
      expect(rejection).toMatchObject({ reasonCode: 'SHELL_DIALECT_MISMATCH', name: 'PlanRejectedError' })
      // D-7：拒绝文本为紧凑单行 JSON，固定字段、可解析、不加 Markdown 围栏
      const parsed = JSON.parse((rejection as PlanRejectedError).userMessage) as Record<string, unknown>
      expect(parsed).toMatchObject({
        code: 'SHELL_DIALECT_MISMATCH', caseId: 'SHELL-DIALECT-001',
        detectedSyntax: 'posix-bash', expectedDialect: 'windows-powershell', shellProfileId: 'windows-powershell',
        signals: ['posix-variable'], hints: ['使用 PowerShell 语法重写命令', '环境变量使用 $env:NAME，空输出使用 $null']
      })
    } finally {
      await composed.dispose()
    }
  })

  it('plan 失败后无 prepared 残留：同一 call 可重新 prepareTool（不报 PREPARED_CALL_ALREADY_EXISTS）', async () => {
    let attempts = 0
    const composed = buildComposed(async () => {
      attempts += 1
      if (attempts === 1) throw new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', { ...MISMATCH_DETAILS })
      return { command: 'ok' }
    })
    try {
      const ports = await composed.host.createPorts({
        invocationId: 'turn-plan-reject', turnId: 'turn-plan-reject', routeId: 'route-plan-reject',
        request: { messages: [{ role: 'user', content: 'run shell' }], maxTokens: 10, tools: [{ name: 'run_shell', description: 'shell', inputSchema: {} }] }
      })
      await expect(ports.prepareTool!(prepareCall as never, { kind: 'initial' })).rejects.toBeInstanceOf(PlanRejectedError)
      await expect(ports.prepareTool!(prepareCall as never, { kind: 'initial' })).resolves.toMatchObject({ capabilityId: 'run_shell' })
      composed.registeredTools.discardPreparedTool(prepareCall as never)
    } finally {
      await composed.dispose()
    }
  })

  it('白名单外异常（普通 Error）原样 rethrow，保持 fatal 语义不变（A-3）', async () => {
    const composed = buildComposed(async () => { throw new Error('RUN_SHELL_RUNTIME_CONTEXT_REQUIRED') })
    try {
      const ports = await composed.host.createPorts({
        invocationId: 'turn-plan-reject', turnId: 'turn-plan-reject', routeId: 'route-plan-reject',
        request: { messages: [{ role: 'user', content: 'run shell' }], maxTokens: 10, tools: [{ name: 'run_shell', description: 'shell', inputSchema: {} }] }
      })
      const rejection = await ports.prepareTool!(prepareCall as never, { kind: 'initial' }).then(
        () => { throw new Error('expected prepareTool to reject') },
        (error: unknown) => error
      )
      expect(rejection).not.toBeInstanceOf(PlanRejectedError)
      expect((rejection as Error).message).toBe('RUN_SHELL_RUNTIME_CONTEXT_REQUIRED')
    } finally {
      await composed.dispose()
    }
  })

  // A-2/A-8（§4.4 / D-8）：planned 转换层与 executor 共享同一 breaker——
  // 同会话第 2 次同款错配 → JSON 携带 retryCount/retryExhausted 与升级 hints；turn 不终止
  it('同会话第 2 次同款错配的 PlanRejectedError JSON 含 retryCount=2 与升级 hints（不阻断）', async () => {
    const details = { ...MISMATCH_DETAILS, signals: ['cmd-operator'], detectedSyntax: 'windows-cmd' }
    const composed = buildComposed(async () => {
      throw new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', { ...details })
    })
    try {
      const ports = await composed.host.createPorts({
        invocationId: 'turn-plan-reject', turnId: 'turn-plan-reject', routeId: 'route-plan-reject',
        request: { messages: [{ role: 'user', content: 'run shell' }], maxTokens: 10, tools: [{ name: 'run_shell', description: 'shell', inputSchema: {} }] }
      })
      const escalateCall = { ...prepareCall, toolCallId: 'shell-call-escalate' }
      const first = await ports.prepareTool!(escalateCall as never, { kind: 'initial' }).then(
        () => { throw new Error('expected prepareTool to reject') }, (error: unknown) => error
      ) as PlanRejectedError
      const firstParsed = JSON.parse(first.userMessage) as { retryCount: number; hints: string[] }
      expect(firstParsed.retryCount).toBe(1)
      // 换 toolCallId 再次错配（同会话同 profile 同 signals）
      const secondCall = { ...escalateCall, toolCallId: 'shell-call-escalate-2' }
      const second = await ports.prepareTool!(secondCall as never, { kind: 'initial' }).then(
        () => { throw new Error('expected prepareTool to reject') }, (error: unknown) => error
      ) as PlanRejectedError
      const secondParsed = JSON.parse(second.userMessage) as { retryCount: number; retryExhausted: boolean; hints: string[] }
      expect(secondParsed.retryCount).toBe(2)
      expect(secondParsed.retryExhausted).toBe(true)
      expect(secondParsed.hints).not.toEqual(firstParsed.hints)
      // 升级文案与真实 cmd 信号对应（评审 P2 残留：不再引用已撤销的 where.exe→Get-Command 示例）
      expect(secondParsed.hints.join(' ')).toContain('Get-ChildItem')
      expect(secondParsed.hints.join(' ')).not.toContain('Get-Command')
    } finally {
      await composed.dispose()
    }
  })
})
describe('wikiConfig passthrough (W3 lane parity)', () => {
  beforeEach(() => {
    setDefaultAgentRuntime(createDesktopAgentRuntime())
  })

  afterEach(() => resetDefaultAgentRuntimeForTests())

  it('propagates the assembled wikiConfig into the invocation tools profile', () => {
    const wikiConfig = { ...DEFAULT_WIKI_CONFIG }
    const { invocation } = assembleInvocation({
      requestId: 'req-wiki-passthrough', sessionId: 'session-wiki-passthrough', model: 'test-model', lane: 'automation',
      locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, wikiConfig,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    expect(invocation.profile.tools.wikiConfig).toMatchObject({ rootPath: 'llm-wiki' })
  })

  it('propagates Wiki config into the registered tool execution context for IM discovery', async () => {
    const wikiConfig = { ...DEFAULT_WIKI_CONFIG }
    let executionContext: Record<string, unknown> | undefined
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    runtime.modelProviders.register({ routeId: 'wiki-context-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, {
      providerId: 'wiki-context-probe', stream: async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }
    })
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'wiki-context-probe', parseInput: (raw) => raw as Record<string, unknown>,
      plan: async (_input, context) => { executionContext = context.executionContext as Record<string, unknown>; return {} },
      execute: async () => ({ success: true })
    }))
    const { agentSdk } = assembleInvocation({
      requestId: 'req-wiki-context', sessionId: 'session-wiki-context', model: 'test-model', providerRouteId: 'wiki-context-route', lane: 'wechat',
      locale: 'zh-CN', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, wikiConfig, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', agentSdkHistory: new MemoryHistory(), emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
    const hosted = await agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['wiki-context-probe']) })
    try {
      const ports = await hosted.host.createPorts({ invocationId: 'req-wiki-context', turnId: 'req-wiki-context', routeId: 'wiki-context-route', request: { messages: [], maxTokens: 10 } })
      await ports.prepareTool({ invocationId: 'req-wiki-context', toolCallId: 'wiki-context-call', toolName: 'wiki-context-probe', input: {} }, { kind: 'initial' })
      expect(executionContext?.wikiConfig).toMatchObject({ rootPath: 'llm-wiki' })
    } finally { await hosted.dispose() }
  })
})
