import { describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { MemoryHistory, InvocationHistoryWriter } from '../../packages/agent-sdk/src/history'
import { ResourceLockRegistry } from '../../packages/agent-sdk/src/resourceLock'
import { rebuildClaudeMessagesFromHistory, toCanonicalModelMessages } from '../runtime/canonicalHistory'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { defineDirectTool, definePlannedTool, TypedToolRegistry } from './plannedToolRegistry'
import { createRegisteredAgentTurnTools } from './registeredAgentTurnTools'
import { createReadRegisteredTools } from './readRegisteredTools'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { createWriteFileRegisteredTools } from './writeFileRegisteredTools'
import { createRunScriptRegisteredTool } from './runScriptRegisteredTool'
import { runShellRegisteredTool } from './runShellRegisteredTool'
import { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff } from '../confirmation/agentSdkSafetyPolicy'
import { ReadConfirmationRegistry } from '../confirmation/readConfirmationRegistry'
import { evaluateToolCallGate } from '../confirmation/toolCallGate'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { AgentToolRevocationPort } from '../../packages/agent-sdk/src/invocation'
import { createWeChatOutboundRegisteredTools } from './wechatOutboundRegisteredTools'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { FileStateCache } from '../fileStateCache'
import { editFileExecutor, runScriptExecutor, writeFileExecutor } from './builtinExecutors'
import { readFeishuAttachmentExecutor } from './readFeishuAttachmentExecutor'
import { probeWritePathFact } from '../confirmation/extractors/writePathFacts'
import { buildWriteExecutionPermit } from '../confirmation/writeExecutionPermit'
import * as directoryHandleWriterModule from '../confirmation/directoryHandleWriter'
import { cancelActiveAgentTool } from '../activeAgentToolCancellation'
import { registerActiveAgentToolCancellation } from '../activeAgentToolCancellation'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSpillStore } from '../storage/spillStore'

const route = { routeId: 'registered-tools', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
const requestId = 'req-sdk-host'
const turnId = 'turn-sdk-host'
const invocationId = 'inv-sdk-host'

async function* stream(...chunks: StreamChunk[]) { yield* chunks }

describe('createRegisteredAgentTurnTools', () => {
  it('spills the complete production tool result while keeping SDK replay content bounded', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'registered-tool-spill-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const spillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'registered-tool-spill-'))
    const fullOutput = 'complete registered tool result '.repeat(8_000)
    const registry = new TypedToolRegistry()
    registry.register(defineDirectTool({ name: 'large_read', actionClass: 'read', parseInput: (raw) => raw, execute: async () => ({ success: true, data: fullOutput }) }))
    const permits = new InMemorySafetyPermitStore()
    const registeredTools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ sessionId, workDir: '/workspace' }), resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['large_read'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'large-read-call', toolName: 'large_read', input: {} },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'large-tool-spill-provider', stream: () => responses.shift()! })
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, createSpillStore(spillRoot))

    try {
      await runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: 'read large data' }], maxTokens: 50,
          tools: [{ name: 'large_read', description: 'read large data', inputSchema: { type: 'object' } }] },
        safetyGate, prepareTool: registeredTools.prepareTool, toolExecution: registeredTools.toolExecution, history, maxModelTurns: 2
      })
      const stored = JSON.parse(conn.prepare(`SELECT payload_json FROM agent_history_events WHERE kind='tool-call-finished'`).get()!.payload_json as string) as {
        result: { data: { __spaceassistant_spill_v1: { kind: string; byteLength: number } } }; replayContent: string
      }
      expect(stored.result.data.__spaceassistant_spill_v1).toMatchObject({ kind: 'source-of-truth', byteLength: Buffer.byteLength(fullOutput) })
      expect(stored.replayContent.length).toBeLessThan(fullOutput.length)
      const restored = await history.read(invocationId)
      expect(restored.events.find(({ kind }) => kind === 'tool-call-finished')?.payload).toMatchObject({ result: { data: fullOutput } })
    } finally {
      db.close()
      await fs.rm(spillRoot, { recursive: true, force: true })
    }
  })

  it('preserves legacy approval-candidate classification from RegisteredTool action metadata', () => {
    const registry = new TypedToolRegistry()
    registry.register(defineDirectTool({ name: 'custom-write', actionClass: 'write', parseInput: (raw) => raw, execute: async () => 'ok' }))
    registry.register(defineDirectTool({ name: 'custom-read', actionClass: 'read', parseInput: (raw) => raw, execute: async () => 'ok' }))
    registry.register(defineDirectTool({ name: 'write_file', parseInput: (raw) => raw, execute: async () => 'ok' }))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits: new InMemorySafetyPermitStore(), admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({}), resolveAuthorizationVersion: () => 'policy-v1'
    })

    expect(tools.isApprovalCandidate({ invocationId, toolCallId: 'write-1', toolName: 'custom-write', input: {} })).toBe(true)
    expect(tools.isApprovalCandidate({ invocationId, toolCallId: 'read-1', toolName: 'custom-read', input: {} })).toBe(false)
    expect(tools.isApprovalCandidate({ invocationId, toolCallId: 'builtin-write', toolName: 'write_file', input: {} })).toBe(true)
  })

  it('denies a confirmed Feishu attachment identity change before RegisteredTool executor dispatch', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registered-feishu-attachment-confirmation-'))
    const messageId = 'message-1'
    const mediaDir = path.join(userDataDir, 'feishu-media', 'cache', messageId)
    const attachmentPath = path.join(mediaDir, 'brief.txt')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(attachmentPath, 'approved attachment')
    const toolInput = { attachmentId: 'attachment-1' }
    const attachmentRegistry = new ReadConfirmationRegistry()
    const policyRules = [...DEFAULT_POLICY_RULES, {
      id: 'test-confirm-feishu-attachment', when: 'invocation' as const,
      match: { lane: ['feishu' as const], toolName: 'read_feishu_attachment', signals: ['feishu-media-target:inside'] },
      action: 'ask' as const, reason: 'test attachment confirmation'
    }]
    const baseGateArgs = {
      toolName: 'read_feishu_attachment', toolInput, sessionId: 'feishu-session', requestId, toolUseId: 'confirmed-attachment',
      workDir: userDataDir, userDataDir, lane: 'feishu' as const,
      remoteContext: { source: 'feishu' as const, messageId, confirmPolicy: 'im_confirm' as const,
        feishuAttachments: [{ id: 'attachment-1', messageId, localPath: attachmentPath, fileName: 'brief.txt', mimeType: 'text/plain' }] },
      toolsConfig: DEFAULT_TOOLS_CONFIG, effectiveRules: policyRules, lanePackage: 'standard', decisionCache: { lookup: () => null },
      shellPrecheck: { touchTrustedCommand() {} }, audit: { record() {} }, readConfirmationRegistry: attachmentRegistry
    }
    const registry = new TypedToolRegistry()
    registry.register(createReadRegisteredTools({
      readFile: { name: 'read_file', execute: vi.fn() } as never,
      listDirectory: { name: 'list_directory', execute: vi.fn() } as never,
      grep: { name: 'grep', execute: vi.fn() } as never,
      readFeishuAttachment: readFeishuAttachmentExecutor
    }).find((tool) => tool.name === 'read_feishu_attachment')!)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ workDir: userDataDir, userDataDir, sessionId: 'feishu-session', lane: 'feishu',
        remoteContext: baseGateArgs.remoteContext }),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const executor = vi.spyOn(readFeishuAttachmentExecutor, 'execute')
    const safetyPolicy = createAgentSdkSafetyPolicy({
      resolveToolCall: tools.getPreparedCall,
      resolveGateArgs: async (current, call) => ({
        ...baseGateArgs, toolName: call?.toolName ?? 'read_feishu_attachment', toolInput: call?.input ?? toolInput,
        toolUseId: current.toolCallId, phase: current.phase === 'recheck' ? 'recheck' : 'initial'
      } as never),
      evaluateGate: evaluateToolCallGate,
      ...createAgentSdkStructuralPermitHandoff({ updateExecutionContext: tools.updateExecutionContext, readConfirmationRegistry: attachmentRegistry })
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['read_feishu_attachment'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: safetyPolicy })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'confirmed-attachment', toolName: 'read_feishu_attachment', input: toolInput },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: '附件已变化，未读取。' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'feishu-confirmed-attachment', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()

    try {
      await expect(runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: '读取飞书附件' }], maxTokens: 40,
          tools: [{ name: 'read_feishu_attachment', description: 'Read a registered Feishu attachment', inputSchema: { type: 'object' } }] },
        safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution,
        confirmation: async () => {
          await fs.rename(attachmentPath, `${attachmentPath}.approved`)
          await fs.writeFile(attachmentPath, 'replacement attachment')
          return { kind: 'approved', receipt: 'feishu-confirmed' }
        },
        maxModelTurns: 2, history
      })).rejects.toMatchObject({ reasonCode: 'PREPARED_RECHECK_FAILED' })
      const events = (await history.read(invocationId)).events
      expect(executor).not.toHaveBeenCalled()
      expect(providerCalls).toBe(1)
      expect(events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'confirmed-attachment', reason: 'PREPARED_RECHECK_FAILED'
      })
      expect(events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { status: 'denied', reason: 'PREPARED_RECHECK_FAILED' } })
    } finally {
      executor.mockRestore()
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('rechecks frozen WeChat reply identity after confirmation and before SDK dispatch', async () => {
    const context = {
      workDir: '/workspace', sessionId: 'session-wechat', lane: 'wechat',
      wechatConfig: { ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true },
      remoteContext: {
        source: 'wechat' as const, messageId: 'inbound-approved', userId: 'user-1', authOwner: 'owner-1',
        authorizationGeneration: 4, originSessionId: 'session-wechat'
      }
    }
    const reply = vi.fn(async () => ({ success: true, data: { replied: true } }))
    const registry = new TypedToolRegistry()
    for (const tool of createWeChatOutboundRegisteredTools({ send: { name: 'wechat_send', execute: vi.fn() } as never, reply: { name: 'wechat_reply', execute: reply } as never })) registry.register(tool)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => context as never, resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['wechat_reply'])
    const phases: string[] = []
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
      phases.push(binding.phase)
      return binding.phase === 'initial-compat'
        ? { kind: 'ask', confirmationId: 'confirm-wechat', answerer: 'user', reasonCode: 'remote-reply' }
        : { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } } })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'reply-sdk-1', toolName: 'wechat_reply', input: { text: 'approved reply' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'not sent' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'fake', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()

    await expect(runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'reply to this message' }], maxTokens: 50, tools: [{ name: 'wechat_reply', description: 'reply', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution,
      confirmation: async () => { context.remoteContext.messageId = 'replacement-message'; return { kind: 'approved', receipt: 'confirmed-1' } },
      maxModelTurns: 2, history
    })).rejects.toThrow('WECHAT_OUTBOUND_PREPARED_BINDING_CHANGED')

    // Prepared identity validation rejects before the safety-policy recheck can authorize a changed recipient.
    expect(phases).toEqual(['initial-compat'])
    expect(providerCalls).toBe(1)
    expect(reply).not.toHaveBeenCalled()
    expect((await history.read(invocationId)).events).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool-call-started' })]))
  })

  it('refreshes invocation runtime context at confirmation recheck while retaining gate-issued structural permits', async () => {
    const callInput = { path: 'note.txt' }
    const identity = { invocationId, toolCallId: 'refresh-context', toolName: 'read_file', input: callInput }
    const registry = new TypedToolRegistry()
    const execute = vi.fn(async (_input: Record<string, unknown>, context: { runtimeContext?: Record<string, unknown> }) => ({ success: true, data: context.runtimeContext }))
    registry.register(definePlannedTool({ name: 'read_file', parseInput: (raw) => raw as typeof callInput, plan: async (value) => value, execute }))
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ workDir: '/workspace/initial', toolUserConfirmed: false }),
      refreshExecutionContext: (_call, stage, current) => {
        expect(stage).toEqual({ kind: 'recheck', confirmation: { receipt: 'approved' } })
        current.readExecutionPermit = 'mutated-in-place'
        return { workDir: '/workspace/current', toolUserConfirmed: true, readExecutionPermit: 'spoofed-replacement' }
      },
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const structuralPermit = { permitId: 'read-permit-bound-to-initial-gate' }
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['read_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => {
        if (binding.phase === 'initial-compat') tools.updateExecutionContext(identity, (context) => { context.readExecutionPermit = structuralPermit })
        return binding.phase === 'initial-compat'
          ? { kind: 'ask', confirmationId: 'confirm-read', answerer: 'user', reasonCode: 'human-confirm' }
          : { kind: 'allow', authorizationVersion: binding.authorizationVersion }
      } }
    })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: identity.toolCallId, toolName: identity.toolName, input: callInput },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => responses.shift()! })

    await runAgentTurn({ registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'read note' }], maxTokens: 20 }, safetyGate,
      prepareTool: tools.prepareTool, toolExecution: tools.toolExecution, confirmation: async () => ({ kind: 'approved', receipt: 'approved' }), maxModelTurns: 2
    })

    expect(execute).toHaveBeenCalledWith(callInput, expect.objectContaining({ runtimeContext: expect.objectContaining({
      workDir: '/workspace/current', toolUserConfirmed: true, readExecutionPermit: structuralPermit
    }) }))
  })

  it('initial policy may attach invocation-private structural permits before fresh recheck', async () => {
    const events: string[] = []
    const registry = new TypedToolRegistry()
    const executor = { name: 'read_file', execute: async (_input: Record<string, unknown>, context: { readExecutionPermit?: unknown }) => {
      events.push(`execute:${Boolean(context.readExecutionPermit)}`)
      return { success: true, data: { text: 'ok' } }
    } }
    registry.register(createReadRegisteredTools({ readFile: executor as never, listDirectory: executor as never, grep: executor as never, readFeishuAttachment: executor as never })[0]!)
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      createExecutionContext: () => ({ workDir: '/workspace', requestId }),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'read-after-gate', toolName: 'read_file', input: { path: 'note.txt' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => responses.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['read_file'])
    const structuralPermit = buildReadExecutionPermit({ requestId, toolUseId: 'read-after-gate', toolName: 'read_file', input: { path: 'note.txt' }, facts: [
      { factId: 'read-fact', decisionRuleId: 'read-workdir-allow', normalizedPath: '/workspace/note.txt', zone: 'workdir-normal', targetKind: 'file' }
    ] })
    const permitHandoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: tools.updateExecutionContext })
    const gateArgs = { toolName: 'read_file', toolInput: { path: 'note.txt' }, sessionId: 'session-read', workDir: '/workspace', userDataDir: '/tmp', effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} }, requestId, toolUseId: 'read-after-gate' } as never
    const gateResult = { decision: { type: 'auto-allow', ruleId: 'read-workdir-allow', reason: 'workspace read' }, facts: {}, approvedFactIds: [], readExecutionPermit: structuralPermit }
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
      if (binding.phase === 'initial-compat') await permitHandoff.onInitialGateResult?.(binding, gateResult as never, gateArgs)
      return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } } })
    await runAgentTurn({ registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'read note' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution,
      history: new MemoryHistory(), maxModelTurns: 2 })
    expect(events).toEqual(['execute:true'])
  })

  it('write RegisteredTool binds a gate-issued permit after planning and rejects no-permit dispatch', async () => {
    const events: string[] = []
    const registry = new TypedToolRegistry()
    const input = { path: '/workspace/note.txt', content: 'saved' }
    const executor = { name: 'write_file', execute: async (_input: Record<string, unknown>, context: { writeExecutionPermit?: unknown }) => {
      events.push(`execute:${Boolean(context.writeExecutionPermit)}`)
      return { success: true, data: { saved: true } }
    } }
    registry.register(createWriteFileRegisteredTools({ writeFile: executor as never, editFile: executor as never })[0]!)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ workDir: '/workspace', requestId }), resolveAuthorizationVersion: () => 'policy-v1'
    })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'write-after-gate', toolName: 'write_file', input },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => responses.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const permitHandoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: tools.updateExecutionContext })
    const gateArgs = { toolName: 'write_file', toolInput: input, sessionId: 'session-write', workDir: '/workspace', userDataDir: '/tmp', effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} }, requestId, toolUseId: 'write-after-gate' } as never
    const gateResult = { decision: { type: 'auto-allow', ruleId: 'write-workdir-allow', reason: 'workspace write' }, facts: {}, approvedFactIds: [], writePathFact: { rawPath: input.path, normalizedPath: input.path, zone: 'workdir-normal' as const, targetKind: 'missing' as const, parentReal: '/workspace', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 2 } } }
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
      if (binding.phase === 'initial-compat') await permitHandoff.onInitialGateResult?.(binding, gateResult as never, gateArgs)
      return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } } })
    await runAgentTurn({ registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'write note' }], maxTokens: 50 }, safetyGate,
      prepareTool: tools.prepareTool, toolExecution: tools.toolExecution, history: new MemoryHistory(), maxModelTurns: 2 })
    expect(events).toEqual(['execute:true'])
  })

  it('structural read and write adapters reject recheck if the gate supplied no permit', async () => {
    const input = { path: '/workspace/note.txt', content: 'saved' }
    const executor = { name: 'tool', execute: vi.fn(async () => ({ success: true })) }
    const readTool = createReadRegisteredTools({ readFile: executor as never, listDirectory: executor as never, grep: executor as never, readFeishuAttachment: executor as never })[0]!
    const writeTool = createWriteFileRegisteredTools({ writeFile: executor as never, editFile: executor as never })[0]!
    for (const [tool, toolName, expected] of [[readTool, 'read_file', 'read-permit-missing'], [writeTool, 'write_file', 'write-permit-missing']] as const) {
      const handle = await tool.begin(input, { requestId, toolUseId: `missing-${toolName}`, signal: new AbortController().signal, executionContext: { workDir: '/workspace' } as never })
      handle.awaitConfirmation()
      handle.confirm()
      handle.beginValidation()
      await expect(handle.validatePrepared({
        requestId, toolUseId: `missing-${toolName}`, toolName,
        runtimeContext: { workDir: '/workspace' }, signal: new AbortController().signal
      } as never)).rejects.toThrow(expected)
      handle.fail()
      handle.release()
    }
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('在每次结果投影时解析当前 workspace root，而不是复用初始目录快照', async () => {
    const currentWorkDir = { value: '/workspace/old' }
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'run_shell', parseInput: (raw) => raw as Record<string, unknown>, plan: async (value) => value,
      execute: async () => { currentWorkDir.value = '/workspace/new'; return { success: true, data: { cwd: '/workspace/new/project', status: 'succeeded' } } }
    }))
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ workDir: currentWorkDir.value } as never),
      resolveAuthorizationVersion: () => 'policy-v1',
      workspaceRoot: '/workspace/old',
      resolveWorkspaceRoot: () => currentWorkDir.value
    })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'cwd-projection', toolName: 'run_shell', input: { command: 'pwd' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => responses.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_shell'])
    const history = new MemoryHistory()
    await runAgentTurn({ registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'run pwd' }], maxTokens: 50 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: tools.prepareTool, toolExecution: tools.toolExecution, history, maxModelTurns: 2 })
    const result = (await history.read(invocationId)).events.find((event) => event.kind === 'tool-call-finished')?.payload
    expect(result).toMatchObject({
      result: { data: { cwd: 'project', status: 'succeeded' } },
      replayContent: expect.stringContaining('"cwd":"project"')
    })
  })

  it('resolves provider-visible aliases to the registered internal tool while preserving call identity', async () => {
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'lookup.internal', parseInput: (raw) => raw as { path: string }, plan: async (input) => input, execute: async () => 'ok' }))
    const permits = new InMemorySafetyPermitStore()
    const executionContext = { workDir: '/workspace' }
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => executionContext as never,
      resolveAuthorizationVersion: async () => 'policy-v1'
    })
    const call = { invocationId, toolCallId: 'alias-1', toolName: 'lookup_internal', input: { path: 'a.txt' } }

    const binding = await tools.prepareTool(call, { kind: 'initial' })

    expect(binding).toMatchObject({ capabilityId: 'lookup_internal', toolCallId: 'alias-1' })
    tools.updateExecutionContext({ ...call, toolName: 'lookup.internal' }, (context) => { context.policyDecision = 'allow' })
    expect(executionContext).toMatchObject({ policyDecision: 'allow' })
    expect(() => tools.updateExecutionContext({ ...call, input: { path: 'other.txt' }, toolName: 'lookup.internal' }, () => undefined)).toThrow('PREPARED_CALL_MISMATCH')
    expect(() => tools.discardPreparedTool(call)).not.toThrow()
  })

  it('SDK 在 not-dispatched 后释放 planned handle，允许同一 call identity 在新 turn 重试', async () => {
    let denied = true
    const registry = new TypedToolRegistry()
    const execute = vi.fn(async () => ({ success: true }))
    registry.register(definePlannedTool({ name: 'write_file', parseInput: (raw) => raw as { path: string }, plan: async (input) => input, execute }))
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ workDir: '/workspace' } as never),
      resolveAuthorizationVersion: async () => 'policy-material-v1'
    })
    const providers = new ModelProviderRegistry()
    providers.register(route, { providerId: 'fake', stream: () => {
      return execute.mock.calls.length > 0
        ? stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
        : stream({ type: 'tool-call', toolCallId: 'retry-same-id', toolName: 'write_file', input: { path: 'note.txt' } },
            { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => denied && binding.phase === 'initial-compat'
        ? { kind: 'deny', reasonCode: 'POLICY_DENY' }
        : { kind: 'allow', authorizationVersion: binding.authorizationVersion } }
    })
    const run = () => runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'write note' }], maxTokens: 100 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool, toolExecution: tools.toolExecution,
      maxModelTurns: 2
    })

    await expect(run()).rejects.toThrow()
    denied = false
    await expect(run()).resolves.toMatchObject({ modelTurns: 2 })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('production RegisteredTool 单次 plan/execute 经 SDK History 提交，并按同一顺序重建下一轮 transcript', async () => {
    const counts = { plan: 0, validate: 0, execute: 0 }
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'write_file', parseInput: (raw) => raw as { path: string },
      plan: async (input) => { counts.plan += 1; return input },
      validate: async () => { counts.validate += 1 },
      execute: async () => { counts.execute += 1; return { success: true, data: { written: true } } }
    }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      createExecutionContext: () => ({ workDir: '/workspace' } as never),
      resolveAuthorizationVersion: async () => 'policy-material-v1',
      mapExecutionResult: (result) => ({ output: result })
    })
    const history = new MemoryHistory()
    const providers = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'write-once', toolName: 'write_file', input: { path: 'note.txt' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'saved' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let modelRequestCount = 0
    let secondRequest: readonly unknown[] = []
    providers.register(route, { providerId: 'fake', stream: (call) => {
      modelRequestCount += 1
      if (modelRequestCount === 2) secondRequest = call.request.messages
      return rounds.shift()!
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) }
    })

    await runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'save note' }], maxTokens: 100 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution,
      history,
      maxModelTurns: 2
    })

    const snapshot = await history.read(invocationId)
    const rebuilt = toCanonicalModelMessages(rebuildClaudeMessagesFromHistory(snapshot.events)).slice(0, -1)
    expect(counts).toEqual({ plan: 1, validate: 2, execute: 1 })
    expect(secondRequest.map((message) => JSON.parse(JSON.stringify(message)))).toEqual(rebuilt.map((message) => JSON.parse(JSON.stringify(message))))
    expect(secondRequest).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'write-once', name: 'write_file' })] }),
      expect.objectContaining({ role: 'tool', toolCallId: 'write-once' })
    ]))
    expect(admission.executorEntries).toBe(1)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
  })

  it('以 SDK turn lifecycle 驱动真实 RegisteredTool plan、recheck validation 与 permit-bound execute', async () => {
    const events: string[] = []
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'write_file',
      parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => { events.push('plan'); return { ...input, canonicalPath: `/workspace/${input.path}` } },
      facts: (plan) => ({ target: plan.canonicalPath }),
      validate: async (plan) => { events.push(`validate:${plan.canonicalPath}`) },
      execute: async (plan, context) => { events.push(`execute:${plan.canonicalPath}:${context.signal.aborted}`); return { success: true, data: { saved: true, apiKey: 'sk-abcdefghijklmnop' } } }
    }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry,
      permits, admission,
      createExecutionContext: () => ({ workDir: '/workspace' } as never),
      resolveAuthorizationVersion: async () => 'policy-material-v1'
    })
    const providers = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'write_file', input: { path: 'note.txt', content: 'hello' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'saved' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => { events.push(`gate:${binding.phase}`); return { kind: 'allow', authorizationVersion: binding.authorizationVersion } } }
    })
    const history = new MemoryHistory()

    const result = await runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'save a note' }], maxTokens: 100 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution, history,
      maxModelTurns: 2
    })

    expect(result.text).toBe('saved')
    expect(events).toEqual([
      'plan', 'gate:initial-compat', 'validate:/workspace/note.txt', 'gate:recheck', 'validate:/workspace/note.txt',
      'execute:/workspace/note.txt:false'
    ])
    expect(admission.executorEntries).toBe(1)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    const finished = (await history.read(invocationId)).events.find((event) => event.kind === 'tool-call-finished')
    expect(finished?.payload).toMatchObject({
      result: { success: true, data: { saved: true, apiKey: '<secret:redacted>' } },
      replayContent: '{"ok":true,"data":{"saved":true,"apiKey":"<secret:redacted>"}}',
      isError: false
    })
  })

  it('未获批准或复检拒绝时不进入 registered executor', async () => {
    const execute = vi.fn(async () => 'must not execute')
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', parseInput: (raw) => raw as { path: string }, plan: async (input) => input, execute }))
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({} as never), resolveAuthorizationVersion: async () => 'policy-material-v1'
    })
    const providers = new ModelProviderRegistry()
    providers.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tool-2', toolName: 'write_file', input: { path: 'blocked.txt' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => binding.phase === 'recheck'
        ? { kind: 'deny', reasonCode: 'POLICY_DENY' }
        : { kind: 'allow', authorizationVersion: binding.authorizationVersion } }
    })

    await expect(runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'save' }], maxTokens: 100 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution,
      maxModelTurns: 2
    })).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects executor input that differs from the canonical prepared invocation before permit consumption', async () => {
    const execute = vi.fn(async () => ({ success: true, data: 'must not execute' }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string }, plan: async (input) => input, execute
    }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      createExecutionContext: () => ({} as never), resolveAuthorizationVersion: () => 'policy-v1'
    })
    const call = { invocationId, toolCallId: 'canonical-input-binding', toolName: 'lookup', input: { query: 'approved query' } }
    const initial = await tools.prepareTool(call, { kind: 'initial' })
    expect(initial.phase).toBe('initial-compat')
    const rechecked = await tools.prepareTool(call, { kind: 'recheck' })
    expect(rechecked).toMatchObject({ phase: 'recheck', inputSnapshotHash: expect.any(String) })
    const permitId = permits.issue(rechecked, Date.now() + 10_000)

    await expect(tools.toolExecution.execute({ ...call, input: { query: 'tampered query' } }, permitId))
      .rejects.toThrow('PREPARED_CALL_MISMATCH')

    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    await expect(permits.consume(permitId, rechecked)).resolves.toEqual({ ok: true })
  })

  it('SDK 用户确认 receipt 绑定到同一个 planned handle 后才 dispatch', async () => {
    const events: string[] = []
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({
      name: 'write_file', parseInput: (raw) => raw as { path: string },
      plan: async (input) => { events.push('plan'); return input },
      validate: async () => { events.push('validate') },
      execute: async () => { events.push('execute'); return 'written' }
    }))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      createExecutionContext: () => ({} as never), resolveAuthorizationVersion: async () => 'policy-material-v1'
    })
    const providers = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'tool-approval', toolName: 'write_file', input: { path: 'approved.txt' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
        ? { kind: 'ask', confirmationId: 'confirm-1', answerer: 'user', reasonCode: 'write-policy' }
        : { kind: 'allow', authorizationVersion: binding.authorizationVersion } }
    })

    await runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'write file' }], maxTokens: 100 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution, maxModelTurns: 2,
      confirmation: async ({ confirmationId }) => {
        events.push(`confirm:${confirmationId}`)
        return { kind: 'approved', receipt: 'receipt-1' }
      }
    })
    expect(events).toEqual(['plan', 'confirm:confirm-1', 'validate', 'validate', 'execute'])
    expect(admission.executorEntries).toBe(1)
  })

  it('宿主撤权事件会经 SDK dispatch lease 到达 planned executor', async () => {
    const registry = new TypedToolRegistry()
    let executorSignal!: AbortSignal
    registry.register(definePlannedTool({
      name: 'write_file', parseInput: (raw) => raw as { path: string }, plan: async (input) => input,
      execute: async (_plan, context) => {
        executorSignal = context.signal
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
        return 'finished after revoke'
      }
    }))
    const listeners = new Set<(event: { requestId: string; executionId: string; lane: string; toolName: string }) => void>()
    let revoked = false
    const toolRevocations: AgentToolRevocationPort = {
      getRegisteredTool: () => undefined,
      isToolRevoked: () => revoked,
      onRevocation: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    }
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      createExecutionContext: () => ({} as never), resolveAuthorizationVersion: async () => 'policy-material-v1',
      toolRevocations
    })
    const providers = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'tool-revoke', toolName: 'write_file', input: { path: 'revoked.txt' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({
      capabilities, permitStore: permits,
      policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) }
    })
    const history = new MemoryHistory()

    const runningTurn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'write' }], maxTokens: 100 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })
    await vi.waitFor(() => expect(executorSignal).toBeDefined())
    for (const listener of [...listeners]) listener({ requestId, executionId: turnId, lane: 'desktop', toolName: 'different-tool' })
    expect(executorSignal.aborted).toBe(false)
    revoked = true
    for (const listener of [...listeners]) listener({ requestId, executionId: turnId, lane: 'desktop', toolName: 'write_file' })
    expect(executorSignal.aborted).toBe(true)
    await expect(runningTurn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    expect(listeners.size).toBe(0)
    const events = (await history.read(invocationId)).events
    expect(events.some((event) => event.kind === 'tool-call-finished')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
  })

  it('Hosted WeChat send executor 收到 claim 后撤权 signal，记录失败结果并释放 lease', async () => {
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'wechat', turnId)
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    let executorSignal!: AbortSignal
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const send = vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
      executorSignal = context.signal
      markEntered()
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'WECHAT_CANCELLED' }
    })
    const registry = new TypedToolRegistry()
    const [sendTool] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: send } as never,
      reply: { name: 'wechat_reply', execute: vi.fn() } as never
    })
    registry.register(sendTool!)
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: (call) => ({
        workDir: '/workspace', userDataDir: '/user-data', sessionId: 'wechat-session', requestId,
        toolUseId: call.toolCallId, signal: call.signal, lane: 'wechat',
        wechatConfig: { ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true },
        remoteContext: { source: 'wechat', messageId: 'inbound-1', userId: 'owner-1', authOwner: 'owner-1', authorizationGeneration: 1 }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1',
      toolRevocations: {
        registerToolRevocationRequest: revocations.registerToolRevocationRequest.bind(revocations),
        revokeToolForLane: revocations.revokeToolForLane.bind(revocations),
        revokeToolForAllLanes: revocations.revokeToolForAllLanes.bind(revocations),
        isToolRevoked: revocations.isToolRevoked.bind(revocations),
        clearToolRevocationRequest: revocations.clearToolRevocationRequest.bind(revocations),
        onRevocation: revocations.onRevocation.bind(revocations),
        getRegisteredTool: (name) => registry.get(name)
      }
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['wechat_send'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } })
    const providers = new ModelProviderRegistry()
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'hosted-wechat-send-revoke', toolName: 'wechat_send', input: { userId: 'friend-1', text: 'hello' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: '发送已取消。' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'fake-wechat', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: '发送 hello' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, toolExecution: tools.toolExecution,
      resourceLocks: new ResourceLockRegistry(), maxModelTurns: 2, history
    })

    await entered
    expect(executorSignal.aborted).toBe(false)
    expect(revocations.revokeToolForLane('wechat', 'wechat_send')).toBe(1)
    expect(executorSignal.aborted).toBe(true)
    await expect(running).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    const events = (await history.read(invocationId)).events
    expect(events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'hosted-wechat-send-revoke' })
    expect(events.some((event) => event.kind === 'tool-call-finished')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
  })

  it('Hosted run_script 进程执行中撤权时以 unknown-after-dispatch 收尾', async () => {
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop', turnId)
    let executionSignal!: AbortSignal
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const runScript = vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
      executionSignal = context.signal
      markEntered()
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'SCRIPT_CANCELLED' }
    })
    const registry = new TypedToolRegistry()
    registry.register(createRunScriptRegisteredTool({ name: 'run_script', execute: runScript } as never))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: (call) => ({
        workDir: '/workspace', userDataDir: '/user-data', requestId, toolUseId: call.toolCallId,
        signal: call.signal, toolsConfig: { scriptTimeout: 30, pythonPath: 'python' }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_script'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'run-script-unknown', stream: () => {
      providerCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'script-unknown-call', toolName: 'run_script', input: { language: 'python', code: 'write_file_side_effect()' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'run this script' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await entered
    expect(executionSignal.aborted).toBe(false)
    expect(revocations.revokeToolForLane('desktop', 'run_script')).toBe(1)
    expect(executionSignal.aborted).toBe(true)
    await expect(running).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    const events = (await history.read(invocationId)).events
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    expect(providerCalls).toBe(1)
    expect(runScript).toHaveBeenCalledOnce()
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
  })

  it('运行中工具取消按 session、turn、toolCall 身份中止 SDK 执行租约', async () => {
    const sessionId = 'cancel-session'
    const activeTurnId = 'cancel-turn'
    const activeToolCallId = 'script-cancel-call'
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    let executionSignal!: AbortSignal
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const runScript = vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
      executionSignal = context.signal
      markEntered()
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'SCRIPT_CANCELLED' }
    })
    const registry = new TypedToolRegistry()
    registry.register(createRunScriptRegisteredTool({ name: 'run_script', execute: runScript } as never))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId: activeTurnId, registry, permits, admission,
      createExecutionContext: (call) => ({
        workDir: '/workspace', userDataDir: '/user-data', requestId, toolUseId: call.toolCallId,
        signal: call.signal, sessionId, toolsConfig: { scriptTimeout: 30, pythonPath: 'python' }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1',
      registerActiveCancellation: (call, cancel) => import('../activeAgentToolCancellation').then(({ registerActiveAgentToolCancellation }) =>
        registerActiveAgentToolCancellation(sessionId, activeTurnId, call.toolCallId, cancel))
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_script'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    providers.register(route, { providerId: 'run-script-cancel', stream: () => stream(
      { type: 'tool-call', toolCallId: activeToolCallId, toolName: 'run_script', input: { language: 'python', code: 'wait()' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId: activeTurnId,
      request: { messages: [{ role: 'user', content: 'run script' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await entered
    expect(executionSignal.aborted).toBe(false)
    expect(cancelActiveAgentTool('other-session', activeTurnId, activeToolCallId)).toBe(false)
    expect(cancelActiveAgentTool(sessionId, 'other-turn', activeToolCallId)).toBe(false)
    expect(executionSignal.aborted).toBe(false)
    expect(cancelActiveAgentTool(sessionId, activeTurnId, activeToolCallId)).toBe(true)
    expect(executionSignal.aborted).toBe(true)
    await expect(running).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(runScript).toHaveBeenCalledOnce()
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    expect(cancelActiveAgentTool(sessionId, activeTurnId, activeToolCallId)).toBe(false)
  })

  it('获批后、dispatch claim 前取消会阻止脚本进入 executor', async () => {
    const sessionId = 'pre-dispatch-cancel-session'
    const activeTurnId = 'pre-dispatch-cancel-turn'
    const activeToolCallId = 'pre-dispatch-script-call'
    let finishRecheck!: () => void
    let markRecheckStarted!: () => void
    const recheckStarted = new Promise<void>((resolve) => { markRecheckStarted = resolve })
    const recheckBarrier = new Promise<void>((resolve) => { finishRecheck = resolve })
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const runScript = vi.fn(async () => ({ success: true, data: 'script ran' }))
    const registry = new TypedToolRegistry()
    registry.register(createRunScriptRegisteredTool({ name: 'run_script', execute: runScript } as never))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId: activeTurnId, registry, permits, admission,
      createExecutionContext: (call) => ({
        workDir: '/workspace', userDataDir: '/user-data', requestId, toolUseId: call.toolCallId,
        signal: call.signal, sessionId, toolsConfig: { scriptTimeout: 30, pythonPath: 'python' }
      } as never),
      resolveAuthorizationVersion: async (_call, stage) => {
        if (stage.kind === 'recheck') { markRecheckStarted(); await recheckBarrier }
        return 'policy-v1'
      },
      registerActiveCancellation: (call, cancel) => registerActiveAgentToolCancellation(sessionId, activeTurnId, call.toolCallId, cancel)
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_script'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => binding.phase === 'initial-compat'
        ? { kind: 'ask', confirmationId: 'script-approval', answerer: 'user', reasonCode: 'script-confirm' }
        : { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } })
    const providers = new ModelProviderRegistry()
    providers.register(route, { providerId: 'pre-dispatch-run-script-cancel', stream: () => stream(
      { type: 'tool-call', toolCallId: activeToolCallId, toolName: 'run_script', input: { language: 'python', code: 'print("must not run")' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId: activeTurnId,
      request: { messages: [{ role: 'user', content: 'run script' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      confirmation: async () => ({ kind: 'approved', receipt: 'script-approved', cause: 'user-approved' }),
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await recheckStarted
    expect(cancelActiveAgentTool(sessionId, activeTurnId, activeToolCallId)).toBe(true)
    finishRecheck()
    await expect(running).rejects.toMatchObject({ name: 'AgentTurnCancelledError' })
    expect(runScript).not.toHaveBeenCalled()
    const events = (await history.read(invocationId)).events
    expect(events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId: activeToolCallId, reason: 'REQUEST_CANCELLED' })
    expect(events.some((event) => event.kind === 'tool-call-started' && event.payload.toolCallId === activeToolCallId)).toBe(false)
  })

  it('recheck 失败会释放 prepared tool 的取消登记', async () => {
    const sessionId = 'failed-recheck-session'
    const activeTurnId = 'failed-recheck-turn'
    const activeToolCallId = 'failed-recheck-tool'
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'test-tool', parseInput: (raw) => raw, plan: async (input) => input, execute: async () => 'unused' }))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId: activeTurnId, registry, permits: new InMemorySafetyPermitStore(), admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({}),
      resolveAuthorizationVersion: (_call, stage) => {
        if (stage.kind === 'recheck') throw new Error('RECHECK_FAIL')
        return 'policy-v1'
      },
      registerActiveCancellation: (call, cancel) => registerActiveAgentToolCancellation(sessionId, activeTurnId, call.toolCallId, cancel)
    })
    const call = { invocationId, toolCallId: activeToolCallId, toolName: 'test-tool', input: {} }
    await tools.prepareTool(call, { kind: 'initial' })
    expect(cancelActiveAgentTool(sessionId, activeTurnId, activeToolCallId)).toBe(true)

    await expect(tools.prepareTool(call, { kind: 'recheck', confirmation: { receipt: 'approved' } })).rejects.toThrow('RECHECK_FAIL')

    expect(cancelActiveAgentTool(sessionId, activeTurnId, activeToolCallId)).toBe(false)
    tools.discardPreparedTool(call)
  })

  it('Hosted run_script 超时后以 unknown-after-dispatch 收尾且不再次请求模型', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-script-timeout-')))
    const markerPath = path.join(workDir, 'script-started.txt')
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop', turnId)
    const registry = new TypedToolRegistry()
    registry.register(createRunScriptRegisteredTool(runScriptExecutor))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission, toolRevocations: revocations,
      createExecutionContext: (call) => ({
        workDir, userDataDir: path.join(workDir, '.userdata'), requestId, toolUseId: call.toolCallId,
        sessionId: 'script-timeout-session', signal: call.signal, fileStateCache: new Map(),
        sendProgress: vi.fn(), toolsConfig: { scriptTimeout: 5, scriptInterpreterPaths: { javascript: process.execPath } }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_script'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'run-script-timeout', stream: () => {
      providerCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'script-timeout-call', toolName: 'run_script', input: {
          language: 'javascript',
          code: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'written'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)`,
          timeout: 1
        } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    try {
      const turn = runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: 'run a script with a one-second limit' }], maxTokens: 50 },
        safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
        toolExecution: tools.toolExecution, maxModelTurns: 2, history
      })

      await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      const events = (await history.read(invocationId)).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(await fs.readFile(markerPath, 'utf8')).toBe('written')
      expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  }, 20_000)

  it('Hosted run_shell 子进程启动后撤权时以 unknown-after-dispatch 收尾', async () => {
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop', turnId)
    let markSpawned!: () => void
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
    const registry = new TypedToolRegistry()
    registry.register(runShellRegisteredTool)
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission, toolRevocations: revocations,
      createExecutionContext: (call) => ({
        workDir: process.cwd(), userDataDir: '/private/tmp', requestId, toolUseId: call.toolCallId,
        sessionId: 'shell-session', signal: call.signal, fileStateCache: new Map(),
        sendProgress: (_status: string, payload?: unknown) => {
          if (payload && typeof payload === 'object' && 'processPid' in payload) markSpawned()
        },
        toolsConfig: {},
        shellConfig: { enabled: true, shellDefaultTimeoutSec: 60, maxInlineOutputBytes: 4096 }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_shell'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'run-shell-unknown', stream: () => {
      providerCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'shell-unknown-call', toolName: 'run_shell', input: {
          command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeout: 60
        } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'run a long command' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await spawned
    expect(revocations.revokeToolForLane('desktop', 'run_shell')).toBe(1)
    await expect(running).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    const events = (await history.read(invocationId)).events
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
  }, 20_000)

  it('Hosted run_shell 命令超时后以 unknown-after-dispatch 收尾且不再次请求模型', async () => {
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop', turnId)
    const registry = new TypedToolRegistry()
    registry.register(runShellRegisteredTool)
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission, toolRevocations: revocations,
      createExecutionContext: (call) => ({
        workDir: process.cwd(), userDataDir: '/private/tmp', requestId, toolUseId: call.toolCallId,
        sessionId: 'shell-timeout-session', signal: call.signal, fileStateCache: new Map(),
        sendProgress: vi.fn(), toolsConfig: {},
        shellConfig: { enabled: true, shellDefaultTimeoutSec: 10, maxInlineOutputBytes: 4096 }
      } as never),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_shell'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    let providerCalls = 0
    providers.register(route, { providerId: 'run-shell-timeout', stream: () => {
      providerCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'shell-timeout-call', toolName: 'run_shell', input: {
          command: process.platform === 'win32'
            ? 'Write-Output started; Start-Sleep -Seconds 5'
            : 'printf started; sleep 5',
          timeout: 1
        } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'run a command with a one-second limit' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    const events = (await history.read(invocationId)).events
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
  }, 20_000)

  it('Hosted write_file 原子 worker 丢失提交结果时以 unknown-after-dispatch 收尾', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-write-unknown-')))
    const userDataDir = path.join(workDir, '.userdata')
    await fs.mkdir(userDataDir)
    const toolCallId = 'write-unknown-call'
    const input = { path: 'maybe-written.txt', content: 'possibly committed' }
    const target = await probeWritePathFact({
      rawPath: input.path, workDir, userDataDir, homeDir: os.homedir(), customSensitivePrefixes: []
    })
    const permit = buildWriteExecutionPermit({
      requestId, toolUseId: toolCallId, toolName: 'write_file', input, target,
      decisionRuleId: 'confirmed-write', approval: 'confirmed'
    })
    const worker = vi.spyOn(directoryHandleWriterModule, 'writeFileAtomicallyBoundToDirectory')
      .mockResolvedValue({ ok: false, caseId: 'write-directory-cancelled' })
    try {
      const registry = new TypedToolRegistry()
      for (const tool of createWriteFileRegisteredTools({ writeFile: writeFileExecutor, editFile: editFileExecutor })) registry.register(tool)
      const permits = new InMemorySafetyPermitStore()
      const admission = new InMemoryExecutionAdmissionCoordinator()
      const tools = createRegisteredAgentTurnTools({
        requestId, turnId, registry, permits, admission,
        createExecutionContext: (call) => ({
          workDir, userDataDir, requestId, toolUseId: call.toolCallId, sessionId: 'write-session',
          sendProgress: vi.fn(), signal: call.signal ?? new AbortController().signal,
          fileStateCache: new FileStateCache(),
          toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
          writeExecutionPermit: permit
        } as never),
        resolveAuthorizationVersion: () => 'write-policy-v1'
      })
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, ['write_file'])
      const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
        evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
      } })
      const route = { routeId: 'write-unknown-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
      const providers = new ModelProviderRegistry()
      let providerCalls = 0
      providers.register(route, { providerId: 'write-unknown-provider', stream: () => {
        providerCalls += 1
        return stream(
          { type: 'tool-call', toolCallId, toolName: 'write_file', input },
          { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
        )
      } })
      const history = new MemoryHistory()
      const turn = runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: 'write the file' }], maxTokens: 50 },
        safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
        toolExecution: tools.toolExecution, maxModelTurns: 2, history
      })

      await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      const events = (await history.read(invocationId)).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(worker).toHaveBeenCalledOnce()
      expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    } finally {
      worker.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Hosted write_file 已提交后目标父目录身份漂移时以 unknown-after-dispatch 收尾', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-write-post-commit-drift-')))
    const userDataDir = path.join(workDir, '.userdata')
    const writeDir = path.join(workDir, 'write-target')
    const movedDir = path.join(workDir, 'write-target-moved')
    const replacementDir = path.join(workDir, 'replacement')
    await Promise.all([fs.mkdir(userDataDir), fs.mkdir(writeDir), fs.mkdir(replacementDir)])
    const toolCallId = 'write-post-commit-drift-call'
    const input = { path: 'write-target/maybe-written.txt', content: 'committed before identity drift' }
    const target = await probeWritePathFact({
      rawPath: input.path, workDir, userDataDir, homeDir: os.homedir(), customSensitivePrefixes: []
    })
    const permit = buildWriteExecutionPermit({
      requestId, toolUseId: toolCallId, toolName: 'write_file', input, target,
      decisionRuleId: 'confirmed-write', approval: 'confirmed'
    })
    const actualWrite = directoryHandleWriterModule.writeFileAtomicallyBoundToDirectory
    const worker = vi.spyOn(directoryHandleWriterModule, 'writeFileAtomicallyBoundToDirectory').mockImplementation(async (workerInput) => {
      const committed = await actualWrite(workerInput)
      await fs.rename(writeDir, movedDir)
      await fs.symlink(replacementDir, writeDir, 'dir')
      return committed
    })
    try {
      const registry = new TypedToolRegistry()
      for (const tool of createWriteFileRegisteredTools({ writeFile: writeFileExecutor, editFile: editFileExecutor })) registry.register(tool)
      const permits = new InMemorySafetyPermitStore()
      const admission = new InMemoryExecutionAdmissionCoordinator()
      const tools = createRegisteredAgentTurnTools({
        requestId, turnId, registry, permits, admission,
        createExecutionContext: (call) => ({
          workDir, userDataDir, requestId, toolUseId: call.toolCallId, sessionId: 'write-session',
          sendProgress: vi.fn(), signal: call.signal ?? new AbortController().signal,
          fileStateCache: new FileStateCache(),
          toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
          writeExecutionPermit: permit
        } as never),
        resolveAuthorizationVersion: () => 'write-policy-v1'
      })
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, ['write_file'])
      const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
        evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
      } })
      const providers = new ModelProviderRegistry()
      let providerCalls = 0
      providers.register(route, { providerId: 'write-post-commit-drift-provider', stream: () => {
        providerCalls += 1
        return stream(
          { type: 'tool-call', toolCallId, toolName: 'write_file', input },
          { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
        )
      } })
      const history = new MemoryHistory()
      const turn = runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: 'write the file' }], maxTokens: 50 },
        safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
        toolExecution: tools.toolExecution, maxModelTurns: 2, history
      })

      await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      const events = (await history.read(invocationId)).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(worker).toHaveBeenCalledOnce()
      expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
      expect(await fs.readFile(path.join(movedDir, 'maybe-written.txt'), 'utf8')).toBe(input.content)
    } finally {
      worker.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Hosted edit_file 原子 worker 丢失提交结果时以 unknown-after-dispatch 收尾', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-edit-unknown-')))
    const userDataDir = path.join(workDir, '.userdata')
    await fs.mkdir(userDataDir)
    await fs.writeFile(path.join(workDir, 'maybe-edited.txt'), 'before')
    const toolCallId = 'edit-unknown-call'
    const input = { path: 'maybe-edited.txt', old_string: 'before', new_string: 'possibly committed' }
    const cache = new FileStateCache()
    const editedFile = path.join(workDir, 'maybe-edited.txt')
    const editedStat = await fs.stat(editedFile)
    cache.set(editedFile, { path: editedFile, content: 'before', mtime: editedStat.mtimeMs, size: editedStat.size, readAt: Date.now(), isPartial: false })
    const target = await probeWritePathFact({
      rawPath: input.path, workDir, userDataDir, homeDir: os.homedir(), customSensitivePrefixes: []
    })
    const permit = buildWriteExecutionPermit({
      requestId, toolUseId: toolCallId, toolName: 'edit_file', input, target,
      decisionRuleId: 'confirmed-edit', approval: 'confirmed'
    })
    const worker = vi.spyOn(directoryHandleWriterModule, 'writeFileAtomicallyBoundToDirectory')
      .mockResolvedValue({ ok: false, caseId: 'write-directory-cancelled' })
    try {
      const registry = new TypedToolRegistry()
      for (const tool of createWriteFileRegisteredTools({ writeFile: writeFileExecutor, editFile: editFileExecutor })) registry.register(tool)
      const permits = new InMemorySafetyPermitStore()
      const admission = new InMemoryExecutionAdmissionCoordinator()
      const tools = createRegisteredAgentTurnTools({
        requestId, turnId, registry, permits, admission,
        createExecutionContext: (call) => ({
          workDir, userDataDir, requestId, toolUseId: call.toolCallId, sessionId: 'edit-session',
          sendProgress: vi.fn(), signal: call.signal ?? new AbortController().signal,
          fileStateCache: cache,
          toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
          writeExecutionPermit: permit
        } as never),
        resolveAuthorizationVersion: () => 'edit-policy-v1'
      })
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, ['edit_file'])
      const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
        evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
      } })
      const route = { routeId: 'edit-unknown-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
      const providers = new ModelProviderRegistry()
      let providerCalls = 0
      providers.register(route, { providerId: 'edit-unknown-provider', stream: () => {
        providerCalls += 1
        return stream(
          { type: 'tool-call', toolCallId, toolName: 'edit_file', input },
          { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
        )
      } })
      const history = new MemoryHistory()
      const turn = runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId,
        request: { messages: [{ role: 'user', content: 'edit the file' }], maxTokens: 50 },
        safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
        toolExecution: tools.toolExecution, maxModelTurns: 2, history
      })

      await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      const events = (await history.read(invocationId)).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(worker).toHaveBeenCalledOnce()
      expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    } finally {
      worker.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})
