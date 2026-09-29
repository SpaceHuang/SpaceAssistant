import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { appendMessage, createPersistedTurn, createSession, getPersistedTurn, openDatabase, setConfigValue, type AppDatabase } from './database'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { MODEL_BASELINE } from '../src/shared/modelBaseline'
import { createAgentRuntime } from './runtime/agentRuntime'
import { createDesktopAgentRuntime } from './runtime/desktopAgentRuntime'
import { ChatCancelRegistry } from './chatCancelRegistry'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from './tools/builtinExecutors'
import { readFileExecutor } from './tools/builtinExecutors'
import { listDirectoryExecutor } from './tools/builtinExecutors'
import { grepExecutor } from './tools/builtinExecutors'
import { editFileExecutor, writeFileExecutor } from './tools/builtinExecutors'
import { runScriptExecutor } from './tools/builtinExecutors'
import * as runShellExecutor from './tools/runShellExecutor'
import { browserExecutor } from './tools/browserExecutor'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { createDesktopAnthropicRouteProfile } from './piAiAnthropicBridge'
import { SqliteAgentHistory } from './runtime/sqliteAgentHistory'
import { getDbConnection } from './database'
import { runApprovalAgent } from './confirmation/approvalAgent'
import { PolicyAuthorizationChangeRegistry } from './runtime/policyAuthorizationChangeRegistry'
import { readPolicyPackages, writePolicyPackages } from './confirmation/policyRulesRuntime'
import { ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, getSessionEventSink, readSessionEvents } from './sessionEvents'
import { prepareToolConfirm, waitForToolConfirm } from './toolConfirmRegistry'
import { MCP_CONFIG_KEYS } from './mcp/mcpConfigStore'
import { McpConnectionManager } from './mcp/mcpConnectionManager'
import { registerMcpIpcHandlers } from './mcp/mcpIpc'
import { capabilityRegistry } from './capabilities/registry'
import { invalidateSkillsCache } from './skills/skillCache'
import { isTruncatedToolResultContent } from '../src/shared/oversizedToolResult'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/shared/toolResultLimits'
import { getUsageStepFactsForTurn, getUsageTurnFact } from './database/operations'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import { logAgentEvent } from './agentLogger/agentLogger'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const hostedRuntimeFailureInjection = vi.hoisted(() => ({ requestId: '', composeCalls: 0 }))
vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => true), decryptString: vi.fn((value: Buffer) => value.toString()) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
}))

let sessionEvents: Array<{ seq: number; time: number; type: string; payload: Record<string, unknown> }>
let failNextSessionEventType: string | undefined
let useRealSessionEventFiles = false
let injectedCompactionReplay: { committed: Array<{ compactionId: string; start: { type: 'compaction_start'; seq: number; payload: Record<string, unknown> }; summary: { type: 'compaction_summary'; seq: number; payload: Record<string, unknown> }; end: { type: 'compaction_end'; seq: number; payload: Record<string, unknown> } }>; rejected: Array<{ compactionId?: string; reason: string }> } | undefined
vi.mock('./sessionEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionEvents')>()
  return {
    ...actual,
    getSessionEventSink: (root: string, sessionId: string, createdAt: number) => {
      if (useRealSessionEventFiles) {
        const sink = actual.getSessionEventSink(root, sessionId, createdAt)
        return {
          appendChunk: (event) => sink.appendChunk(event),
          waitForCapacity: () => sink.waitForCapacity(),
          flush: () => sink.flush(),
          close: () => sink.close(),
          eventsPath: sink.eventsPath,
          indexPath: sink.indexPath,
          appendCritical: async (event: { type: string; payload: Record<string, unknown> }) => {
            if (failNextSessionEventType === event.type) {
              failNextSessionEventType = undefined
              throw new Error(`injected ${event.type} session event failure`)
            }
            return sink.appendCritical(event)
          }
        }
      }
      return {
        appendCritical: vi.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
          if (failNextSessionEventType === event.type) {
            failNextSessionEventType = undefined
            throw new Error(`injected ${event.type} session event failure`)
          }
          const committed = { seq: sessionEvents.length + 1, time: Date.now(), ...event }
          sessionEvents.push(committed)
          return committed
        }),
        appendChunk: vi.fn((event: { type: string; payload: Record<string, unknown> }) => { sessionEvents.push({ seq: sessionEvents.length + 1, time: Date.now(), ...event }) }),
        waitForCapacity: vi.fn(async () => undefined),
        flush: vi.fn(async () => ({ committedEvents: sessionEvents.length, seq: sessionEvents.length, pendingEvents: 0, pendingBytes: 0, failed: false, lostEvents: 0, lostBytes: 0, indexStale: false })),
        close: vi.fn(async () => ({ committedEvents: sessionEvents.length, seq: sessionEvents.length, pendingEvents: 0, pendingBytes: 0, failed: false, lostEvents: 0, lostBytes: 0, indexStale: false })),
        eventsPath: '/tmp/agent-sdk-hosted-integration.jsonl', indexPath: '/tmp/agent-sdk-hosted-integration.index.json'
      }
    },
    readCompactionMarkers: vi.fn(async () => []),
    readCompactionReplay: vi.fn(async () => injectedCompactionReplay ?? ({ committed: [], rejected: [] })),
    readSessionEvents: (...args: Parameters<typeof actual.readSessionEvents>) => useRealSessionEventFiles ? actual.readSessionEvents(...args) : Promise.resolve([]),
    appendCompactionTransaction: vi.fn(async () => undefined)
  }
})
vi.mock('./agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn() }))
vi.mock('./safeWebContentsSend', () => ({ safeWebContentsSend: vi.fn() }))
vi.mock('./toolConfirmRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./toolConfirmRegistry')>()),
  waitForToolConfirm: vi.fn(async () => 'approved')
}))
vi.mock('./confirmation/approvalAgent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/approvalAgent')>()
  return {
    ...actual,
    runApprovalAgent: vi.fn(async () => ({ ok: true, verdict: { kind: 'approve', reason: { summary: 'focused Hosted confirmation test' }, riskLevel: 'low', authorization: 'high' } }))
  }
})
vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: vi.fn(() => null) }
})
vi.mock('./runtime/invocationAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/invocationAssembler')>()
  return {
    ...actual,
    assembleInvocation: (...args: Parameters<typeof actual.assembleInvocation>) => {
      const assembled = actual.assembleInvocation(...args)
      if (args[0].requestId === hostedRuntimeFailureInjection.requestId) {
        assembled.agentSdk.createHostedTurnRuntime = () => {
          hostedRuntimeFailureInjection.composeCalls += 1
          throw new Error('Desktop complete-gate Runtime unavailable')
        }
      }
      return assembled
    }
  }
})

import { ipcMain } from 'electron'
import { registerClaudeStreamHandlers } from './claudeStreamHandlers'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function seedTrustedModel(db: AppDatabase, modelId: string): void {
    setConfigValue(db, 'config.models', JSON.stringify([
    { id: modelId, name: modelId, maximumContext: MODEL_BASELINE[modelId]!.maximumContext, maxTokens: MODEL_BASELINE[modelId]!.maxTokens, isDefault: false, isFast: false, isVision: false, enabled: true }
  ]))
  setConfigValue(db, 'config.llmServices', JSON.stringify([
    { id: 'svc-hosted', name: 'Hosted Test', baseUrl: 'https://hosted.example.test', supportedModelIds: [modelId], createdAt: '1', updatedAt: '1' }
  ]))
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['svc-hosted']))
  setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ 'svc-hosted': 'enc:test-key' }))
}

describe('claudeStreamHandlers Hosted production handoff', () => {
  let db: AppDatabase
  let runtime: ReturnType<typeof createAgentRuntime>
  let providerCalls: number
  let workDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(waitForToolConfirm).mockReset().mockResolvedValue('approved' as never)
    vi.mocked(runApprovalAgent).mockReset().mockResolvedValue({
      ok: true,
      verdict: { kind: 'approve', reason: { summary: 'focused Hosted confirmation test' }, riskLevel: 'low', authorization: 'high' }
    } as never)
    handlers.clear()
    sessionEvents = []
    failNextSessionEventType = undefined
    useRealSessionEventFiles = false
    injectedCompactionReplay = undefined
    providerCalls = 0
    hostedRuntimeFailureInjection.requestId = ''
    hostedRuntimeFailureInjection.composeCalls = 0
    workDir = ''
    resetDefaultAgentRuntimeForTests()
    db = openDatabase(':memory:')
  })

  afterEach(async () => {
    db.close()
    if (workDir) await fs.rm(workDir, { recursive: true, force: true })
    resetDefaultAgentRuntimeForTests()
  })

  it('runs the real Desktop loop through Hosted provider and persists canonical SQLite History', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-integration-'))
    await fs.mkdir(path.join(workDir, '.space-skills', 'hosted-reader'), { recursive: true })
    await fs.writeFile(path.join(workDir, '.space-skills', 'hosted-reader', 'SKILL.md'), '---\nname: hosted-reader\ndescription: Hosted caller test skill\n---\nRead through the real Desktop Hosted path.\n')
    await fs.writeFile(path.join(workDir, 'note.txt'), 'TDD hosted read result')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const modelProviders = runtime.modelProviders
    const providerRequests: Array<readonly unknown[]> = []
    modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-integration-fake',
      stream: async function* (input) {
        providerRequests.push(input.request.messages)
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'hosted-read-1', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        if (providerCalls === 2) {
          yield { type: 'tool-call', toolCallId: 'hosted-write-1', toolName: 'write_file', input: { path: 'created.txt', content: 'Hosted SDK write result' } } as const
          yield { type: 'usage', inputTokens: 5, outputTokens: 4 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        if (providerCalls === 3) {
          yield { type: 'tool-call', toolCallId: 'hosted-list-directory-1', toolName: 'list_directory', input: { path: '.' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        if (providerCalls === 4) {
          yield { type: 'tool-call', toolCallId: 'hosted-toolkit-find-1', toolName: 'toolkit_find', input: { query: 'env.agent' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        if (providerCalls === 5) {
          yield { type: 'tool-call', toolCallId: 'hosted-skills-read-1', toolName: 'skills_read', input: { name: 'hosted-reader' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        if (providerCalls === 6) {
          yield { type: 'tool-call', toolCallId: 'hosted-history-read-1', toolName: 'history_read', input: { query: 'hello hosted' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'Hosted desktop answer' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = modelProviders.register.bind(modelProviders)
    modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-integration', model: modelId, maxTokens: 512 })
    // A pre-migration session has legacy messages but no session-owned canonical History yet.
    appendMessage(db, { id: 'legacy-user', sessionId: session.id, role: 'user', content: 'legacy question', timestamp: 0, status: 'sent' })
    appendMessage(db, { id: 'legacy-assistant', sessionId: session.id, role: 'assistant', content: 'legacy answer', timestamp: 0.5, status: 'sent' })
    const user = appendMessage(db, { id: 'hosted-user', sessionId: session.id, role: 'user', content: 'hello hosted', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-turn', requestId: 'hosted-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })

    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 1, autoApproveMaxEditChars: 1 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const evaluateGateSpy = vi.spyOn(await import('./confirmation/toolCallGate'), 'evaluateToolCallGate')
    failNextSessionEventType = 'turn_end'
    const result = await execute(makeSender(), {
      requestId: 'hosted-request', turnId: 'hosted-turn', turnStartToken: 'hosted-start-token', sessionId: session.id
    })

    expect(result).toMatchObject({
      ok: true, eventPersistenceFailed: true, eventPersistenceErrors: [expect.objectContaining({ code: 'EVENT_PERSISTENCE_FAILED' })],
      content: [{ type: 'text', text: 'Hosted desktop answer' }],
      usage: { input_tokens: 28, output_tokens: 21, cacheSemantics: 'additive' }
    })
    expect(providerCalls).toBe(7)
    expect(JSON.stringify(providerRequests[0]?.find((message) => (message as { role?: string }).role === 'system'))).toContain('Simplified Chinese')
    expect(runApprovalAgent).toHaveBeenCalledOnce()
    expect(runApprovalAgent.mock.calls[0]?.[0]).toMatchObject({
      db, workDir, userDataDir: '/tmp', baseUrl: endpoint, credentialRef: 'llm-service:svc-hosted',
      maxAuthorization: 'high', policyRuleFloor: expect.any(Array)
    })
    expect(runApprovalAgent.mock.calls[0]?.[1]).toMatchObject({ lane: 'desktop', clue: { toolName: 'write_file' } })
    expect(evaluateGateSpy.mock.calls.map(([args]) => args).filter((args) =>
      args.toolUseId === 'hosted-read-1' || args.toolUseId === 'hosted-write-1'
    ).map(({ toolUseId, phase }) => [toolUseId, phase])).toEqual([
      ['hosted-read-1', 'initial'], ['hosted-read-1', 'recheck'],
      ['hosted-write-1', 'initial'], ['hosted-write-1', 'recheck']
    ])
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-request')
    expect(history.events.find((event) => event.kind === 'invocation-context-committed')?.payload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'legacy question' }),
        expect.objectContaining({ role: 'assistant', content: 'legacy answer' }),
        expect.objectContaining({ role: 'user', content: 'hello hosted' })
      ])
    })
    expect(history.events.map((event) => event.kind)).toEqual(expect.arrayContaining(['model-response-committed', 'tool-call-started', 'tool-call-finished', 'invocation-completed']))
    expect(history.events.filter((event) => event.kind === 'tool-call-finished').map((event) => event.payload.toolCallId)).toEqual([
      'hosted-read-1', 'hosted-write-1', 'hosted-list-directory-1', 'hosted-toolkit-find-1', 'hosted-skills-read-1', 'hosted-history-read-1'
    ])
    expect(history.events.filter((event) => event.kind === 'tool-call-finished').every((event) => event.payload.success === true)).toBe(true)
    expect(history.events.find((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === 'hosted-list-directory-1')?.payload).toMatchObject({
      result: { success: true, data: { entries: expect.arrayContaining([expect.objectContaining({ name: 'note.txt' }), expect.objectContaining({ name: 'created.txt' })]) } }
    })
    expect(history.events.find((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === 'hosted-toolkit-find-1')?.payload).toMatchObject({
      result: { success: true, data: { ok: true, matches: [expect.objectContaining({ id: 'env.agent' })] } }
    })
    expect(history.events.find((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === 'hosted-skills-read-1')?.payload).toMatchObject({
      result: { success: true, data: { name: 'hosted-reader', content: expect.stringContaining('Read through the real Desktop Hosted path.') } }
    })
    expect(history.events.find((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === 'hosted-history-read-1')?.payload).toMatchObject({
      result: { success: true, data: { entries: [expect.objectContaining({ text: 'hello hosted', sessionId: expect.any(String) })] } }
    })
    expect(history.events.filter((event) => event.kind === 'tool-call-finished').every((event) => {
      const ledger = event.payload.sessionLedger as { location?: unknown; stepId?: unknown; result?: unknown } | undefined
      return Boolean(ledger?.location && ledger.stepId && ledger.result)
    })).toBe(true)
    const toolProposals = history.events.filter((event) => event.kind === 'model-response-committed').flatMap((event) => {
      const ledger = event.payload.sessionLedger as { toolCalls?: Array<Record<string, unknown>> } | undefined
      return ledger?.toolCalls ?? []
    })
    const proposalStepIds = new Map(history.events.filter((event) => event.kind === 'model-response-committed').flatMap((event) => {
      const ledger = event.payload.sessionLedger as { stepId?: string; toolCalls?: Array<{ toolUseId: string }> } | undefined
      return (ledger?.stepId && ledger.toolCalls ? ledger.toolCalls.map((call) => [call.toolUseId, ledger.stepId!] as const) : [])
    }))
    expect(history.events.filter((event) => event.kind === 'tool-call-finished').every((event) => {
      const ledger = event.payload.sessionLedger as { stepId?: string } | undefined
      return ledger?.stepId === proposalStepIds.get(String(event.payload.toolCallId))
    })).toBe(true)
    expect(history.events.filter((event) => event.kind === 'model-response-committed').every((event) => {
      const ledger = event.payload.sessionLedger as { requestUsage?: Record<string, unknown> } | undefined
      return Boolean(ledger?.requestUsage && ledger.requestUsage.requestId && ledger.requestUsage.usage)
    })).toBe(true)
    expect(history.events.filter((event) => event.kind === 'model-response-committed').every((event) => {
      const ledger = event.payload.sessionLedger as { requestContext?: Record<string, unknown> } | undefined
      const context = ledger?.requestContext
      return Boolean(context && context.requestId === `hosted-request:round:${event.payload.modelTurn}` &&
        context.attempt === 1 && context.contextUsage && typeof context.contextUsage === 'object')
    })).toBe(true)
    expect(history.events.filter((event) => event.kind === 'model-response-committed' &&
      (event.payload.message as { toolCalls?: unknown[] } | undefined)?.toolCalls?.length).every((event) => {
      const ledger = event.payload.sessionLedger as { requestContext?: unknown; requestUsage?: unknown; toolCalls?: unknown[] } | undefined
      return Boolean(ledger?.requestContext && ledger.requestUsage && ledger.toolCalls?.length)
    })).toBe(true)
    const secondModelRequest = history.events.find((event) => event.kind === 'model-request-started' && event.payload.modelTurn === 2)
    const secondRequestLedger = secondModelRequest?.payload.sessionLedger as { requestContext?: Record<string, unknown>; requestHeader?: Record<string, unknown> } | undefined
    expect(secondRequestLedger?.requestContext).toMatchObject({
      requestId: 'hosted-request:round:2',
      contextUsage: { pressureTokens: expect.any(Number), projectedTokens: expect.any(Number), anchorStatus: 'matched' }
    })
    expect(secondRequestLedger?.requestHeader).toMatchObject({
      toolExecutionCheckpoint: { completedToolUseIds: ['hosted-read-1'], replayForbidden: false }
    })
    expect(toolProposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolUseId: 'hosted-read-1', name: 'read_file', args: { path: 'note.txt' } }),
      expect.objectContaining({ toolUseId: 'hosted-write-1', name: 'write_file', args: { path: 'created.txt', content: 'Hosted SDK write result' } }),
      expect.objectContaining({ toolUseId: 'hosted-list-directory-1', name: 'list_directory', args: { path: '.' } }),
      expect.objectContaining({ toolUseId: 'hosted-toolkit-find-1', name: 'toolkit_find', args: { query: 'env.agent' } }),
      expect.objectContaining({ toolUseId: 'hosted-skills-read-1', name: 'skills_read', args: { name: 'hosted-reader' } }),
      expect.objectContaining({ toolUseId: 'hosted-history-read-1', name: 'history_read', args: { query: 'hello hosted' } })
    ]))
    expect(history.events.some((event) => event.kind === 'tool-call-not-dispatched')).toBe(false)
    expect(sessionEvents.map((event) => event.type)).toEqual(expect.arrayContaining(['tool_call', 'tool_result']))
    expect(sessionEvents.map((event) => event.type)).not.toContain('turn_end')
    const recoveryHistory = new SqliteAgentHistory(getDbConnection(db))
    const repairInvocationTerminal = async (_location: { workDir: string; sessionId: string; createdAt: number }, terminal: Record<string, unknown>) => {
      const existing = sessionEvents.find((event) => event.type === 'turn_end' && event.payload.turnId === terminal.turnId)
      if (!existing) {
        sessionEvents.push({ seq: sessionEvents.length + 1, time: Date.now(), type: 'turn_end', payload: { turnId: terminal.turnId, reason: terminal.reason } })
      }
    }
    await recoveryHistory.recoverInterruptedInvocations({ repairInvocationTerminal })
    await recoveryHistory.recoverInterruptedInvocations({ repairInvocationTerminal })
    expect(sessionEvents.filter((event) => event.type === 'turn_end')).toEqual([
      expect.objectContaining({ payload: { turnId: 'hosted-turn', reason: 'completed' } })
    ])
    expect((await recoveryHistory.read('hosted-request'))?.events.at(-1)).toMatchObject({
      kind: 'invocation-completed', payload: { status: 'completed', sessionLedger: { turnId: 'hosted-turn', reason: 'completed' } }
    })
    const canonicalToolCalls = history.events
      .filter((event) => event.kind === 'model-response-committed')
      .flatMap((event) => ((event.payload.sessionLedger as { toolCalls?: Array<{ toolUseId: string; name: string; args: unknown }> } | undefined)?.toolCalls ?? []))
      .map(({ toolUseId, name, args }) => ({ toolUseId, name, args }))
    const projectedToolCalls = sessionEvents
      .filter((event) => event.type === 'tool_call')
      .map(({ payload }) => ({ toolUseId: payload.toolUseId, name: payload.name, args: payload.args }))
    expect(projectedToolCalls).toEqual(canonicalToolCalls)

    const canonicalToolResults = history.events
      .filter((event) => event.kind === 'tool-call-finished')
      .map((event) => ({ toolUseId: event.payload.toolCallId, result: (event.payload.sessionLedger as { result?: unknown } | undefined)?.result }))
    const projectedToolResults = sessionEvents
      .filter((event) => event.type === 'tool_result')
      .map(({ payload }) => ({ toolUseId: payload.toolUseId, result: payload.result }))
    expect(projectedToolResults).toEqual(canonicalToolResults)
    for (const toolCall of sessionEvents.filter((event) => event.type === 'tool_call')) {
      const toolResult = sessionEvents.find((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCall.payload.toolUseId)
      expect(toolResult?.payload.stepId).toBe(toolCall.payload.stepId)
    }
    await expect(fs.readFile(path.join(workDir, 'created.txt'), 'utf8')).resolves.toBe('Hosted SDK write result')
    evaluateGateSpy.mockRestore()
  })

  it('preserves Desktop auto-approved write audit and result metadata through Hosted execution', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-auto-approved-write-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({ modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext, maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-auto-approved-write-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'hosted-auto-approved-write', toolName: 'write_file', input: { path: 'auto.txt', content: 'hello' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'written' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-auto-approved-write', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-auto-approved-write-user', sessionId: session.id, role: 'user', content: 'write a short file', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-auto-approved-write-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'hosted-auto-approved-write-turn', requestId: 'hosted-auto-approved-write-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id, contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-auto-approved-write-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' } })
    const execute = registerClaudeStreamHandlers(ipcMain, { getApiKey: async () => 'test-key', getWorkDir: () => workDir,
      resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp', getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 100 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }), turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never })

    await expect(execute(makeSender(), { requestId: 'hosted-auto-approved-write-request', turnId: 'hosted-auto-approved-write-turn', turnStartToken: 'hosted-auto-approved-write-start', sessionId: session.id }))
      .resolves.toMatchObject({ ok: true, content: [{ type: 'text', text: 'written' }] })
    await expect(fs.readFile(path.join(workDir, 'auto.txt'), 'utf8')).resolves.toBe('hello')
    const resultEvent = sessionEvents.find((event) => event.type === 'tool_result' && event.payload.toolUseId === 'hosted-auto-approved-write')
    expect(resultEvent?.payload.result).toMatchObject({ decisionRuleId: expect.any(String),
      autoApprovedWrite: { path: 'auto.txt', added: expect.any(Number), removed: expect.any(Number), bytesWritten: 5 } })
    expect(vi.mocked(logAgentEvent).mock.calls).toContainEqual(['info', 'file.auto_approve', expect.objectContaining({
      requestId: 'hosted-auto-approved-write-request', sessionId: session.id, toolUseId: 'hosted-auto-approved-write', relPath: 'auto.txt', bytesWritten: 5
    })])
  })

  it('replays an oversized Desktop Hosted read result in bounded form while preserving the full tool result', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-oversized-result-'))
    const fullContent = 'head-' + 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 2_000) + '-tail'
    await fs.writeFile(path.join(workDir, 'large.txt'), fullContent)
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const modelRequests: Array<readonly unknown[]> = []
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-oversized-result',
      stream: async function* (input) {
        providerCalls += 1
        modelRequests.push(input.request.messages)
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'hosted-large-read', toolName: 'read_file', input: { path: 'large.txt', offset: 0, limit: 50_000 } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'large file read' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-oversized-result', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-large-user', sessionId: session.id, role: 'user', content: 'read large file', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-large-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-large-turn', requestId: 'hosted-large-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id, contextBoundarySequence: user.sequence,
      state: 'prepared', startToken: 'hosted-large-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 1 }), getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    await expect(execute(makeSender(), {
      requestId: 'hosted-large-request', turnId: 'hosted-large-turn', turnStartToken: 'hosted-large-start', sessionId: session.id
    })).resolves.toMatchObject({ ok: true, content: [{ type: 'text', text: 'large file read' }] })

    expect(providerCalls).toBe(2)
    const secondMessages = modelRequests[1] as Array<{ role: string; content?: unknown; isError?: boolean }>
    const replay = secondMessages.find((message) => message.role === 'tool')
    expect(replay?.content).toContain('tool_result truncated')
    expect(isTruncatedToolResultContent(replay?.content as string)).toBe(true)
    expect((replay?.content as string).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
    expect(replay?.content).toContain('-tail')
    const history = new SqliteAgentHistory(getDbConnection(db))
    const events = (await history.read('hosted-large-request')).events
    const finished = events.find((event) => event.kind === 'tool-call-finished')!
    expect(finished.payload).toMatchObject({
      toolCallId: 'hosted-large-read', replayContent: expect.stringContaining('tool_result truncated'),
      result: { success: true, data: { content: fullContent } }
    })
    expect(sessionEvents.find((event) => event.type === 'tool_result' && event.payload.toolUseId === 'hosted-large-read')?.payload.result)
      .toMatchObject({ success: true, data: { content: fullContent } })
  })

  it('compacts an over-budget Desktop Hosted response before finalizing canonical History', async () => {
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({ modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext, maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const requests: unknown[] = []
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-boundary-compaction-fixture',
      stream: async function* (input) {
        providerCalls += 1
        requests.push(input.request.messages)
        yield { type: 'text-delta', text: `accepted answer ${providerCalls} `.repeat(80) } as const
        yield { type: 'usage', inputTokens: 900_000, outputTokens: 8 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-boundary-compaction', model: modelId, maxTokens: MODEL_BASELINE[modelId]!.maxTokens })
    const priorUser = appendMessage(db, { id: 'boundary-prior-user', sessionId: session.id, role: 'user', content: 'older user context '.repeat(9000), timestamp: 0, status: 'sent' })
    appendMessage(db, { id: 'boundary-prior-assistant', sessionId: session.id, role: 'assistant', content: 'older assistant context '.repeat(9000), timestamp: 0.5, status: 'sent' })
    const user = appendMessage(db, { id: 'boundary-current-user', sessionId: session.id, role: 'user', content: 'current request must survive', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'boundary-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'boundary-turn', requestId: 'boundary-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'boundary-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: '', maximumContext: MODEL_BASELINE[modelId]!.maximumContext, maxTokens: MODEL_BASELINE[modelId]!.maxTokens, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => '/tmp', resolveWorkDirForSession: () => '/tmp', getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: ['read_file'] }), getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir: '/tmp' }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), { requestId: 'boundary-request', turnId: 'boundary-turn', turnStartToken: 'boundary-start-token', sessionId: session.id })

    expect(result).toMatchObject({ ok: true, content: expect.any(Array) })
    expect(providerCalls).toBe(1)
    expect(requests).toHaveLength(1)
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('boundary-request')
    const compacted = history.events.find((event) => event.kind === 'transcript-compacted')
    expect(compacted).toBeDefined()
    expect(compacted?.payload).toMatchObject({
      requiredUserMessage: { id: 'boundary-current-user', message: { role: 'user', content: 'current request must survive' } },
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('"kind":"context_checkpoint"') }),
        expect.objectContaining({ role: 'user', content: 'current request must survive' })
      ])
    })
    expect(history.events.at(-1)?.kind).toBe('invocation-completed')
    const sessionEventsModule = await import('./sessionEvents')
    expect(sessionEventsModule.appendCompactionTransaction).toHaveBeenCalledOnce()
    expect(sessionEventsModule.appendCompactionTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ windowId: session.id }), expect.objectContaining({ windowId: session.id, candidate: expect.objectContaining({ kind: 'summary' }) })
    )
  })

  it('compacts an over-budget initial Desktop request in Hosted SDK before provider dispatch', async () => {
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const contextWindow = 150_000
    const routeId = createDesktopAnthropicRouteProfile({ modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow, maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const requests: unknown[] = []
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-initial-preflight-fixture',
      stream: async function* (input) {
        requests.push(input.request.messages)
        yield { type: 'text-delta', text: 'accepted answer' } as const
        yield { type: 'usage', inputTokens: 10, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-initial-preflight', model: modelId, maxTokens: MODEL_BASELINE[modelId]!.maxTokens })
    for (let index = 0; index < 8; index += 1) {
      appendMessage(db, { id: `preflight-prior-user-${index}`, sessionId: session.id, role: 'user', content: `old-user-${index} `.repeat(3000), timestamp: index * 2, status: 'sent' })
      appendMessage(db, { id: `preflight-prior-assistant-${index}`, sessionId: session.id, role: 'assistant', content: `old-assistant-${index} `.repeat(3000), timestamp: index * 2 + 1, status: 'sent' })
    }
    const user = appendMessage(db, { id: 'preflight-current-user', sessionId: session.id, role: 'user', content: 'current request must survive', timestamp: 17, status: 'sent' })
    const assistant = appendMessage(db, { id: 'preflight-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 18, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'preflight-turn', requestId: 'preflight-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'preflight-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: '', maximumContext: contextWindow, maxTokens: MODEL_BASELINE[modelId]!.maxTokens, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => '/tmp', resolveWorkDirForSession: () => '/tmp', getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }), getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir: '/tmp' }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), { requestId: 'preflight-request', turnId: 'preflight-turn', turnStartToken: 'preflight-start-token', sessionId: session.id })

    if (!result.ok) throw new Error(`Hosted preflight compaction failed: ${result.error}`)
    expect(requests).toHaveLength(1)
    const firstRequest = JSON.stringify(requests[0])
    expect(firstRequest).not.toContain(`old-user-0 `.repeat(3000))
    expect(firstRequest).toContain('current request must survive')
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('preflight-request')
    expect(history.events.some((event) => event.kind === 'transcript-compacted')).toBe(true)
    expect(history.events.at(-1)?.kind).toBe('invocation-completed')
    const sessionEventsModule = await import('./sessionEvents')
    expect(sessionEventsModule.appendCompactionTransaction).toHaveBeenCalledOnce()
  })

  it('fails closed through Hosted SDK when the required current user cannot fit the request budget', async () => {
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const contextWindow = 4_096
    const maxTokens = 512
    const routeId = createDesktopAnthropicRouteProfile({ modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow, maxOutputTokens: maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-required-user-over-budget-fixture',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'must not dispatch' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-required-user-over-budget', model: modelId, maxTokens })
    const user = appendMessage(db, { id: 'over-budget-current-user', sessionId: session.id, role: 'user', content: 'required-current-user '.repeat(12_000), timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'over-budget-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'over-budget-turn', requestId: 'over-budget-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'over-budget-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: '', maximumContext: contextWindow, maxTokens, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => '/tmp', resolveWorkDirForSession: () => '/tmp', getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }), getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir: '/tmp' }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), { requestId: 'over-budget-request', turnId: 'over-budget-turn', turnStartToken: 'over-budget-start-token', sessionId: session.id })

    expect(providerCalls).toBe(0)
    expect(result).toMatchObject({ ok: false, error: 'model request preflight rejected: OVER_BUDGET' })
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('over-budget-request')
    expect(history.events.some((event) => event.kind === 'model-request-started')).toBe(false)
    expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { status: 'failed' } })
  })

  it('rejects a Desktop initial-allow read when its target changes before fresh recheck', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-initial-read-drift-'))
    const targetPath = path.join(workDir, 'initial-allow.txt')
    await fs.writeFile(targetPath, 'initially authorized content')
    const toolCallId = 'desktop-initial-allow-read-drift'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-initial-allow-drift',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'read_file', input: { path: 'initial-allow.txt' } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '读取目标在复检前变化，未读取替代文件。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-initial-allow-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'read the file', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const gateModule = await import('./confirmation/toolCallGate')
    const originalEvaluateGate = gateModule.evaluateToolCallGate
    let initialDecision: string | undefined
    const evaluateGateSpy = vi.spyOn(gateModule, 'evaluateToolCallGate').mockImplementation(async (args) => {
      const result = await originalEvaluateGate(args)
      if (args.requestId === requestId && args.toolUseId === toolCallId && args.phase === 'initial') {
        initialDecision = result.decision.type
        await fs.rename(targetPath, `${targetPath}.initial`)
        await fs.writeFile(targetPath, 'replacement secret content')
      }
      return result
    })
    const executeRead = vi.spyOn(readFileExecutor, 'execute')

    try {
      await expect(execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id }))
        .resolves.toMatchObject({ ok: true, content: [{ type: 'text', text: '读取目标在复检前变化，未读取替代文件。' }] })
      expect(initialDecision).toBe('auto-allow')
      expect(evaluateGateSpy.mock.calls.filter(([args]) => args.requestId === requestId && args.toolUseId === toolCallId).map(([args]) => args.phase))
        .toEqual(['initial', 'recheck'])
      expect(providerCalls).toBe(2)
      expect(executeRead).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(JSON.stringify(history.events)).not.toContain('replacement secret content')
      expect(JSON.stringify(sessionEvents.filter((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)))
        .not.toContain('replacement secret content')
    } finally {
      evaluateGateSpy.mockRestore()
      executeRead.mockRestore()
    }
  })

  it.each(['skills.read', 'history.read', 'toolkit.find'] as const)('rejects a Desktop Hosted %s result when its snapshot changes before recheck', async (toolName) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-skills-drift-'))
    const skillPath = path.join(workDir, '.space-skills', 'hosted-drift', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, '---\nname: hosted-drift\ndescription: hosted drift fixture\n---\nOriginal secret body.\n')
    invalidateSkillsCache()
    runtime = createDesktopAgentRuntime()
    const tool = runtime.builtinRegistry.get(toolName)!
    const beginPlanning = tool.beginPlanning.bind(tool)
    const originalCapabilityList = capabilityRegistry.list.bind(capabilityRegistry)
    let changedAfterInitialPlan = false
    tool.beginPlanning = (...args) => {
      const planning = beginPlanning(...args)
      return {
        ...planning,
        result: planning.result.then(async (handle) => {
          changedAfterInitialPlan = true
          if (toolName === 'skills.read') {
            await fs.writeFile(skillPath, '---\nname: hosted-drift\ndescription: hosted drift fixture\n---\nReplacement secret body.\n')
            invalidateSkillsCache()
          } else if (toolName === 'history.read') {
            const runtimeContext = (args[1] as { executionContext: { historyFacts: Array<{ text: string }> } }).executionContext
            runtimeContext.historyFacts[0]!.text = 'Changed after planning'
          } else {
            capabilityRegistry.list = () => []
          }
          return handle
        })
      }
    }
    const toolCallId = 'desktop-hosted-skills-drift'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-skills-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: toolName.replace('.', '_'), input: toolName === 'skills.read' ? { name: 'hosted-drift' } : { query: toolName === 'toolkit.find' ? 'env.agent' : 'Read hosted-drift' } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'Skill 内容已变化，未读取旧快照。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-skills-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Read hosted-drift', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    try {
      await expect(execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })).resolves.toMatchObject({ ok: true })
      expect(changedAfterInitialPlan).toBe(true)
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: toolName === 'history.read' ? 'SNAPSHOT_READ_CONTEXT_CHANGED' : 'SNAPSHOT_READ_RESULT_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed' })
      expect(JSON.stringify(history.events)).not.toContain('Original secret body.')
      expect(JSON.stringify(history.events)).not.toContain('Replacement secret body.')
      expect(sessionEvents.some((event) => event.type === 'tool_result' && event.payload.toolCallId === toolCallId)).toBe(false)
    } finally {
      tool.beginPlanning = beginPlanning
      capabilityRegistry.list = originalCapabilityList
      invalidateSkillsCache()
    }
  })

  it.each((['skills.read', 'history.read', 'toolkit.find'] as const).flatMap((toolName) =>
    (['request-cancel', 'revoke', 'authorization-change'] as const).map((invalidation) => ({ toolName, invalidation }))
  ))('does not project a late Desktop Hosted $toolName snapshot after post-claim $invalidation', async ({ toolName, invalidation }) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-snapshot-late-'))
    const skillPath = path.join(workDir, '.space-skills', 'snapshot-late', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, '---\nname: snapshot-late\ndescription: late result fixture\n---\nSNAPSHOT_PRIVATE_BODY\n')
    invalidateSkillsCache()
    runtime = createDesktopAgentRuntime()
    const tool = runtime.builtinRegistry.get(toolName)!
    const beginPlanning = tool.beginPlanning.bind(tool)
    let announceExecute!: (signal: AbortSignal) => void
    let releaseLateSnapshot!: () => void
    const executeEntered = new Promise<AbortSignal>((resolve) => { announceExecute = resolve })
    const lateSnapshot = new Promise<void>((resolve) => { releaseLateSnapshot = resolve })
    tool.beginPlanning = (...args) => {
      const planning = beginPlanning(...args)
      return {
        ...planning,
        result: planning.result.then((handle) => {
          const originalExecute = handle.execute.bind(handle)
          handle.execute = async (context) => {
            announceExecute(context.signal)
            await lateSnapshot
            return await originalExecute(context)
          }
          return handle
        })
      }
    }
    const toolCallId = `desktop-${toolName.replace('.', '-')}-late-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    const providerToolName = toolName.replace('.', '_')
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-snapshot-late-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: providerToolName, input: toolName === 'skills.read' ? { name: 'snapshot-late' } : { query: 'snapshot' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: `hosted-${toolName}-late-snapshot`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Exercise the snapshot reader', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    let invalidationSent = false
    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      const dispatchSignal = await Promise.race([
        executeEntered,
        runningTurn.then((result) => { throw new Error(`Hosted snapshot turn ended before RegisteredTool execute: ${JSON.stringify(result)}`) })
      ])
      if (invalidation === 'request-cancel') runtime.chatCancels.signalChatCancel(requestId)
      if (invalidation === 'revoke') expect(runtime.toolRevocations.revokeToolForLane('desktop', providerToolName)).toBe(1)
      if (invalidation === 'authorization-change') {
        const packages = readPolicyPackages(db)
        packages.desktop = 'strict'
        writePolicyPackages(db, packages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      invalidationSent = true
      await expect.poll(() => dispatchSignal.aborted).toBe(true)
      releaseLateSnapshot()
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-started', payload: expect.objectContaining({ toolCallId }) }))
      expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ reason: 'unknown-after-dispatch' }) }))
      expect(JSON.stringify(history.events)).not.toContain('SNAPSHOT_PRIVATE_BODY')
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_call' && event.payload.toolUseId === toolCallId)).toBe(true)
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(JSON.stringify(events)).not.toContain('SNAPSHOT_PRIVATE_BODY')
      } finally { await sink.close() }
    } finally {
      if (!invalidationSent) runtime.chatCancels.signalChatCancel(requestId)
      releaseLateSnapshot()
      tool.beginPlanning = beginPlanning
      invalidateSkillsCache()
    }
  })

  it('recovers a Desktop Hosted silent overflow and rolls back its provisional text', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-provider-overflow-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'tool result survives overflow retry')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    setConfigValue(db, 'config.models', JSON.stringify([{
      id: modelId, name: modelId, maximumContext: MODEL_BASELINE[modelId]!.maximumContext,
      maximumContextSource: 'user', maxTokens: MODEL_BASELINE[modelId]!.maxTokens,
      isDefault: false, isFast: false, isVision: false, enabled: true
    }]))
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const attempts: ReadonlyArray<unknown>[] = []
    const facts: AssistantFactEvent[] = []
    let releaseOverflowResponse!: () => void
    let markOverflowTextYielded!: () => void
    const overflowResponseGate = new Promise<void>((resolve) => { releaseOverflowResponse = resolve })
    const overflowTextYielded = new Promise<void>((resolve) => { markOverflowTextYielded = resolve })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-provider-overflow-fixture',
      stream: async function* (input) {
        providerCalls += 1
        attempts.push(input.request.messages)
        if (providerCalls === 1) {
          yield { type: 'text-delta', text: 'discarded provisional answer' } as const
          markOverflowTextYielded()
          await overflowResponseGate
          yield { type: 'usage', inputTokens: MODEL_BASELINE[modelId]!.maximumContext + 1, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'stop' } as const
          return
        }
        yield { type: 'text-delta', text: 'recovered after provider retry' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-provider-overflow', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'overflow-user', sessionId: session.id, role: 'user', content: 'read the note and answer', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'overflow-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'overflow-turn', requestId: 'overflow-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'overflow-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maximumContext: MODEL_BASELINE[modelId]!.maximumContext, maximumContextTrusted: true, maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const turnRuntime = { bindRequest: vi.fn(), consumeForRequest: vi.fn((_requestId: string, event: AssistantFactEvent) => { facts.push(event) }) }
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: turnRuntime as never
    })

    const pendingTurn = execute(makeSender(), {
      requestId: 'overflow-request', turnId: 'overflow-turn', turnStartToken: 'overflow-start-token', sessionId: session.id
    })
    await overflowTextYielded
    const provisionalWasVisibleBeforeOverflowUsage = facts.some((fact) => fact.type === 'content-delta' && fact.text === 'discarded provisional answer')
    releaseOverflowResponse()
    const result = await pendingTurn

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'recovered after provider retry' }] })
    expect(provisionalWasVisibleBeforeOverflowUsage).toBe(true)
    const provisionalIndex = facts.findIndex((fact) => fact.type === 'content-delta' && fact.text === 'discarded provisional answer')
    const rollbackIndex = facts.findIndex((fact) => fact.type === 'preview-rollback')
    const recoveredIndex = facts.findIndex((fact) => fact.type === 'content-delta' && fact.text === 'recovered after provider retry')
    expect(rollbackIndex).toBeGreaterThan(provisionalIndex)
    expect(recoveredIndex).toBeGreaterThan(rollbackIndex)
    expect(facts.some((fact) => fact.type === 'content-reconciled' && fact.text.includes('discarded provisional answer'))).toBe(false)
    expect(sessionEvents.filter((event) => event.type === 'assistant_chunk').some((event) => JSON.stringify(event.payload).includes('discarded provisional answer'))).toBe(false)
    expect(providerCalls).toBe(2)
    expect(attempts[1]?.map((message) => (message as { role: string }).role)).toEqual(['user'])
    expect(attempts[1]?.[0]).toMatchObject({ role: 'user', content: 'read the note and answer' })
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('overflow-request')
    expect(history.events.map((event) => event.kind)).toContain('provider-retry-scheduled')
    expect(history.events.map((event) => event.kind)).toContain('transcript-compacted')
    expect(history.events.at(-1)?.kind).toBe('invocation-completed')
    const usageEvents = sessionEvents.filter((event) => event.type === 'request_usage')
    expect(usageEvents).toHaveLength(2)
    expect(usageEvents.map((event) => event.payload.requestId)).toEqual(['overflow-request:round:1', 'overflow-request:round:1:attempt:2'])
    expect(usageEvents[0]?.payload).toMatchObject({ resultDisposition: 'discarded_overflow' })
    expect(facts.filter((fact) => fact.type === 'usage-updated')).toHaveLength(2)
  })

  it('repairs a failed Desktop Hosted terminal projection into the real JSONL file on restart', async () => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-terminal-jsonl-recovery-'))
    db.close()
    db = openDatabase(path.join(workDir, 'history.sqlite'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-terminal-jsonl-recovery-fake',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'canonical result survives projection failure' } as const
        yield { type: 'usage', inputTokens: 7, outputTokens: 4 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-terminal-jsonl-recovery', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-terminal-recovery-user', sessionId: session.id, role: 'user', content: 'answer once', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-terminal-recovery-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-terminal-recovery-turn', requestId: 'hosted-terminal-recovery-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-terminal-recovery-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    failNextSessionEventType = 'turn_end'

    const result = await execute(makeSender(), {
      requestId: 'hosted-terminal-recovery-request', turnId: 'hosted-terminal-recovery-turn',
      turnStartToken: 'hosted-terminal-recovery-start', sessionId: session.id
    })

    expect(result).toMatchObject({
      ok: true, eventPersistenceFailed: true,
      content: [{ type: 'text', text: 'canonical result survives projection failure' }]
    })
    expect(providerCalls).toBe(1)
    const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
    const beforeSink = getSessionEventSink(workDir, session.id, session.createdAt)
    try { expect((await readSessionEvents(beforeSink.eventsPath)).some((event) => event.type === 'turn_end')).toBe(false) }
    finally { await beforeSink.close() }

    db.flushSave()
    db.close()
    db = openDatabase(path.join(workDir, 'history.sqlite'))
    const history = new SqliteAgentHistory(getDbConnection(db))
    const canonicalBeforeRepair = await history.read('hosted-terminal-recovery-request')
    const turnBeforeRepair = getPersistedTurn(db, 'hosted-terminal-recovery-turn')
    const recoveryErrors: unknown[] = []
    const recoveryOptions = {
      onToolLedgerRepairError: (error: unknown, invocationId: string, toolCallId: string) => console.log('tool-repair-error-debug', error, invocationId, toolCallId),
      repairToolCallLedger: async (repairLocation: typeof location, toolCall: Record<string, unknown>) => {
        console.log('tool-call-repair-debug', repairLocation, toolCall)
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureToolCallEvent(sink, toolCall as { toolUseId: string; stepId: string; name: string; args: Record<string, unknown>; turnId?: string }) }
        finally { await sink.close() }
      },
      repairToolLedger: async (repairLocation: typeof location, result: Record<string, unknown>) => {
        console.log('tool-result-repair-debug', repairLocation, result)
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureToolResultEvent(sink, result as unknown as { toolUseId: string; stepId: string; result: Record<string, unknown>; turnId?: string }) }
        finally { await sink.close() }
      },
      repairInvocationTerminal: async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureTurnEndEvent(sink, String(terminal.turnId), String(terminal.reason)) }
        finally { await sink.close() }
      },
      onInvocationTerminalRepairError: (error: unknown) => recoveryErrors.push(error)
    }
    await history.recoverInterruptedInvocations(recoveryOptions)
    await history.recoverInterruptedInvocations(recoveryOptions)

    expect(await history.read('hosted-terminal-recovery-request')).toEqual(canonicalBeforeRepair)
    expect(getPersistedTurn(db, 'hosted-terminal-recovery-turn')).toEqual(turnBeforeRepair)

    const afterSink = getSessionEventSink(workDir, session.id, session.createdAt)
    try {
      const events = await readSessionEvents(afterSink.eventsPath)
      expect(events.filter((event) => event.type === 'turn_end')).toEqual([
        expect.objectContaining({ type: 'turn_end', payload: { turnId: 'hosted-terminal-recovery-turn', reason: 'completed' } })
      ])
    } finally { await afterSink.close() }
    expect(recoveryErrors).toEqual([])
    expect((await history.read('hosted-terminal-recovery-request'))?.events.at(-1)).toMatchObject({
      kind: 'invocation-completed', payload: { status: 'completed', sessionLedger: { turnId: 'hosted-terminal-recovery-turn', reason: 'completed' } }
    })
  })

  it('keeps Desktop Hosted interrupted tool projections repairable from file SQLite after restart', async () => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-tool-jsonl-recovery-'))
    db.close()
    db = openDatabase(path.join(workDir, 'history.sqlite'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-tool-jsonl-recovery-fake',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'hosted-recovery-read', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'answer after durable tool call' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-tool-jsonl-recovery', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-tool-recovery-user', sessionId: session.id, role: 'user', content: 'read the note', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-tool-recovery-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-tool-recovery-turn', requestId: 'hosted-tool-recovery-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id, contextBoundarySequence: user.sequence,
      state: 'prepared', startToken: 'hosted-tool-recovery-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    await fs.writeFile(path.join(workDir, 'note.txt'), 'canonical tool result')
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    failNextSessionEventType = 'tool_result'

    const result = await execute(makeSender(), {
      requestId: 'hosted-tool-recovery-request', turnId: 'hosted-tool-recovery-turn',
      turnStartToken: 'hosted-tool-recovery-start', sessionId: session.id
    })

    expect(result).toMatchObject({ ok: false })
    expect(providerCalls).toBe(1)
    const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
    const beforeSink = getSessionEventSink(workDir, session.id, session.createdAt)
    try {
      const events = await readSessionEvents(beforeSink.eventsPath)
      expect(events.some((event) => event.type === 'tool_call' && event.payload.toolUseId === 'hosted-recovery-read')).toBe(true)
      expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === 'hosted-recovery-read')).toBe(false)
    } finally { await beforeSink.close() }

    db.flushSave()
    db.close()
    db = openDatabase(path.join(workDir, 'history.sqlite'))
    const history = new SqliteAgentHistory(getDbConnection(db))
    const canonicalBeforeRepair = await history.read('hosted-tool-recovery-request')
    const recoveryOptions = {
      repairToolCallLedger: async (repairLocation: typeof location, toolCall: Record<string, unknown>) => {
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureToolCallEvent(sink, toolCall as { toolUseId: string; stepId: string; name: string; args: Record<string, unknown>; turnId?: string }) }
        finally { await sink.close() }
      },
      repairToolLedger: async (repairLocation: typeof location, result: Record<string, unknown>) => {
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureToolResultEvent(sink, result as unknown as { toolUseId: string; stepId: string; result: Record<string, unknown>; turnId?: string }) }
        finally { await sink.close() }
      },
      repairInvocationTerminal: async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureTurnEndEvent(sink, String(terminal.turnId), String(terminal.reason)) }
        finally { await sink.close() }
      }
    }
    await history.recoverInterruptedInvocations(recoveryOptions)
    const canonicalAfterFirstRepair = await history.read('hosted-tool-recovery-request')
    await history.recoverInterruptedInvocations(recoveryOptions)

    expect(await history.read('hosted-tool-recovery-request')).toEqual(canonicalBeforeRepair)
    expect(canonicalAfterFirstRepair).toEqual(canonicalBeforeRepair)
    const afterSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    try {
      const events = await readSessionEvents(afterSink.eventsPath)
      expect(events.filter((event) => event.type === 'tool_call' && event.payload.toolUseId === 'hosted-recovery-read')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'tool_result' && event.payload.toolUseId === 'hosted-recovery-read')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'turn_end' && event.payload.turnId === 'hosted-tool-recovery-turn')).toHaveLength(1)
      expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ name: 'read_file', args: { path: 'note.txt' } })
      expect(events.find((event) => event.type === 'tool_result')?.payload.result).toMatchObject({ success: true, data: { content: 'canonical tool result' } })
    } finally { await afterSink.close() }
  })

  it.each((['read_file', 'list_directory', 'grep', 'write_file', 'edit_file', 'run_script', 'run_shell'] as const).flatMap((toolName) =>
    (['cancel', 'revoke', 'authorization-change'] as const).map((invalidation) => [toolName, invalidation] as const)
  ))('records Desktop Hosted %s %s-before-claim as not-dispatched before executor entry', async (toolName, invalidation) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-revoke-claim-'))
    const targetPath = path.join(workDir, toolName === 'write_file' ? 'new-note.txt' : 'note.txt')
    if (toolName === 'read_file' || toolName === 'grep') await fs.writeFile(targetPath, 'must not read')
    if (toolName === 'list_directory') await fs.mkdir(targetPath)
    if (toolName === 'edit_file') await fs.writeFile(targetPath, 'original content')
    const toolInput = toolName === 'run_shell'
      ? { command: 'cat /etc/hosts' }
      : toolName === 'run_script'
      ? { language: 'javascript', code: 'throw new Error("script must not start")' }
      : toolName === 'grep'
      ? { pattern: 'must not read', path: path.basename(targetPath) }
      : toolName === 'edit_file'
      ? { path: path.basename(targetPath), old_string: 'original content', new_string: 'must not change' }
      : toolName === 'write_file'
        ? { path: path.basename(targetPath), content: 'must not create' }
        : { path: path.basename(targetPath) }
    const toolCallId = `desktop-${toolName}-claim-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({
      builtinRegistry: createBuiltinToolRegistry(),
      toolRevocations: new ToolRevocationRegistry(),
      policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry(),
      chatCancels: new ChatCancelRegistry()
    })
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, { providerId: 'desktop-hosted-revoke-claim', stream: async function* () {
      providerCalls += 1
      if (providerCalls === 1) {
        yield { type: 'tool-call', toolCallId, toolName, input: toolInput } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
        return
      }
      yield { type: 'text-delta', text: `${toolName} 权限已变化，未执行。` } as const
      yield { type: 'usage', inputTokens: 3, outputTokens: 4 } as const
      yield { type: 'finish', reason: 'stop' } as const
    } })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const originalAdmission = runtime.executionAdmission
    const targetExecutor = toolName === 'write_file' ? writeFileExecutor
      : toolName === 'edit_file' ? editFileExecutor
        : toolName === 'run_script' ? runScriptExecutor
          : toolName === 'list_directory' ? listDirectoryExecutor
            : toolName === 'grep' ? grepExecutor : readFileExecutor
    const executor = toolName === 'run_shell'
      ? vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
      : vi.spyOn(targetExecutor, 'execute')
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...call) => originalAdmission.markPermitConsumed(...call),
      beginDispatch: async (...call) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...call)
      },
      invalidate: (...call) => originalAdmission.invalidate(...call),
      settle: (...call) => originalAdmission.settle(...call)
    }

    const session = createSession(db, { name: 'hosted-revoke-claim', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'run authorized tool', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: toolName === 'run_shell', shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      if (toolName === 'list_directory') await expect(fs.readdir(targetPath)).resolves.toEqual([])
      const expectedReason = invalidation === 'cancel' ? 'REQUEST_CANCELLED' : invalidation === 'revoke' ? 'REVOKED' : 'AUTHORIZATION_STALE'
      if (invalidation === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
      } else if (invalidation === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('desktop', toolName)).toBe(1)
      } else {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      releaseClaim()
      const result = await runningTurn
      if (invalidation === 'profile-change') expect(result).toEqual({ debug: 'profile-change' })

      if (invalidation === 'cancel') expect(result, JSON.stringify(result)).toMatchObject({ ok: false })
      else expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: `${toolName} 权限已变化，未执行。` }] })
      expect(providerCalls).toBe(invalidation === 'cancel' ? 1 : 2)
      expect(executor).not.toHaveBeenCalled()
      if (toolName === 'write_file') await expect(fs.readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      if (toolName === 'edit_file') await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('original content')
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      const notDispatched = history.events.find((event) => event.kind === 'tool-call-not-dispatched')!
      expect(notDispatched.payload).toMatchObject({
        toolCallId, reason: expectedReason, replayContent: `Tool call was not dispatched (${expectedReason}).`, isError: true,
        sessionLedger: { result: { success: false, data: `Tool call was not dispatched (${expectedReason}).` } }
      })
      if (invalidation === 'cancel') {
        expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
        expect(sessionEvents.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
      } else {
        expect(sessionEvents.find((event) => event.type === 'tool_result')?.payload.result)
          .toEqual((notDispatched.payload.sessionLedger as { result: unknown }).result)
      }
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') &&
        (event.payload as { toolCallId?: string }).toolCallId === toolCallId
      )).toBe(false)
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      vi.restoreAllMocks()
    }
  })

  it.each(['cancel', 'revoke', 'authorization-change', 'profile-change'] as const)('blocks a Desktop Hosted MCP tool when %s wins after permit consumption and before dispatch claim', async (invalidation) => {
    const toolName = 'mcp_docs_search'
    const serverId = 'desktop-docs-mcp'
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([{
      id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 30,
      auth: { mode: 'none', secretPresent: false },
      stdio: { command: '/usr/bin/false', args: [], env: [] },
      enabledToolNames: ['search'], status: 'connected', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }]))
    setConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId), JSON.stringify({
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z',
      tools: [{
        serverId, originalName: 'search', mappedName: toolName, description: 'Search documentation',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: true }, discoveredAt: '2026-01-01T00:00:00.000Z'
      }]
    }))
    runtime = createAgentRuntime({
      builtinRegistry: createBuiltinToolRegistry(),
      toolRevocations: new ToolRevocationRegistry(),
      policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry(),
      chatCancels: new ChatCancelRegistry()
    })
    const toolCallId = `desktop-mcp-claim-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-mcp-claim-revoke-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName, input: { query: 'release notes' } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'MCP 权限已变化，工具未调用。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...args) => originalAdmission.markPermitConsumed(...args),
      beginDispatch: async (...args) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...args)
      },
      invalidate: (...args) => originalAdmission.invalidate(...args),
      settle: (...args) => originalAdmission.settle(...args)
    }
    const session = createSession(db, { name: 'hosted-mcp-claim-revoke', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Search the docs', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const connect = vi.spyOn(McpConnectionManager.prototype, 'connect').mockRejectedValue(new Error('MCP transport must not connect before a successful dispatch claim'))

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await atClaim
      expect(connect).not.toHaveBeenCalled()
      const expectedReason = invalidation === 'cancel' ? 'REQUEST_CANCELLED' : invalidation === 'authorization-change' ? 'AUTHORIZATION_STALE' : 'REVOKED'
      if (invalidation === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
      } else if (invalidation === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('desktop', toolName)).toBe(1)
      } else if (invalidation === 'authorization-change') {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      } else if (invalidation === 'profile-change') {
        registerMcpIpcHandlers(ipcMain, { db } as never)
        await handlers.get('mcp:save-profiles')!(null, {
          servers: [{
            id: serverId, name: 'Docs', enabled: true, transport: 'streamable-http', timeoutSec: 30,
            auth: { mode: 'none' }, http: { endpoint: 'https://updated.example.test/mcp' }, enabledToolNames: ['search']
          }]
        })
      }
      releaseClaim()
      const result = await runningTurn

      if (invalidation === 'cancel') expect(result).toMatchObject({ ok: false })
      else expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'MCP 权限已变化，工具未调用。' }] })
      expect(providerCalls).toBe(invalidation === 'cancel' ? 1 : 2)
      expect(connect).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId, reason: expectedReason })
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') &&
        (event.payload as { toolCallId?: string }).toolCallId === toolCallId
      )).toBe(false)
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      connect.mockRestore()
    }
  })

  it('blocks a Desktop Hosted MCP snapshot after tools/list authority changes during agent approval', async () => {
    const toolName = 'mcp_docs_search'
    const serverId = 'desktop-refresh-mcp'
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([{
      id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 30,
      auth: { mode: 'none', secretPresent: false },
      stdio: { command: '/usr/bin/false', args: [], env: [] },
      enabledToolNames: ['search'], status: 'connected', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }]))
    setConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId), JSON.stringify({
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z',
      tools: [{
        serverId, originalName: 'search', mappedName: toolName, description: 'Search documentation',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: false, destructiveHint: true }, discoveredAt: '2026-01-01T00:00:00.000Z'
      }]
    }))
    runtime = createDesktopAgentRuntime()
    const toolCallId = 'desktop-mcp-refresh-approval'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-mcp-refresh-confirmation-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName, input: { query: 'release notes' } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'MCP 工具权限已变化，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    let announceApproval!: () => void
    let approveAgent!: (outcome: unknown) => void
    const approvalStarted = new Promise<void>((resolve) => { announceApproval = resolve })
    vi.mocked(runApprovalAgent).mockImplementationOnce(async () => {
      announceApproval()
      return await new Promise((resolve) => { approveAgent = resolve }) as never
    })
    const session = createSession(db, { name: 'hosted-mcp-refresh-approval', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Search the docs', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    registerMcpIpcHandlers(ipcMain, { db } as never)
    const connect = vi.spyOn(McpConnectionManager.prototype, 'connect').mockResolvedValue({
      serverId, client: { listTools: async () => ({ tools: [{
        name: 'search', description: 'Search documentation with expanded destructive capability',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: false, destructiveHint: true }
      }] }) },
      info: { name: 'Docs' }, protocolVersion: '2025-06-18', capabilities: {}, close: async () => undefined
    } as never)

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await approvalStarted
      expect(runApprovalAgent).toHaveBeenCalledOnce()
      const refreshed = await handlers.get('mcp:refresh-tools')!(null, { serverId })
      expect(refreshed).toMatchObject({ ok: true })
      expect(runtime.toolRevocations.isToolRevoked(requestId, toolName)).toBe(true)
      approveAgent({ ok: true, verdict: { kind: 'approve', reason: { summary: 'approval completed after MCP refresh' }, riskLevel: 'high', authorization: 'high' } })
      const result = await runningTurn

      expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'MCP 工具权限已变化，未执行。' }] })
      expect(providerCalls).toBe(2)
      expect(connect).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId, reason: 'REVOKED' })
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') &&
        (event.payload as { toolCallId?: string }).toolCallId === toolCallId
      )).toBe(false)
    } finally {
      approveAgent?.({ ok: false, cause: 'test-cleanup' })
      connect.mockRestore()
    }
  })

  it.each(['agent', 'user'] as const)('cancels a Desktop Hosted MCP tool while its %s approval is pending', async (answerer) => {
    const toolName = 'mcp_docs_search'
    const serverId = 'desktop-cancel-mcp'
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([{
      id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 30,
      auth: { mode: 'none', secretPresent: false },
      stdio: { command: '/usr/bin/false', args: [], env: [] },
      enabledToolNames: ['search'], status: 'connected', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }]))
    setConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId), JSON.stringify({
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z',
      tools: [{
        serverId, originalName: 'search', mappedName: toolName, description: 'Search documentation',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: false, destructiveHint: true }, discoveredAt: '2026-01-01T00:00:00.000Z'
      }]
    }))
    runtime = createDesktopAgentRuntime()
    const toolCallId = `desktop-mcp-${answerer}-approval-cancel`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-mcp-agent-cancel-fixture',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName, input: { query: 'release notes' } } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    if (answerer === 'user') {
      const packages = readPolicyPackages(db)
      packages.desktop = 'strict'
      writePolicyPackages(db, packages)
      db.flushSave()
    }
    const session = createSession(db, { name: 'hosted-mcp-agent-cancel', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Search the docs', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    let announceWaiter!: () => void
    const waiterStarted = new Promise<void>((resolve) => { announceWaiter = resolve })
    if (answerer === 'agent') {
      vi.mocked(runApprovalAgent).mockImplementationOnce(async () => {
        announceWaiter()
        return await new Promise(() => undefined)
      })
    } else {
      const confirmation = prepareToolConfirm(requestId, toolCallId, undefined, {
        toolName, lane: 'desktop', sessionId: session.id
      })
      vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
        announceWaiter()
        return await confirmation
      })
    }
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const connect = vi.spyOn(McpConnectionManager.prototype, 'connect').mockRejectedValue(new Error('MCP executor must not connect during cancelled approval'))

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await waiterStarted
      if (answerer === 'agent') expect(runApprovalAgent).toHaveBeenCalledOnce()
      else expect(waitForToolConfirm).toHaveBeenCalledOnce()
      expect(connect).not.toHaveBeenCalled()
      runtime.chatCancels.signalChatCancel(requestId)
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      expect(connect).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId, answerer }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId, approved: false, outcome: 'cancelled' }) }),
        expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId, reason: 'REQUEST_CANCELLED' }) }),
        expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
      ]))
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') &&
        (event.payload as { toolCallId?: string }).toolCallId === toolCallId
      )).toBe(false)
    } finally {
      runtime.chatCancels.signalChatCancel(requestId)
      connect.mockRestore()
    }
  })

  it('rejects a Desktop Hosted toolkit.call when its capability descriptor changes during approval', async () => {
    runtime = createDesktopAgentRuntime()
    const packages = readPolicyPackages(db)
    packages.desktop = 'strict'
    writePolicyPackages(db, packages)
    db.flushSave()
    const capabilityId = `action.desktop-hosted-descriptor-drift-${randomUUID()}`
    const originalHandler = vi.fn(async () => ({ completed: true }))
    const replacementHandler = vi.fn(async () => ({ completed: false }))
    const descriptor = {
      id: capabilityId, family: 'action' as const, summary: 'Original descriptor', keywords: ['descriptor-drift'],
      paramsSchema: z.object({ value: z.string() }), paramsDoc: '{ value: string }', returnsDoc: '{ completed: boolean }',
      risk: 'act' as const, handler: originalHandler
    }
    const descriptorMap = (capabilityRegistry as unknown as { descriptors: Map<string, unknown> }).descriptors
    const originalDescriptors = new Map(descriptorMap)
    capabilityRegistry.register(descriptor)
    const toolCallId = 'desktop-toolkit-capability-descriptor-drift'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-capability-descriptor-drift',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'toolkit_call', input: { id: capabilityId, params: { value: 'approved' } } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '能力定义在批准期间变化，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      descriptorMap.set(capabilityId, { ...descriptor, summary: 'Replacement descriptor', handler: replacementHandler })
      return 'approved' as never
    })

    const session = createSession(db, { name: 'hosted-toolkit-descriptor-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Run the approved action', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    try {
      await expect(execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id }))
        .resolves.toMatchObject({ ok: true, content: [{ type: 'text', text: '能力定义在批准期间变化，未执行。' }] })
      expect(waitForToolConfirm).toHaveBeenCalledOnce()
      expect(originalHandler).not.toHaveBeenCalled()
      expect(replacementHandler).not.toHaveBeenCalled()
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: 'TOOLKIT_CALL_PREPARED_CAPABILITY_CHANGED'
      })
      expect(history.events.some((event) => (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') && event.payload.toolCallId === toolCallId)).toBe(false)
    } finally {
      descriptorMap.clear()
      for (const [id, value] of originalDescriptors) descriptorMap.set(id, value)
    }
  })

  it.each(['cancel', 'revoke', 'authorization-change'] as const)('keeps a Desktop Hosted MCP late success unknown after post-claim %s', async (invalidation) => {
    const toolName = 'mcp_docs_search'
    const serverId = 'desktop-postclaim-mcp'
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([{
      id: serverId, name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 30,
      auth: { mode: 'none', secretPresent: false },
      stdio: { command: '/usr/bin/false', args: [], env: [] },
      enabledToolNames: ['search'], status: 'connected', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }]))
    setConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId), JSON.stringify({
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z',
      tools: [{
        serverId, originalName: 'search', mappedName: toolName, description: 'Search documentation',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: false, destructiveHint: true }, discoveredAt: '2026-01-01T00:00:00.000Z'
      }]
    }))
    runtime = createDesktopAgentRuntime()
    const toolCallId = 'desktop-mcp-postclaim-cancel'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-mcp-postclaim-cancel-fixture',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName, input: { query: 'release notes' } } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    let announceToolCall!: () => void
    let announceAbort!: () => void
    let returnToolResult!: (result: unknown) => void
    let observedSignal: AbortSignal | undefined
    const toolCallStarted = new Promise<void>((resolve) => { announceToolCall = resolve })
    const leaseAborted = new Promise<void>((resolve) => { announceAbort = resolve })
    const connect = vi.spyOn(McpConnectionManager.prototype, 'connect').mockResolvedValue({
      serverId,
      client: { callTool: vi.fn(async (_params: unknown, _progress: unknown, options: { signal: AbortSignal }) => {
        observedSignal = options.signal
        announceToolCall()
        if (observedSignal.aborted) announceAbort()
        else observedSignal.addEventListener('abort', announceAbort, { once: true })
        return await new Promise((resolve) => { returnToolResult = resolve })
      }) },
      info: { name: 'Docs' }, protocolVersion: '2025-06-18', capabilities: {}, close: async () => undefined
    } as never)
    const session = createSession(db, { name: 'hosted-mcp-postclaim', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Search the docs', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await toolCallStarted
      expect(observedSignal?.aborted).toBe(false)
      if (invalidation === 'cancel') runtime.chatCancels.signalChatCancel(requestId)
      if (invalidation === 'revoke') expect(runtime.toolRevocations.revokeToolForLane('desktop', toolName)).toBe(1)
      if (invalidation === 'authorization-change') {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      await leaseAborted
      expect(observedSignal?.aborted).toBe(true)
      returnToolResult({ content: [{ type: 'text', text: 'late MCP success acknowledgement' }] })
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      expect(connect).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-started' && event.payload.toolCallId === toolCallId)).toBe(true)
      expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(sessionEvents.some((event) => event.type === 'tool_result' && event.payload.toolCallId === toolCallId)).toBe(false)
    } finally {
      runtime.chatCancels.signalChatCancel(requestId)
      returnToolResult?.({ content: [{ type: 'text', text: 'cleanup acknowledgement' }] })
      connect.mockRestore()
    }
  })

  it('cancels a Desktop Hosted toolkit.call while manual confirmation is pending', async () => {
    runtime = createDesktopAgentRuntime()
    const packages = readPolicyPackages(db)
    packages.desktop = 'strict'
    writePolicyPackages(db, packages)
    db.flushSave()
    const capabilityId = `action.desktop-hosted-pending-${randomUUID()}`
    const originalCapabilities = capabilityRegistry.list()
    const restoreCapabilities = () => {
      const descriptors = (capabilityRegistry as unknown as { descriptors: Map<string, unknown> }).descriptors
      descriptors.clear()
      for (const descriptor of originalCapabilities) descriptors.set(descriptor.id, descriptor)
    }
    const handler = vi.fn(async () => ({ completed: true }))
    capabilityRegistry.register({
      id: capabilityId, family: 'action', summary: 'Pending approval Hosted test action', keywords: ['pending-action'],
      paramsSchema: z.object({}), paramsDoc: '{}', returnsDoc: '{ completed: boolean }', risk: 'act', handler
    })
    const toolCallId = 'desktop-toolkit-agent-approval-cancel'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-toolkit-approval-cancel-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'toolkit_call', input: { id: capabilityId, params: {} } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'Action cancelled before approval.' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-toolkit-approval-cancel', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Run the pending action', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const confirmation = prepareToolConfirm(requestId, toolCallId, undefined, {
      toolName: 'toolkit_call', lane: 'desktop', sessionId: session.id
    })
    let notifyConfirmationWaiting!: () => void
    const confirmationWaiting = new Promise<void>((resolve) => { notifyConfirmationWaiting = resolve })
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      notifyConfirmationWaiting()
      return await confirmation
    })
    const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })

    try {
      await Promise.race([
        confirmationWaiting,
        runningTurn.then(() => { throw new Error('Hosted turn ended before manual confirmation was requested') })
      ])
      expect(waitForToolConfirm).toHaveBeenCalledOnce()
      expect(handler).not.toHaveBeenCalled()
      runtime.chatCancels.signalChatCancel(requestId)
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      expect(handler).not.toHaveBeenCalled()
      await expect(vi.mocked(waitForToolConfirm).mock.results[0]?.value).resolves.toBe('cancelled')
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId, reason: 'REQUEST_CANCELLED' })
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') && event.payload.toolCallId === toolCallId
      )).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted' })
    } finally {
      runtime.chatCancels.signalChatCancel(requestId)
      restoreCapabilities()
    }
  })

  it.each(['cancel', 'revoke', 'authorization-change'] as const)('blocks a Desktop Hosted toolkit.call when %s wins after permit consumption and before dispatch claim', async (invalidation) => {
    runtime = createDesktopAgentRuntime()
    const capabilityId = `action.desktop-hosted-claim-${randomUUID()}`
    const handler = vi.fn(async () => ({ completed: true }))
    capabilityRegistry.register({
      id: capabilityId, family: 'action', summary: 'Claim barrier Hosted test action', keywords: ['claim-barrier'],
      paramsSchema: z.object({}), paramsDoc: '{}', returnsDoc: '{ completed: boolean }', risk: 'act', handler
    })
    const packages = readPolicyPackages(db)
    packages.desktop = 'standard'
    writePolicyPackages(db, packages)
    db.flushSave()
    const toolCallId = `desktop-toolkit-claim-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-toolkit-claim-barrier',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'toolkit_call', input: { id: capabilityId, params: {} } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '能力权限已变化，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...args) => originalAdmission.markPermitConsumed(...args),
      beginDispatch: async (...args) => { reachedClaim(); await claimBarrier; return originalAdmission.beginDispatch(...args) },
      invalidate: (...args) => originalAdmission.invalidate(...args),
      settle: (...args) => originalAdmission.settle(...args)
    }

    const session = createSession(db, { name: 'hosted-toolkit-claim-barrier', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'Run the action', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await atClaim
      expect(handler).not.toHaveBeenCalled()
      if (invalidation === 'cancel') runtime.chatCancels.signalChatCancel(requestId)
      if (invalidation === 'revoke') expect(runtime.toolRevocations.revokeToolForLane('desktop', 'toolkit_call')).toBe(1)
      if (invalidation === 'authorization-change') {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      releaseClaim()
      await expect(runningTurn).resolves.toMatchObject({ ok: invalidation !== 'cancel' })

      expect(handler).not.toHaveBeenCalled()
      expect(providerCalls).toBe(invalidation === 'cancel' ? 1 : 2)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: invalidation === 'cancel' ? 'REQUEST_CANCELLED' : invalidation === 'revoke' ? 'REVOKED' : 'AUTHORIZATION_STALE'
      })
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') && event.payload.toolCallId === toolCallId
      )).toBe(false)
      if (invalidation === 'cancel') expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      runtime.chatCancels.signalChatCancel(requestId)
      const descriptors = (capabilityRegistry as unknown as { descriptors: Map<string, unknown> }).descriptors
      descriptors.delete(capabilityId)
    }
  })

  it.each(['cancel', 'revoke', 'authorization-change'] as const)('keeps a Desktop Hosted toolkit.call late success unknown after post-claim %s', async (invalidation) => {
    runtime = createDesktopAgentRuntime()
    const capabilityId = `action.desktop-hosted-late-${randomUUID()}`
    let announceHandler!: () => void
    let releaseHandler!: () => void
    let sideEffectCompleted = false
    const handlerEntered = new Promise<void>((resolve) => { announceHandler = resolve })
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve })
    capabilityRegistry.register({
      id: capabilityId, family: 'action', summary: 'Deferred Hosted test action', keywords: ['deferred'],
      paramsSchema: z.object({}), paramsDoc: '{}', returnsDoc: '{ completed: boolean }', risk: 'act',
      handler: async () => {
        announceHandler()
        await handlerGate
        sideEffectCompleted = true
        return { completed: true }
      }
    })
    const toolCallId = `desktop-toolkit-postclaim-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-toolkit-late-ack-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'toolkit_call', input: { id: capabilityId, params: {} } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '能力结果未知，未重试。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-toolkit-postclaim', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'run the approved capability', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      const beforeHandler = await Promise.race([
        handlerEntered.then(() => 'handler-entered' as const),
        runningTurn.then((result) => ({ result }))
      ])
      expect(beforeHandler).toBe('handler-entered')
      if (invalidation === 'cancel') runtime.chatCancels.signalChatCancel(requestId)
      if (invalidation === 'revoke') expect(runtime.toolRevocations.revokeToolForLane('desktop', 'toolkit.call')).toBe(1)
      if (invalidation === 'authorization-change') {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(sideEffectCompleted).toBe(false)
      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-started' && event.payload.toolCallId === toolCallId)).toBe(true)
      expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(sessionEvents.some((event) => event.type === 'tool_result' && event.payload.toolCallId === toolCallId)).toBe(false)
      releaseHandler()
      await vi.waitFor(() => expect(sideEffectCompleted).toBe(true))
      expect((await new SqliteAgentHistory(getDbConnection(db)).read(requestId)).events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
    } finally {
      runtime.chatCancels.signalChatCancel(requestId)
      releaseHandler()
    }
  })

  it.each(['revoke', 'cancel', 'authorization-change'] as const)('keeps a Desktop Hosted run_script post-claim side effect unknown after %s', async (invalidation) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-run-script-postclaim-'))
    const markerPath = path.join(workDir, 'script-side-effect.txt')
    const toolCallId = `desktop-run-script-postclaim-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({
      builtinRegistry: createBuiltinToolRegistry(), toolRevocations: new ToolRevocationRegistry(),
      policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry(), chatCancels: new ChatCancelRegistry()
    })
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-run-script-postclaim-fixture',
      stream: async function* () {
        providerCalls += 1
        yield {
          type: 'tool-call', toolCallId, toolName: 'run_script',
          input: {
            language: 'javascript',
            code: `import('node:fs').then(({ writeFileSync }) => { writeFileSync(${JSON.stringify(markerPath)}, 'effect-committed'); setTimeout(() => {}, 10000) })`
          }
        } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-run-script-postclaim', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'run this script', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, scriptTimeout: 30 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const originalExecute = runScriptExecutor.execute
    let executorEntered!: () => void
    const entered = new Promise<void>((resolve) => { executorEntered = resolve })
    let executionResult: unknown
    let scriptExecutionSignal: AbortSignal | undefined
    const executeScript = vi.spyOn(runScriptExecutor, 'execute').mockImplementation(async (input, context) => {
      scriptExecutionSignal = context.signal
      executorEntered()
      executionResult = await originalExecute(input, context)
      return executionResult as Awaited<ReturnType<typeof originalExecute>>
    })
    let runningTurn: Promise<unknown> | undefined

    try {
      runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await entered
      const deadline = Date.now() + 5_000
      let markerContent: string | undefined
      while (Date.now() < deadline) {
        try {
          markerContent = await fs.readFile(markerPath, 'utf8')
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (markerContent !== 'effect-committed') {
        const turnOutcome = await runningTurn
        throw new Error(`script side effect missing; executor=${JSON.stringify(executionResult)} turn=${JSON.stringify(turnOutcome)}`)
      }
      const invalidatedAt = Date.now()
      if (invalidation === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('desktop', 'run_script')).toBe(1)
      } else if (invalidation === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
        expect(scriptExecutionSignal?.aborted).toBe(true)
      } else {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(Date.now() - invalidatedAt).toBeLessThan(5_000)
      expect(await fs.readFile(markerPath, 'utf8')).toBe('effect-committed')
      expect(providerCalls).toBe(1)
      expect(executionResult).toMatchObject({ success: false, error: 'SCRIPT_CANCELLED' })
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted', payload: { status: 'interrupted', sessionLedger: { reason: 'interrupted' } }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: toolCallId, name: 'run_script' })
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'interrupted' })
      } finally { await sink.close() }
    } finally {
      if (runningTurn && providerCalls > 0) {
        if (invalidation === 'cancel') runtime.chatCancels.signalChatCancel(requestId)
        else runtime.toolRevocations.revokeToolForLane('desktop', 'run_script')
      }
      executeScript.mockRestore()
    }
  })

  it.each(['revoke', 'cancel', 'authorization-change'] as const)('keeps a Desktop Hosted run_shell post-claim side effect unknown after %s', async (invalidation) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-run-shell-postclaim-'))
    const markerPath = path.join(workDir, 'shell-side-effect.txt')
    const toolCallId = `desktop-run-shell-postclaim-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({
      builtinRegistry: createBuiltinToolRegistry(), toolRevocations: new ToolRevocationRegistry(),
      policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry(), chatCancels: new ChatCancelRegistry()
    })
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-run-shell-postclaim-fixture',
      stream: async function* () {
        providerCalls += 1
        yield {
          type: 'tool-call', toolCallId, toolName: 'run_shell',
          input: { command: `printf '%s' 'effect-committed' > '${markerPath}'; sleep 10` }
        } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-run-shell-postclaim', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'run this shell command', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => workDir,
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: true, shellDefaultTimeoutSec: 30, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    let runningTurn: Promise<unknown> | undefined

    try {
      runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      const deadline = Date.now() + 5_000
      let markerContent: string | undefined
      while (Date.now() < deadline) {
        try {
          markerContent = await fs.readFile(markerPath, 'utf8')
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (markerContent !== 'effect-committed') {
        throw new Error(`shell side effect missing; providerCalls=${providerCalls}`)
      }
      const invalidatedAt = Date.now()
      if (invalidation === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('desktop', 'run_shell')).toBe(1)
      } else if (invalidation === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
      } else {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(Date.now() - invalidatedAt).toBeLessThan(5_000)
      expect(await fs.readFile(markerPath, 'utf8')).toBe('effect-committed')
      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted', payload: { status: 'interrupted', sessionLedger: { reason: 'interrupted' } }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: toolCallId, name: 'run_shell' })
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'interrupted' })
      } finally { await sink.close() }
    } finally {
      if (runningTurn && providerCalls > 0) {
        if (invalidation === 'cancel') runtime.chatCancels.signalChatCancel(requestId)
        else runtime.toolRevocations.revokeToolForLane('desktop', 'run_shell')
      }
    }
  })

  it('aborts a claimed Desktop Hosted read lease when SQLite policy package changes', async () => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-policy-change-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'read interrupted after dispatch')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({
      builtinRegistry: createBuiltinToolRegistry(),
      policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry()
    })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-policy-change-fake',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: 'desktop-policy-change-read', toolName: 'read_file', input: { path: 'note.txt' } } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const originalRead = readFileExecutor.execute
    let observedSignal: AbortSignal | undefined
    let markExecutorEntered!: () => void
    const executorEntered = new Promise<void>((resolve) => { markExecutorEntered = resolve })
    vi.spyOn(readFileExecutor, 'execute').mockImplementation(async (_input, execution) => {
      observedSignal = execution.signal
      markExecutorEntered()
      return await new Promise((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(new Error('read interrupted by policy update')), { once: true })
      })
    })
    const session = createSession(db, { name: 'hosted-policy-change', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'policy-change-user', sessionId: session.id, role: 'user', content: 'read note', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'policy-change-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'policy-change-turn', requestId: 'policy-change-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'policy-change-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    try {
      const runningTurn = execute(makeSender(), {
        requestId: 'policy-change-request', turnId: 'policy-change-turn', turnStartToken: 'policy-change-token', sessionId: session.id
      })
      await executorEntered
      expect(observedSignal?.aborted).toBe(false)
      const packages = readPolicyPackages(db)
      packages.desktop = 'strict'
      writePolicyPackages(db, packages)
      db.flushSave()
      runtime.policyAuthorizationChanges.publish('desktop')

      const result = await runningTurn
      expect(result.ok).toBe(false)
      expect(observedSignal?.aborted).toBe(true)
      expect(providerCalls).toBe(1)
      expect(readFileExecutor.execute).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('policy-change-request')
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted' } })
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'desktop-policy-change-read' })
      const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
      const projectedSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
      const projectedBeforeRecovery = await readSessionEvents(projectedSink.eventsPath)
      expect(projectedBeforeRecovery.filter((event) => event.type === 'turn_end')).toHaveLength(1)
      expect(projectedBeforeRecovery.find((event) => event.type === 'turn_end')?.payload)
        .toMatchObject({ turnId: 'policy-change-turn', reason: 'interrupted', error: expect.any(String) })
      const terminalRepairErrors: unknown[] = []
      await new SqliteAgentHistory(getDbConnection(db)).recoverInterruptedInvocations({
        repairInvocationTerminal: (repairLocation, terminal) => {
          const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
          return ensureTurnEndEvent(sink, String(terminal.turnId), String(terminal.reason))
        },
        onInvocationTerminalRepairError: (error) => terminalRepairErrors.push(error)
      })
      expect(terminalRepairErrors).toEqual([])
      const projectedAfterRecovery = await readSessionEvents(projectedSink.eventsPath)
      expect(projectedAfterRecovery.filter((event) => event.type === 'turn_end')).toHaveLength(1)
      await projectedSink.close()
    } finally {
      if (!observedSignal?.aborted) runtime.chatCancels.signalChatCancel('policy-change-request')
      readFileExecutor.execute = originalRead
      vi.restoreAllMocks()
    }
  })

  it('persists Hosted output truncation result and retry outboxes before continuing the provider', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-output-recovery-'))
    await fs.writeFile(path.join(workDir, 'recovery-note.txt'), 'ordinary tool result after truncated proposal')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const providerRequests: Array<readonly unknown[]> = []
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-output-recovery-fake',
      stream: async function* (call) {
        providerCalls += 1
        providerRequests.push(call.request.messages)
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'hosted-truncated-write', toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'partial' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'length' } as const
          return
        }
        if (providerCalls === 2) {
          yield { type: 'text-delta', text: 'B' } as const
          yield { type: 'tool-call', toolCallId: 'hosted-recovery-read', toolName: 'read_file', input: { path: 'recovery-note.txt' } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'C' } as const
        yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-output-recovery', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-output-user', sessionId: session.id, role: 'user', content: 'write a file', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-output-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-output-turn', requestId: 'hosted-output-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-output-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), {
      requestId: 'hosted-output-request', turnId: 'hosted-output-turn', turnStartToken: 'hosted-output-start', sessionId: session.id
    })

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'BC' }] })
    expect(providerCalls).toBe(3)
    expect(providerRequests[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', toolCallId: 'hosted-recovery-read', content: expect.stringContaining('ordinary tool result after truncated proposal') })
    ]))
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-output-request')
    const notDispatched = history.events.find((event) => event.kind === 'tool-call-not-dispatched')!
    const retry = history.events.find((event) => event.kind === 'provider-retry-scheduled')!
    expect(notDispatched.payload).toMatchObject({ toolCallId: 'hosted-truncated-write', reason: 'MODEL_OUTPUT_TRUNCATED', sessionLedger: { result: expect.objectContaining({ notExecutedReason: 'model_output_truncated' }) } })
    expect(retry.payload).toMatchObject({ code: 'model_output_token_limit', sessionLedger: { requestRetry: { requestId: 'hosted-output-request:round:1', code: 'model_output_token_limit' } } })
    expect(sessionEvents.find((event) => event.type === 'tool_result')?.payload.result).toEqual((notDispatched.payload.sessionLedger as { result: unknown }).result)
    expect(sessionEvents.find((event) => event.type === 'request_retry')?.payload).toMatchObject((retry.payload.sessionLedger as { requestRetry: Record<string, unknown> }).requestRetry)
    expect(sessionEvents.find((event) => event.type === 'request_retry')?.payload).toMatchObject({
      invocationRequestId: 'hosted-output-request', lane: 'desktop', turnId: 'hosted-output-turn'
    })
    expect(history.events.some((event) => (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') && event.payload.toolCallId === 'hosted-truncated-write')).toBe(false)
    expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === 'hosted-recovery-read')).toBe(true)
    await expect(fs.stat(path.join(workDir, 'must-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('continues a Desktop Hosted text response after max_tokens and reconciles the complete answer', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-text-recovery-'))
    await fs.writeFile(path.join(workDir, 'recovery-note.txt'), 'read result after continuation')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const providerRequests: Array<readonly unknown[]> = []
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-text-recovery-fake',
      stream: async function* (call) {
        providerCalls += 1
        providerRequests.push(call.request.messages)
        if (providerCalls === 1) {
          yield { type: 'text-delta', text: 'A' } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'length' } as const
          return
        }
        if (providerCalls === 2) {
          yield { type: 'text-delta', text: 'B' } as const
          yield { type: 'tool-call', toolCallId: 'hosted-text-recovery-read', toolName: 'read_file', input: { path: 'recovery-note.txt' } } as const
          yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'C' } as const
        yield { type: 'usage', inputTokens: 6, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-text-recovery', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-text-user', sessionId: session.id, role: 'user', content: 'continue this answer', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-text-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-text-turn', requestId: 'hosted-text-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-text-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const facts: AssistantFactEvent[] = []
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn((_requestId: string, event: AssistantFactEvent) => { facts.push(event) }) } as never
    })

    const result = await execute(makeSender(), {
      requestId: 'hosted-text-request', turnId: 'hosted-text-turn', turnStartToken: 'hosted-text-start', sessionId: session.id
    })

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'ABC' }] })
    expect(providerCalls).toBe(3)
    expect(providerRequests[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('model_output_token_limit') })
    ]))
    expect(providerRequests[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', toolCallId: 'hosted-text-recovery-read', content: expect.stringContaining('read result after continuation') })
    ]))
    expect(facts).toContainEqual({ type: 'content-reconciled', text: 'ABC' })
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-text-request')
    expect(history.events.map((event) => event.kind)).toEqual(expect.arrayContaining(['model-response-committed', 'replay-message-committed', 'tool-call-finished', 'invocation-completed']))
    expect(history.events.find((event) => event.kind === 'provider-retry-scheduled')?.payload).toMatchObject({
      code: 'model_output_token_limit', sessionLedger: { requestRetry: { requestId: 'hosted-text-request:round:1' } }
    })
  })

  it('records a Desktop Hosted confirmation denial without dispatching the proposed write', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-write-denied-'))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    const modelProviders = runtime.modelProviders
    modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-denied-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'desktop-write-denied-1', toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'denied' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '写入已拒绝。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = modelProviders.register.bind(modelProviders)
    modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(runApprovalAgent).mockResolvedValueOnce({ ok: true, verdict: { kind: 'deny', reason: { summary: 'denied by integration fixture' }, riskLevel: 'high', authorization: 'none' } } as never)

    const session = createSession(db, { name: 'hosted-write-denied', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-denied-user', sessionId: session.id, role: 'user', content: '写入这个文件', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-denied-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-denied-turn', requestId: 'hosted-denied-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-denied-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 1, autoApproveMaxEditChars: 1 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), {
      requestId: 'hosted-denied-request', turnId: 'hosted-denied-turn', turnStartToken: 'hosted-denied-start-token', sessionId: session.id
    })

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '写入已拒绝。' }] })
    expect(providerCalls).toBe(2)
    expect(runApprovalAgent).toHaveBeenCalledOnce()
    await expect(fs.access(targetPath)).rejects.toThrow()
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-denied-request')
    expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
      toolCallId: 'desktop-write-denied-1', reason: 'CONFIRMATION_DENIED'
    })
    const proposal = history.events.find((event) => event.kind === 'model-response-committed' && (event.payload.sessionLedger as { toolCalls?: Array<{ toolUseId: string }> } | undefined)?.toolCalls?.some((call) => call.toolUseId === 'desktop-write-denied-1'))
    const notDispatched = history.events.find((event) => event.kind === 'tool-call-not-dispatched')
    expect((notDispatched?.payload.sessionLedger as { stepId?: string } | undefined)?.stepId)
      .toBe((proposal?.payload.sessionLedger as { stepId?: string } | undefined)?.stepId)
    const legacyProposal = sessionEvents.find((event) => event.type === 'tool_call' && event.payload.toolUseId === 'desktop-write-denied-1')
    const legacyResult = sessionEvents.find((event) => event.type === 'tool_result' && event.payload.toolUseId === 'desktop-write-denied-1')
    expect(legacyResult?.payload.stepId).toBe(legacyProposal?.payload.stepId)
    expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    expect(getUsageTurnFact(db, 'hosted-denied-turn')).toMatchObject({ stepCount: 2, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 1, outcome: 'completed' })
    const usageSteps = getUsageStepFactsForTurn(db, session.id, 'hosted-denied-turn')
    expect(usageSteps).toHaveLength(2)
    expect(usageSteps.reduce((sum, step) => sum + step.inputTokens, 0)).toBe(7)
    expect(usageSteps.reduce((sum, step) => sum + step.outputTokens, 0)).toBe(4)
  })

  it('cancels a Desktop Hosted request while waiting for confirmation without dispatching the write', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-write-cancelled-'))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-confirm-cancel-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'desktop-write-cancelled-1', toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'cancelled write' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '写入已取消。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : originalRegister(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-write-cancelled', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-cancelled-user', sessionId: session.id, role: 'user', content: '写入这个文件', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-cancelled-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-cancelled-turn', requestId: 'hosted-cancelled-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-cancelled-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    let announceApproval!: () => void
    const approvalStarted = new Promise<void>((resolve) => { announceApproval = resolve })
    vi.mocked(runApprovalAgent).mockImplementationOnce(async () => {
      announceApproval()
      return new Promise(() => undefined)
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 1, autoApproveMaxEditChars: 1 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const runningTurn = execute(makeSender(), {
      requestId: 'hosted-cancelled-request', turnId: 'hosted-cancelled-turn', turnStartToken: 'hosted-cancelled-start', sessionId: session.id
    })
    let cancellationSent = false
    try {
      await approvalStarted
      runtime.chatCancels.signalChatCancel('hosted-cancelled-request')
      cancellationSent = true
      const result = await runningTurn

      expect(result.ok).toBe(false)
      expect(providerCalls).toBe(1)
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-cancelled-request')
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId: 'desktop-write-cancelled-1', answerer: 'agent' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'desktop-write-cancelled-1', approved: false, outcome: 'cancelled' }) }),
        expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'desktop-write-cancelled-1', reason: 'REQUEST_CANCELLED' }) }),
        expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
      ]))
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      if (!cancellationSent) runtime.chatCancels.signalChatCancel('hosted-cancelled-request')
    }
  })

  it.each(['read_file', 'list_directory', 'grep'] as const)('cancels a Desktop Hosted sensitive %s while its real confirmation waiter is pending', async (toolName) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-sdk-hosted-${toolName}-cancelled-`))
    const targetPath = path.join(workDir, '.env')
    if (toolName === 'list_directory') {
      await fs.mkdir(targetPath)
      await fs.writeFile(path.join(targetPath, 'SECRET=must-remain-private'), 'private')
    } else {
      await fs.writeFile(targetPath, 'SECRET=must-remain-private')
    }
    const toolCallId = `desktop-${toolName}-cancelled-confirmation`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-read-confirm-cancel-fixture',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName, input: toolName === 'grep' ? { pattern: 'SECRET', path: '.env' } : { path: '.env' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: `hosted-${toolName}-confirm-cancelled`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'read the environment file', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const confirmation = prepareToolConfirm(requestId, toolCallId, undefined, { toolName, lane: 'desktop', sessionId: session.id })
    let announceWaiter!: () => void
    const waiterStarted = new Promise<void>((resolve) => { announceWaiter = resolve })
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      announceWaiter()
      return await confirmation
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const targetExecutor = toolName === 'read_file' ? readFileExecutor : toolName === 'list_directory' ? listDirectoryExecutor : grepExecutor
    const executeRead = vi.spyOn(targetExecutor, 'execute')
    let cancellationSent = false

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await waiterStarted
      expect(executeRead).not.toHaveBeenCalled()
      runtime.chatCancels.signalChatCancel(requestId)
      cancellationSent = true
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      expect(executeRead).not.toHaveBeenCalled()
      if (toolName === 'list_directory') {
        await expect(fs.readFile(path.join(targetPath, 'SECRET=must-remain-private'), 'utf8')).resolves.toBe('private')
      } else {
        await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('SECRET=must-remain-private')
      }
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId, answerer: 'user' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId, approved: false, outcome: 'cancelled' }) }),
        expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId, reason: 'REQUEST_CANCELLED' }) }),
        expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
      ]))
      expect(JSON.stringify(history.events)).not.toContain('SECRET=must-remain-private')
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'cancelled' })
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(JSON.stringify(events)).not.toContain('SECRET=must-remain-private')
      } finally { await sink.close() }
    } finally {
      if (!cancellationSent) runtime.chatCancels.signalChatCancel(requestId)
      executeRead.mockRestore()
    }
  })

  it.each((['read_file', 'list_directory', 'grep'] as const).flatMap((toolName) =>
    (['request-cancel', 'revoke', 'authorization-change'] as const).map((invalidation) => ({ toolName, invalidation }))
  ))('withholds a late Desktop Hosted $toolName result after post-claim $invalidation', async ({ toolName, invalidation }) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-sdk-hosted-${toolName}-late-read-`))
    const targetPath = path.join(workDir, '.env')
    if (toolName === 'list_directory') {
      await fs.mkdir(targetPath)
      await fs.writeFile(path.join(targetPath, 'private-entry.txt'), 'private')
    } else {
      await fs.writeFile(targetPath, 'SECRET=late-private-result')
    }
    const toolCallId = `desktop-${toolName}-late-result-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: `desktop-hosted-${toolName}-late-result-fixture`,
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName, input: toolName === 'grep' ? { pattern: 'SECRET', path: '.env' } : { path: '.env' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(waitForToolConfirm).mockResolvedValueOnce('approved' as never)

    const session = createSession(db, { name: `hosted-${toolName}-late-result`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'read the environment data', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const targetExecutor = toolName === 'read_file' ? readFileExecutor : toolName === 'list_directory' ? listDirectoryExecutor : grepExecutor
    let markExecutorEntered!: () => void
    let releaseLateResult!: () => void
    let announceDispatchAbort!: () => void
    const executorEntered = new Promise<void>((resolve) => { markExecutorEntered = resolve })
    const dispatchAborted = new Promise<void>((resolve) => { announceDispatchAbort = resolve })
    const lateResult = new Promise<void>((resolve) => { releaseLateResult = resolve })
    let dispatchSignal: AbortSignal | undefined
    const executor = vi.spyOn(targetExecutor, 'execute').mockImplementation(async (_input, context) => {
      dispatchSignal = context.signal
      dispatchSignal.addEventListener('abort', announceDispatchAbort, { once: true })
      markExecutorEntered()
      await lateResult
      return { success: true, data: { content: 'SECRET=late-private-result' } } as never
    })
    let cancellationSent = false
    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await executorEntered
      if (invalidation === 'request-cancel') runtime.chatCancels.signalChatCancel(requestId)
      if (invalidation === 'revoke') expect(runtime.toolRevocations.revokeToolForLane('desktop', toolName)).toBe(1)
      if (invalidation === 'authorization-change') {
        const packages = readPolicyPackages(db)
        packages.desktop = 'strict'
        writePolicyPackages(db, packages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      cancellationSent = true
      if (dispatchSignal?.aborted) announceDispatchAbort()
      await dispatchAborted
      expect(dispatchSignal?.aborted).toBe(true)
      releaseLateResult()
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-started', payload: expect.objectContaining({ toolCallId }) }))
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'interrupted', reason: 'unknown-after-dispatch' }) }))
      expect(JSON.stringify(history.events)).not.toContain('SECRET=late-private-result')
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_call' && event.payload.toolUseId === toolCallId)).toBe(true)
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'interrupted' })
        expect(JSON.stringify(events)).not.toContain('SECRET=late-private-result')
      } finally { await sink.close() }
    } finally {
      if (!cancellationSent) {
        if (invalidation === 'request-cancel') runtime.chatCancels.signalChatCancel(requestId)
        if (invalidation === 'revoke') runtime.toolRevocations.revokeToolForLane('desktop', providerToolName)
        if (invalidation === 'authorization-change') runtime.chatCancels.signalChatCancel(requestId)
      }
      releaseLateResult()
      executor.mockRestore()
    }
  })

  it.each((['write_file', 'edit_file'] as const).flatMap((toolName) =>
    (['request-cancel', 'revoke', 'authorization-change'] as const).map((invalidation) => ({ toolName, invalidation }))
  ))('preserves the committed Desktop Hosted $toolName side effect without replaying a late result after $invalidation', async ({ toolName, invalidation }) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-sdk-hosted-${toolName}-late-write-`))
    const targetPath = path.join(workDir, 'approved-target.txt')
    if (toolName === 'edit_file') await fs.writeFile(targetPath, 'before approved edit')
    const toolCallId = `desktop-${toolName}-late-write-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: `desktop-hosted-${toolName}-late-write-fixture`,
      stream: async function* () {
        providerCalls += 1
        if (toolName === 'edit_file' && providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `${toolCallId}-read`, toolName: 'read_file', input: { path: 'approved-target.txt' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield {
          type: 'tool-call', toolCallId, toolName,
          input: toolName === 'write_file'
            ? { path: 'approved-target.txt', content: 'after approved write' }
            : { path: 'approved-target.txt', old_string: 'before approved edit', new_string: 'after approved edit' }
        } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(runApprovalAgent).mockResolvedValueOnce({
      ok: true, verdict: { kind: 'approve', reason: { summary: 'approved for post-claim cancellation test' }, riskLevel: 'medium', authorization: 'high' }
    } as never)

    const session = createSession(db, { name: `hosted-${toolName}-late-write`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'change the approved target', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 0, autoApproveMaxEditChars: 0 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const targetExecutor = toolName === 'write_file' ? writeFileExecutor : editFileExecutor
    let markSideEffectCommitted!: () => void
    let releaseLateResult!: () => void
    const sideEffectCommitted = new Promise<void>((resolve) => { markSideEffectCommitted = resolve })
    const lateResult = new Promise<void>((resolve) => { releaseLateResult = resolve })
    const originalExecute = targetExecutor.execute
    let dispatchSignal!: AbortSignal
    let announceDispatchAbort!: () => void
    const dispatchAborted = new Promise<void>((resolve) => { announceDispatchAbort = resolve })
    const executor = vi.spyOn(targetExecutor, 'execute').mockImplementation(async (input, context) => {
      dispatchSignal = context.signal
      dispatchSignal.addEventListener('abort', announceDispatchAbort, { once: true })
      const result = await originalExecute(input, context)
      markSideEffectCommitted()
      await lateResult
      return result
    })
    let cancellationSent = false
    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await sideEffectCommitted
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(toolName === 'write_file' ? 'after approved write' : 'after approved edit')
      if (invalidation === 'request-cancel') runtime.chatCancels.signalChatCancel(requestId)
      if (invalidation === 'revoke') expect(runtime.toolRevocations.revokeToolForLane('desktop', toolName)).toBe(1)
      if (invalidation === 'authorization-change') {
        const packages = readPolicyPackages(db)
        packages.desktop = 'strict'
        writePolicyPackages(db, packages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      cancellationSent = true
      if (dispatchSignal.aborted) announceDispatchAbort()
      await dispatchAborted
      expect(dispatchSignal.aborted).toBe(true)
      releaseLateResult()
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(toolName === 'write_file' ? 1 : 2)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-started', payload: expect.objectContaining({ toolCallId }) }))
      expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'interrupted', reason: 'unknown-after-dispatch' }) }))
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'interrupted' })
      } finally { await sink.close() }
    } finally {
      if (!cancellationSent) {
        if (invalidation === 'request-cancel') runtime.chatCancels.signalChatCancel(requestId)
        if (invalidation === 'revoke') runtime.toolRevocations.revokeToolForLane('desktop', toolName)
        if (invalidation === 'authorization-change') runtime.chatCancels.signalChatCancel(requestId)
      }
      releaseLateResult()
      executor.mockRestore()
    }
  })

  it.each(['write_file', 'edit_file'] as const)('rechecks a Desktop %s approval against the current target before dispatch', async (toolName) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-write-target-drift-'))
    const targetPath = path.join(workDir, 'approved-target.txt')
    if (toolName === 'edit_file') await fs.writeFile(targetPath, 'approved original content')
    const toolInput = toolName === 'edit_file'
      ? { path: 'approved-target.txt', old_string: 'approved original content', new_string: 'must-not-overwrite' }
      : { path: 'approved-target.txt', content: 'must-not-overwrite' }
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-target-drift-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `desktop-${toolName}-target-drift`, toolName, input: toolInput } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '目标变化后已停止写入。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(runApprovalAgent).mockImplementationOnce(async () => {
      if (toolName === 'edit_file') {
        await fs.rename(targetPath, `${targetPath}.approved`)
        await fs.writeFile(targetPath, 'replacement-after-approval-request')
      } else {
        await fs.writeFile(targetPath, 'created-after-approval-request')
      }
      return { ok: true, verdict: { kind: 'approve', reason: { summary: 'target drift fixture' }, riskLevel: 'medium', authorization: 'high' } } as never
    })

    const session = createSession(db, { name: 'hosted-target-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-target-drift-user', sessionId: session.id, role: 'user', content: '写入这个文件', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-target-drift-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-target-drift-turn', requestId: 'hosted-target-drift-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-target-drift-start-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 1, autoApproveMaxEditChars: 1 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const executeWrite = vi.spyOn(writeFileExecutor, 'execute')
    const executeEdit = vi.spyOn(editFileExecutor, 'execute')
    const result = await execute(makeSender(), {
      requestId: 'hosted-target-drift-request', turnId: 'hosted-target-drift-turn', turnStartToken: 'hosted-target-drift-start-token', sessionId: session.id
    })

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '目标变化后已停止写入。' }] })
    expect(providerCalls).toBe(2)
    expect(runApprovalAgent).toHaveBeenCalledOnce()
    expect(executeWrite).not.toHaveBeenCalled()
    expect(executeEdit).not.toHaveBeenCalled()
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(toolName === 'edit_file' ? 'replacement-after-approval-request' : 'created-after-approval-request')
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-target-drift-request')
    expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
      toolCallId: `desktop-${toolName}-target-drift`, reason: 'POLICY_DENY'
    })
    expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
  })

  it.each(['enabled', 'deniedActions', 'actRequiresConfirm', 'actSessionTrustEnabled'] as const)('rechecks Desktop browser authorization when %s changes during confirmation', async (changedField) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-browser-config-drift-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-browser-config-drift-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'desktop-browser-config-drift', toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '浏览器配置已变化，操作未执行。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    let browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }
    const changeBrowserPolicy = () => {
      browserConfig = changedField === 'enabled'
        ? { ...browserConfig, enabled: false }
        : changedField === 'deniedActions'
          ? { ...browserConfig, deniedActions: ['act'] }
          : changedField === 'actRequiresConfirm'
            ? { ...browserConfig, actRequiresConfirm: false }
            : { ...browserConfig, actSessionTrustEnabled: false }
    }
    const session = createSession(db, { name: 'hosted-browser-config-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-browser-config-drift-user', sessionId: session.id, role: 'user', content: '点击页面提交按钮', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-browser-config-drift-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-browser-config-drift-turn', requestId: 'hosted-browser-config-drift-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-browser-config-drift-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const mutateDuringApproval = async () => {
      changeBrowserPolicy()
      return { ok: true, verdict: { kind: 'approve', reason: { summary: 'browser configuration changed during confirmation' }, riskLevel: 'medium', authorization: 'high' } } as never
    }
    vi.mocked(runApprovalAgent).mockImplementationOnce(mutateDuringApproval)
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      changeBrowserPolicy()
      return 'approved' as never
    })

    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => browserConfig,
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeBrowser = vi.spyOn(browserExecutor, 'execute').mockResolvedValue({ success: true })
    try {
      const result = await execute(makeSender(), {
        requestId: 'hosted-browser-config-drift-request', turnId: 'hosted-browser-config-drift-turn',
        turnStartToken: 'hosted-browser-config-drift-start', sessionId: session.id
      })

      expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '浏览器配置已变化，操作未执行。' }] })
      expect(providerCalls).toBe(2)
      expect(executeBrowser).not.toHaveBeenCalled()
      if (changedField === 'enabled') expect(browserConfig.enabled).toBe(false)
      else if (changedField === 'deniedActions') expect(browserConfig.deniedActions).toEqual(['act'])
      else if (changedField === 'actRequiresConfirm') expect(browserConfig.actRequiresConfirm).toBe(false)
      else expect(browserConfig.actSessionTrustEnabled).toBe(false)
      expect(runApprovalAgent).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-browser-config-drift-request')
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'desktop-browser-config-drift', reason: 'BROWSER_PREPARED_POLICY_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeBrowser.mockRestore()
    }
  })

  it('stops the Desktop turn when complete-gate Runtime composition fails', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-runtime-failure-'))
    runtime = createDesktopAgentRuntime()
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    let hostedProviderCalls = 0
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-runtime-failure-fixture', stream: async function* () {
        hostedProviderCalls += 1
        yield { type: 'text-delta', text: 'must not complete without the safety Runtime' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const session = createSession(db, { name: 'hosted-runtime-failure', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-runtime-failure-user', sessionId: session.id, role: 'user', content: 'Continue safely', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-runtime-failure-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    const requestId = 'hosted-runtime-failure-request'
    const turnId = 'hosted-runtime-failure-turn'
    const startToken = 'hosted-runtime-failure-start'
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    hostedRuntimeFailureInjection.requestId = requestId
    const readExecutor = vi.spyOn(readFileExecutor, 'execute')
    try {
      await expect(execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })).resolves.toMatchObject({ ok: false })
      expect(hostedRuntimeFailureInjection.composeCalls).toBe(1)
      expect(hostedProviderCalls).toBe(0)
      expect(readExecutor).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { status: 'failed' } })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.some((event) => event.kind === 'invocation-completed')).toBe(false)
      expect(history.events.some((event) => event.kind === 'invocation-interrupted')).toBe(false)
      expect(sessionEvents.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'error' })
    } finally {
      hostedRuntimeFailureInjection.requestId = ''
      readExecutor.mockRestore()
    }
  })

  it.each((['navigate', 'act'] as const).flatMap((action) =>
    (['cancel', 'revoke', 'authorization-change'] as const).map((invalidation) => [action, invalidation] as const)
  ))('does not project a late Desktop Hosted browser %s result after post-claim %s', async (action, invalidation) => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-browser-late-result-'))
    const toolCallId = `desktop-browser-${action}-late-result-${invalidation}`
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-browser-late-result-fixture',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'browser', input: action === 'navigate'
          ? { action, url: 'https://example.test/checkout' }
          : { action, instruction: 'click the checkout button' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(runApprovalAgent).mockResolvedValueOnce({
      ok: true, verdict: { kind: 'approve', reason: { summary: `approved browser ${action} for late-ack test` }, riskLevel: 'medium', authorization: 'high' }
    } as never)

    const session = createSession(db, { name: `hosted-browser-${action}-late-result`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: action === 'navigate' ? 'navigate to the checkout page' : 'click the checkout button', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, navigateRequiresConfirm: true, actRequiresConfirm: true }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    let executorEntered!: () => void
    let releaseLateResult!: () => void
    let dispatchAborted!: () => void
    const entered = new Promise<void>((resolve) => { executorEntered = resolve })
    const lateResult = new Promise<void>((resolve) => { releaseLateResult = resolve })
    const aborted = new Promise<void>((resolve) => { dispatchAborted = resolve })
    let dispatchSignal!: AbortSignal
    const executor = vi.spyOn(browserExecutor, 'execute').mockImplementation(async (_input, context) => {
      dispatchSignal = context.signal
      dispatchSignal.addEventListener('abort', dispatchAborted, { once: true })
      executorEntered()
      await lateResult
      return { success: true, data: `browser ${action} completed after invalidation` }
    })
    let cancellationSent = false
    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await entered
      cancellationSent = true
      if (invalidation === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
      } else if (invalidation === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('desktop', 'browser')).toBe(1)
      } else {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('desktop')).toBeGreaterThan(0)
      }
      if (dispatchSignal.aborted) dispatchAborted()
      await aborted
      releaseLateResult()
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-started', payload: expect.objectContaining({ toolCallId }) }))
      expect(history.events.some((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === toolCallId)).toBe(false)
      expect(history.events).toContainEqual(expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'interrupted', reason: 'unknown-after-dispatch' }) }))
      expect(JSON.stringify(history.events)).not.toContain(`browser ${action} completed after invalidation`)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'interrupted' })
        expect(JSON.stringify(events)).not.toContain(`browser ${action} completed after invalidation`)
      } finally { await sink.close() }
    } finally {
      if (!cancellationSent) runtime.chatCancels.signalChatCancel(requestId)
      releaseLateResult()
      executor.mockRestore()
    }
  })

  it.each(['cancel', 'revoke', 'authorization-change'] as const)('records a Desktop Hosted browser %s before dispatch claim without entering the browser executor', async (invalidation) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-sdk-hosted-browser-${invalidation}-claim-`))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    const toolCallId = `desktop-browser-${invalidation}-claim`
    runtime = createAgentRuntime({
      builtinRegistry: createBuiltinToolRegistry(),
      toolRevocations: new ToolRevocationRegistry(),
      policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry(),
      chatCancels: new ChatCancelRegistry()
    })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: `desktop-hosted-browser-${invalidation}-claim-fixture`,
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '浏览器操作已撤销，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    const initialPackages = readPolicyPackages(db)
    initialPackages.desktop = 'standard'
    writePolicyPackages(db, initialPackages)
    db.flushSave()

    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...call) => originalAdmission.markPermitConsumed(...call),
      beginDispatch: async (...call) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...call)
      },
      invalidate: (...call) => originalAdmission.invalidate(...call),
      settle: (...call) => originalAdmission.settle(...call)
    }

    const session = createSession(db, { name: `hosted-browser-${invalidation}-claim`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: '点击页面提交按钮', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG }),
      getBrowserConfig: () => ({ ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeBrowser = vi.spyOn(browserExecutor, 'execute')

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await atClaim
      expect(executeBrowser).not.toHaveBeenCalled()
      if (invalidation === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
      } else if (invalidation === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('desktop', 'browser')).toBe(1)
      } else {
        const changedPackages = readPolicyPackages(db)
        changedPackages.desktop = 'strict'
        writePolicyPackages(db, changedPackages)
        db.flushSave()
        runtime.policyAuthorizationChanges.publish('desktop')
      }
      releaseClaim()
      if (invalidation === 'cancel') await expect(runningTurn).resolves.toMatchObject({ ok: false })
      else await expect(runningTurn).resolves.toMatchObject({ ok: true, content: [{ type: 'text', text: '浏览器操作已撤销，未执行。' }] })
      expect(providerCalls).toBe(invalidation === 'cancel' ? 1 : 2)
      expect(executeBrowser).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: invalidation === 'cancel' ? 'REQUEST_CANCELLED' : invalidation === 'revoke' ? 'REVOKED' : 'AUTHORIZATION_STALE'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      if (invalidation === 'cancel') expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
      else expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      executeBrowser.mockRestore()
    }
  })

  it('cancels a Desktop Hosted browser navigation while its agent approval is pending', async () => {
    useRealSessionEventFiles = true
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-browser-cancelled-'))
    const toolCallId = 'desktop-browser-navigation-cancelled'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-browser-confirm-cancel-fixture',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'browser', input: { action: 'navigate', mode: 'open', url: 'https://example.com/private' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-browser-confirm-cancelled', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'open the requested page', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    let announceApproval!: () => void
    const approvalStarted = new Promise<void>((resolve) => { announceApproval = resolve })
    vi.mocked(runApprovalAgent).mockImplementationOnce(async () => {
      announceApproval()
      return await new Promise(() => undefined)
    })
    const browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, navigateRequiresConfirm: true }
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, getBrowserConfig: () => browserConfig,
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeBrowser = vi.spyOn(browserExecutor, 'execute')
    let cancellationSent = false

    try {
      const runningTurn = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
      await approvalStarted
      expect(executeBrowser).not.toHaveBeenCalled()
      runtime.chatCancels.signalChatCancel(requestId)
      cancellationSent = true
      await expect(runningTurn).resolves.toMatchObject({ ok: false })

      expect(providerCalls).toBe(1)
      expect(executeBrowser).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId, answerer: 'agent' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId, approved: false, outcome: 'cancelled' }) }),
        expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId, reason: 'REQUEST_CANCELLED' }) }),
        expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
      ]))
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId, reason: 'cancelled' })
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId)).toBe(false)
      } finally { await sink.close() }
    } finally {
      if (!cancellationSent) runtime.chatCancels.signalChatCancel(requestId)
      executeBrowser.mockRestore()
    }
  })

  it.each(['write_file', 'edit_file'] as const)('rechecks a Desktop %s approval when its auto-approval threshold changes while waiting', async (toolName) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-write-config-drift-'))
    const targetPath = path.join(workDir, 'approved-target.txt')
    if (toolName === 'edit_file') await fs.writeFile(targetPath, 'original content to edit')
    const toolCallId = `desktop-${toolName}-config-drift`
    const toolInput = toolName === 'edit_file'
      ? { path: 'approved-target.txt', old_string: 'original content to edit', new_string: 'must not use stale threshold' }
      : { path: 'approved-target.txt', content: 'must not use stale threshold' }
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: `desktop-hosted-${toolName}-config-drift-fixture`,
      stream: async function* () {
        providerCalls += 1
        const proposingEdit = toolName === 'edit_file' && providerCalls === 2
        if (toolName === 'edit_file' && providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `${toolCallId}-prime-read`, toolName: 'read_file', input: { path: 'approved-target.txt' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        if (providerCalls === 1 || proposingEdit) {
          yield { type: 'tool-call', toolCallId, toolName, input: toolInput } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '配置变化后已停止写入。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    let autoApproveThreshold = 1
    vi.mocked(runApprovalAgent).mockImplementationOnce(async () => {
      autoApproveThreshold = 1_000
      return { ok: true, verdict: { kind: 'approve', reason: { summary: 'threshold changed during confirmation' }, riskLevel: 'medium', authorization: 'high' } } as never
    })

    const requestId = `hosted-${toolName}-config-drift-request`
    const turnId = `hosted-${toolName}-config-drift-turn`
    const startToken = `hosted-${toolName}-config-drift-start`
    const session = createSession(db, { name: `hosted-${toolName}-config-drift`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${requestId}-user`, sessionId: session.id, role: 'user', content: '写入这个文件', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${requestId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => toolName === 'edit_file'
        ? { ...DEFAULT_TOOLS_CONFIG, autoApproveMaxEditChars: autoApproveThreshold }
        : { ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: autoApproveThreshold },
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeWrite = vi.spyOn(writeFileExecutor, 'execute')
    const executeEdit = vi.spyOn(editFileExecutor, 'execute')
    const result = await execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })

    try {
      expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '配置变化后已停止写入。' }] })
      expect(providerCalls).toBe(toolName === 'edit_file' ? 3 : 2)
      expect(runApprovalAgent).toHaveBeenCalledOnce()
      expect(executeWrite).not.toHaveBeenCalled()
      expect(executeEdit).not.toHaveBeenCalled()
      if (toolName === 'write_file') await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
      else await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('original content to edit')
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: 'POLICY_DENY'
      })
      expect(history.events.some((event) =>
        (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished') &&
        (event.payload as { toolCallId?: string }).toolCallId === toolCallId
      )).toBe(false)
    } finally {
      executeWrite.mockRestore()
      executeEdit.mockRestore()
    }
  })

  it('rechecks a Hosted sensitive read after the approved file identity changes while confirmation is pending', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-read-identity-drift-'))
    const targetPath = path.join(workDir, '.env')
    await fs.writeFile(targetPath, 'SECRET=before')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-read-identity-drift-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'desktop-read-identity-drift', toolName: 'read_file', input: { path: '.env' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '确认期间文件发生变化，已停止读取。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      await fs.rename(targetPath, `${targetPath}.approved`)
      await fs.writeFile(targetPath, 'SECRET=after')
      return 'approved'
    })

    const session = createSession(db, { name: 'hosted-read-identity-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-read-identity-drift-user', sessionId: session.id, role: 'user', content: '读取环境配置', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-read-identity-drift-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-read-identity-drift-turn', requestId: 'hosted-read-identity-drift-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-read-identity-drift-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeRead = vi.spyOn(readFileExecutor, 'execute')

    const result = await execute(makeSender(), {
      requestId: 'hosted-read-identity-drift-request', turnId: 'hosted-read-identity-drift-turn',
      turnStartToken: 'hosted-read-identity-drift-start', sessionId: session.id
    })

    try {
      expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '确认期间文件发生变化，已停止读取。' }] })
      expect(providerCalls).toBe(2)
      expect(waitForToolConfirm).toHaveBeenCalledOnce()
      expect(executeRead).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-read-identity-drift-request')
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'desktop-read-identity-drift', reason: 'POLICY_DENY'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeRead.mockRestore()
    }
  })

  it.each(['list_directory', 'grep'] as const)('rechecks a Hosted %s snapshot target after the approved target is replaced', async (toolName) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-sdk-hosted-${toolName}-read-drift-`))
    const targetPath = path.join(workDir, '.env')
    if (toolName === 'list_directory') {
      await fs.mkdir(targetPath)
      await fs.writeFile(path.join(targetPath, 'before.txt'), 'before')
    } else {
      await fs.writeFile(targetPath, 'before secret')
    }
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-directory-read-drift-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `desktop-${toolName}-read-drift`, toolName, input: toolName === 'list_directory' ? { path: '.env' } : { pattern: 'secret', path: '.env' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '确认期间目录发生变化，已停止读取。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      await fs.rename(targetPath, `${targetPath}.approved`)
      if (toolName === 'list_directory') {
        await fs.mkdir(targetPath)
        await fs.writeFile(path.join(targetPath, 'after.txt'), 'after')
      } else {
        await fs.writeFile(targetPath, 'after secret')
      }
      return 'approved'
    })

    const session = createSession(db, { name: `hosted-${toolName}-read-drift`, model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `hosted-${toolName}-read-drift-user`, sessionId: session.id, role: 'user', content: '读取环境信息', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `hosted-${toolName}-read-drift-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: `hosted-${toolName}-read-drift-turn`, requestId: `hosted-${toolName}-read-drift-request`, sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: `hosted-${toolName}-read-drift-start`,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeDirectory = vi.spyOn(toolName === 'list_directory' ? listDirectoryExecutor : grepExecutor, 'execute')

    const result = await execute(makeSender(), {
      requestId: `hosted-${toolName}-read-drift-request`, turnId: `hosted-${toolName}-read-drift-turn`,
      turnStartToken: `hosted-${toolName}-read-drift-start`, sessionId: session.id
    })

    try {
      expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '确认期间目录发生变化，已停止读取。' }] })
      expect(providerCalls).toBe(2)
      expect(waitForToolConfirm).toHaveBeenCalledOnce()
      expect(executeDirectory).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(`hosted-${toolName}-read-drift-request`)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `desktop-${toolName}-read-drift`, reason: 'POLICY_DENY'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeDirectory.mockRestore()
    }
  })

  it.each([
    ['timeout', (config: typeof DEFAULT_TOOLS_CONFIG) => ({ ...config, scriptTimeout: 45 })],
    ['JavaScript interpreter', (config: typeof DEFAULT_TOOLS_CONFIG) => ({
      ...config,
      scriptInterpreterPaths: { ...config.scriptInterpreterPaths, javascript: '/definitely/missing/agent-sdk-node' }
    })]
  ])('rechecks a Desktop run_script approval when the %s changes while waiting', async (_setting, changeToolsConfig) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-script-config-drift-'))
    const markerPath = path.join(workDir, 'script-must-not-start.txt')
    const toolCallId = 'desktop-run-script-config-drift'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-script-config-drift-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'run_script', input: { language: 'javascript', code: `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')` } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '脚本配置在确认期间变化，未执行。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    let toolsConfig = { ...DEFAULT_TOOLS_CONFIG, scriptTimeout: 30 }
    vi.mocked(waitForToolConfirm).mockImplementationOnce(async () => {
      toolsConfig = changeToolsConfig(toolsConfig)
      return 'approved' as never
    })

    const session = createSession(db, { name: 'hosted-script-config-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: 'run the requested script', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => toolsConfig,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const executeScript = vi.spyOn(runScriptExecutor, 'execute')

    const result = await execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
    try {
      expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '脚本配置在确认期间变化，未执行。' }] })
      expect(providerCalls).toBe(2)
      expect(waitForToolConfirm).toHaveBeenCalledOnce()
      expect(executeScript).not.toHaveBeenCalled()
      await expect(fs.access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally { executeScript.mockRestore() }
  })

  it('rechecks a Desktop run_shell approval when ShellConfig tightens the timeout while waiting', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-shell-config-drift-'))
    const toolCallId = 'desktop-run-shell-config-drift'
    const requestId = `${toolCallId}-request`
    const turnId = `${toolCallId}-turn`
    const startToken = `${toolCallId}-start`
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted', contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens, reasoning: MODEL_BASELINE[modelId]!.reasoning
    })
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId: route.routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-shell-config-drift-fixture',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'run_shell', input: { command: 'cat /etc/hosts' } } as const
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'ShellConfig 在确认期间收紧超时，命令未执行。' } as const
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)
    let shellConfig = { enabled: true, shellDefaultTimeoutSec: 30, maxInlineOutputBytes: 1024, rules: [] as Array<{ id: string; pattern: string; decision: 'allow' | 'deny' | 'ask' }> }
    const session = createSession(db, { name: 'hosted-shell-config-drift', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: `${toolCallId}-user`, sessionId: session.id, role: 'user', content: '请执行请求的命令', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: `${toolCallId}-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId, requestId, sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken,
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'en-US' }
    })
    let releaseShellApproval!: (outcome: 'approved') => void
    let notifyShellApprovalWaiting!: () => void
    const shellApprovalWaiting = new Promise<void>((resolve) => { notifyShellApprovalWaiting = resolve })
    vi.mocked(waitForToolConfirm).mockImplementationOnce(() => new Promise((resolve) => {
      releaseShellApproval = resolve as (outcome: 'approved') => void
      notifyShellApprovalWaiting()
    }))
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => workDir,
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => shellConfig,
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db, getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const executeShell = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
      .mockResolvedValue({ success: true, data: 'unexpected shell dispatch' } as never)
    const execution = execute(makeSender(), { requestId, turnId, turnStartToken: startToken, sessionId: session.id })
    await shellApprovalWaiting
    shellConfig = { ...shellConfig, shellDefaultTimeoutSec: 1 }
    releaseShellApproval('approved')
    const result = await execution
    if (!result.ok) throw new Error(`Desktop shell config drift caller failed: ${JSON.stringify(result)}`)
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'ShellConfig 在确认期间收紧超时，命令未执行。' }] })
    expect(providerCalls).toBe(2)
    expect(waitForToolConfirm).toHaveBeenCalledOnce()
    expect(executeShell).not.toHaveBeenCalled()
    const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
    expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({ toolCallId, reason: 'PREPARED_RECHECK_FAILED' })
    expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    executeShell.mockRestore()
  })

  it('stops Hosted tool dispatch when its critical tool_call ledger projection fails', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-ledger-failure-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'must not be read after ledger failure')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-ledger-failure-fake',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'hosted-ledger-failure-read', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'unexpectedly continued after ledger failure' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-ledger-failure', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-ledger-failure-user', sessionId: session.id, role: 'user', content: 'read the note', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-ledger-failure-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-ledger-failure-turn', requestId: 'hosted-ledger-failure-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-ledger-failure-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })

    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    failNextSessionEventType = 'tool_call'

    await execute(makeSender(), {
      requestId: 'hosted-ledger-failure-request', turnId: 'hosted-ledger-failure-turn',
      turnStartToken: 'hosted-ledger-failure-start', sessionId: session.id
    })

    expect(providerCalls).toBe(1)
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-ledger-failure-request')
    expect(history.events.map((event) => event.kind)).toContain('model-response-committed')
    expect(history.events.map((event) => event.kind)).not.toContain('tool-call-started')
    expect(history.events.map((event) => event.kind)).not.toContain('tool-call-finished')
    expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
      toolCallId: 'hosted-ledger-failure-read', reason: 'HOST_PROJECTION_FAILED'
    })
    expect(history.events.at(-1)?.kind).toBe('invocation-interrupted')
    expect(sessionEvents.map((event) => event.type)).not.toContain('tool_call')
  })

  it('does not commit a Hosted response when its critical request_usage projection fails', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-usage-failure-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-usage-failure-fake',
      stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'response whose usage cannot be projected' } as const
        yield { type: 'usage', inputTokens: 4, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-usage-failure', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-usage-failure-user', sessionId: session.id, role: 'user', content: 'answer briefly', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-usage-failure-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-usage-failure-turn', requestId: 'hosted-usage-failure-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-usage-failure-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    failNextSessionEventType = 'request_usage'

    await execute(makeSender(), {
      requestId: 'hosted-usage-failure-request', turnId: 'hosted-usage-failure-turn',
      turnStartToken: 'hosted-usage-failure-start', sessionId: session.id
    })

    expect(providerCalls).toBe(1)
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-usage-failure-request')
    expect(history.events.map((event) => event.kind)).not.toContain('model-response-committed')
    expect(history.events.at(-1)?.kind).toBe('invocation-failed')
    expect(sessionEvents.map((event) => event.type)).not.toContain('request_usage')
  })

  it('returns the last accepted provider usage when a later Hosted request fails', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-last-valid-usage-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const routeId = createDesktopAnthropicRouteProfile({
      modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext,
      maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning
    }).routeId
    runtime = createAgentRuntime({ builtinRegistry: createBuiltinToolRegistry() })
    runtime.modelProviders.register({ routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'test', modelId, endpoint }, {
      providerId: 'desktop-hosted-last-valid-usage-fake',
      stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'last-valid-usage-read', toolName: 'read_file', input: { path: 'missing.txt' } } as const
          yield { type: 'usage', inputTokens: 1000, outputTokens: 50 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        throw new Error('provider disconnected after tool response')
      }
    })
    const register = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === routeId ? routeId : register(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'hosted-last-valid-usage', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'hosted-last-valid-usage-user', sessionId: session.id, role: 'user', content: 'read a missing file', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'hosted-last-valid-usage-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'hosted-last-valid-usage-turn', requestId: 'hosted-last-valid-usage-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'hosted-last-valid-usage-start',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }),
      turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), {
      requestId: 'hosted-last-valid-usage-request', turnId: 'hosted-last-valid-usage-turn',
      turnStartToken: 'hosted-last-valid-usage-start', sessionId: session.id
    })

    expect(result).toMatchObject({ ok: false, usage: { input_tokens: 1000, output_tokens: 50, cacheSemantics: 'additive' } })
    expect(providerCalls).toBe(2)
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('hosted-last-valid-usage-request')
    expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { usage: { inputTokens: 1000, outputTokens: 50 } } })
  })
})
