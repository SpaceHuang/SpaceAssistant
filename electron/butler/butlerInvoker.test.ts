import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const mockCreateAnthropicClient = vi.fn()
const mockResolveLlmCredentials = vi.fn()
const mockResolveLlmCredentialsForPair = vi.fn()
const directorySymlinkType = process.platform === 'win32' ? 'junction' : 'dir'
const sessionEventFailure = vi.hoisted(() => ({ nextType: undefined as string | undefined }))
const hostedRuntimeFailureInjection = vi.hoisted(() => ({ requestId: '', composeCalls: 0 }))
const ripgrepFixture = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

vi.mock('../anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('../runtime/invocationAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/invocationAssembler')>()
  return {
    ...actual,
    assembleInvocation: (...args: Parameters<typeof actual.assembleInvocation>) => {
      const assembled = actual.assembleInvocation(...args)
      if (args[0].requestId === hostedRuntimeFailureInjection.requestId) {
        assembled.agentSdk.createHostedTurnRuntime = () => {
          hostedRuntimeFailureInjection.composeCalls += 1
          throw new Error('Automation complete-gate Runtime unavailable')
        }
      }
      return assembled
    }
  }
})

vi.mock('../tools/ripgrepBinary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/ripgrepBinary')>()
  return {
    ...actual,
    resolveRipgrepBinary: (...args: Parameters<typeof actual.resolveRipgrepBinary>) => {
      const resolved = actual.resolveRipgrepBinary(...args)
      return ripgrepFixture.path ? { ...resolved, path: ripgrepFixture.path } : resolved
    },
    inspectRipgrepBinary: (...args: Parameters<typeof actual.inspectRipgrepBinary>) =>
      ripgrepFixture.path ? Promise.resolve({ available: true as const }) : actual.inspectRipgrepBinary(...args)
  }
})

vi.mock('../piAiAnthropicBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../piAiAnthropicBridge')>()
  const createTestProvider = () => ({
    providerId: 'pi-ai-anthropic-messages',
    stream: async function* (call: { request: { credentials?: { apiKey: string } } }) {
      const client = mockCreateAnthropicClient(call.request.credentials?.apiKey)
      const stream = client.messages.stream()
      for await (const _event of stream) { /* fixture uses finalMessage as its response */ }
      const response = await stream.finalMessage()
      for (const block of response.content ?? []) {
        if (block.type === 'text') yield { type: 'text-delta', text: block.text }
        else if (block.type === 'thinking') yield { type: 'thinking-delta', text: block.thinking }
        else if (block.type === 'tool_use') yield { type: 'tool-call', toolCallId: block.id, toolName: block.name, input: block.input }
      }
      yield { type: 'usage', inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      yield { type: 'finish', reason: response.stop_reason === 'tool_use' ? 'tool-calls' : 'stop' }
    }
  })
  return {
    ...actual,
    createDesktopAnthropicProvider: createTestProvider,
    registerDesktopAnthropicRoute: (registry: import('../../packages/agent-sdk/src/model').ModelProviderRegistry, profile: { routeId: string; protocol: string; dialect: string; adapterVersion: string; modelId: string; endpoint: string; modelCapabilities: { contextWindow: number; maxOutputTokens: number; reasoning: boolean; strictJsonSchema: boolean } }) => {
      registry.register({ routeId: profile.routeId, protocol: profile.protocol, dialect: profile.dialect, adapterVersion: profile.adapterVersion, modelId: profile.modelId, endpoint: profile.endpoint }, createTestProvider())
      return profile.routeId
    }
  }
})

vi.mock('../llmServiceResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmServiceResolver')>()
  return {
    ...actual,
    resolveLlmCredentialsForModel: (...args: unknown[]) => mockResolveLlmCredentials(...args),
    resolveLlmCredentialsForPair: (...args: unknown[]) => mockResolveLlmCredentialsForPair(...args)
  }
})

vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./butlerSessionEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./butlerSessionEvents')>()
  return {
    ...actual,
    createButlerSessionEvents: async (args: Parameters<typeof actual.createButlerSessionEvents>[0]) => {
      const events = await actual.createButlerSessionEvents(args)
      return {
        ...events,
        sink: events.sink ? {
          ...events.sink,
          appendCritical: async (event: import('../sessionEvents').SessionEventInput) => {
            if (sessionEventFailure.nextType === event.type) {
              sessionEventFailure.nextType = undefined
              throw new Error(`injected ${event.type} projection failure`)
            }
            return events.sink.appendCritical(event)
          }
        } : undefined,
        emitSessionEvent: async (event: import('../sessionEvents').SessionEventInput) => {
          if (sessionEventFailure.nextType === event.type) {
            sessionEventFailure.nextType = undefined
            throw new Error(`injected ${event.type} projection failure`)
          }
          return events.emitSessionEvent(event)
        }
      }
    }
  }
})

import { appendMessage } from '../database/operations'
import { openDatabase, setConfigValue, type AppDatabase } from '../database'
import { DEFAULT_SHELL_CONFIG, DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { evaluateToolCallGate } from '../confirmation/toolCallGate'
import { TurnRuntime } from '../turnRuntime'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { buildButlerSystemAppendix, buildTaskPromptWithOutputScope, executeClaimedRun, runButlerTask } from './butlerInvoker'
import { ButlerTaskScheduler, type SchedulerRunRequest } from './taskScheduler'
import { claimDueSlotAndAdvance, createAutomationTask, createAutomationTask as createStoredAutomationTask, getLatestRunForTask, getRunById, insertManualTaskClaim, updateAutomationTask } from './taskStore'
import type { AutomationTaskPermission, AutomationTaskRunConfigSnapshot } from '../../src/shared/automationTaskTypes'
import { TaskPathFactsProvider } from './taskPathFacts'
import { resolveTaskTarget } from './taskTargetResolver'
import * as runShellExecutor from '../tools/runShellExecutor'
import { resolveAutomationRunOutputDir } from './taskOutputDirectory'
import { getSession } from '../database/operations'
import { getDbConnection } from '../database'
import { getUsageStepFactsForTurn, getUsageTurnFact } from '../database/operations'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { ensureFinalRequestContextEvent, ensureRequestProjectionEvents, ensureRequestUsageEvent, ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, getSessionEventSink, readSessionEvents } from '../sessionEvents'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import * as toolChatLoop from '../toolChatLoop'
import { grepExecutor, listDirectoryExecutor, readFileExecutor, writeFileExecutor } from '../tools/builtinExecutors'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { CallAdmissionGate } from '../runtime/callAdmissionGate'
import { HostedTurnFinalizedError } from '../runtime/hostedTurnFinalization'
import { readDisabledPolicyRuleIds, resolveEffectivePolicyRulesWithOrigin, writeDisabledPolicyRuleIds } from '../confirmation/policyRulesRuntime'
import { registerAppIpcHandlers } from '../appIpc'
import type { AppIpcContext } from '../appIpc'
import { withSessionRuntime } from '../testSupport/sessionStorageComposition'

describe('buildButlerSystemAppendix tool scopes', () => {
  it('describes only receipt-backed Shell commands, grep roots and per-script hash review', () => {
    const appendix = buildButlerSystemAppendix({ directories: ['/workspace/repo'], tools: [], authorizationRecord: {
      id: 'receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
      permissions: [
        { kind: 'local-shell', scopeRoots: ['/workspace/repo'], commands: [{ command: 'git log --oneline -5', workingDirectory: '/workspace/repo' }] },
        { kind: 'grep', scopeRoots: ['/workspace/repo/src'] },
        { kind: 'run-script', scopeRoots: ['/workspace/repo'], scriptHashBinding: 'per-invocation' },
        { kind: 'mcp-tool', serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues',
          purpose: 'Find recent issues', parameters: [{ name: 'query', required: true }], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64) }
      ]
    } })

    expect(appendix).toContain('git log --oneline -5')
    expect(appendix).toContain('/workspace/repo/src')
    expect(appendix).toContain('SHA-256')
    expect(appendix).toContain('命令文本、参数和目录不变')
    expect(appendix).not.toContain('超时=30s')
    expect(appendix).toContain('执行时自行选择合适的超时')
    expect(appendix).toContain('Issue Tracker/search_issues')
    expect(appendix).toContain('Find recent issues')
    expect(appendix).toContain('具体参数仍交由安全审核 Agent')
    expect(buildButlerSystemAppendix({ directories: ['/workspace/repo'], tools: [] })).toContain('本任务未获批任何 MCP 工具')
    expect(buildButlerSystemAppendix({ directories: ['/workspace/repo'], tools: ['run_shell'] })).toContain('本任务未获批 run_shell')
  })

  it('tells the model that the confirmed result directory is writable without requiring a file binding', () => {
    const scheduledFor = new Date(2026, 9, 18, 7, 0).getTime()
    const snapshot = {
      preflightVersion: 1,
      outputDir: '/results',
      outputOrganization: 'daily',
      scheduledFor,
      runOutputDir: '/results/20261018',
      taskRevision: 1,
      targetSelections: [],
      accessPermissions: {
        directories: [], tools: [],
        authorizationRecord: {
          id: 'result-write-receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
          permissions: [{ kind: 'result-write', outputDirectory: '/results', organization: 'daily' }]
        }
      }
    } as unknown as AutomationTaskRunConfigSnapshot
    const prompt = buildTaskPromptWithOutputScope('总结本周进展', snapshot)
    const appendix = buildButlerSystemAppendix(snapshot.accessPermissions, {
      outputDirectory: '/results', organization: 'daily', scheduledFor, runOutputDir: '/results/20261018', taskRevision: 1
    })

    expect(prompt).toContain('用户已授权在此目录及其子目录中写入本次生成的结果')
    expect(prompt).toContain('只能写入，不能读取此目录中的既有内容')
    expect(prompt).toMatch(/未指定固定文件名时，建议保存到：\/results\/20261018\/result-/)
    expect(prompt).not.toContain('本次没有预检绑定的结果目标，请勿创建或修改本地文件')
    expect(appendix).toContain('/results/20261018')
    expect(appendix).toContain('报告、总结等文档结果应保存到此目录')
    expect(buildButlerSystemAppendix(snapshot.accessPermissions, {
      outputDirectory: '/other', organization: 'daily', scheduledFor, runOutputDir: '/other/20261018', taskRevision: 1
    })).toContain('本任务没有有效的结果目录写入授权')
  })
})

function automationEventsRoot(taskId: string): string {
  return path.join('/tmp/ud', 'automation-sessions', taskId)
}

function createAutomationTaskWithToolPermission(
  db: AppDatabase,
  input: Parameters<typeof createAutomationTask>[1],
  permission: AutomationTaskPermission
) {
  const canonical = (value: string) => {
    try { return fsSync.realpathSync(value) } catch { return value }
  }
  const workDirs = input.workDirs.map(canonical)
  const authorizedDirs = input.authorizedDirs?.map(canonical)
  const canonicalPermission: AutomationTaskPermission = 'scopeRoots' in permission
    ? {
        ...permission,
        scopeRoots: permission.scopeRoots.map(canonical),
        ...(permission.kind === 'local-shell' ? { commands: permission.commands.map((command) => ({ ...command, workingDirectory: canonical(command.workingDirectory) })) } : {})
      }
    : permission
  return createAutomationTask(db, {
    ...input,
    workDirs,
    ...(authorizedDirs ? { authorizedDirs } : {}),
    outputDir: canonical(input.outputDir ?? authorizedDirs?.[0] ?? workDirs[0]),
    outputOrganization: input.outputOrganization ?? 'direct'
  }, {
    targetBindings: [],
    authorizationRecord: {
      id: `test-receipt-${randomUUID()}`,
      actor: 'user-confirmation',
      source: 'task-preflight-confirmation',
      approvedAt: Date.now(),
      taskRevision: 1,
      permissions: [canonicalPermission]
    }
  })
}

function makeRuntime(db: AppDatabase): TurnRuntime {
  return new TurnRuntime({
    storage: createTurnCoordinatorStorage(db),
    deps: { now: Date.now, id: (() => { let i = 0; return () => `id-${++i}` })() }
  })
}

describe('butlerInvoker 管家执行链（P4 集成）', () => {
  let db: AppDatabase
  let testWorkDir: string
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateAnthropicClient.mockReset()
    mockResolveLlmCredentialsForPair.mockReset()
    sessionEventFailure.nextType = undefined
    hostedRuntimeFailureInjection.requestId = ''
    hostedRuntimeFailureInjection.composeCalls = 0
    ripgrepFixture.path = ''
    testWorkDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'butler-workdir-'))
    setDefaultAgentRuntime(createDesktopAgentRuntime())
    db = openDatabase(':memory:')
    const initialModelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    setConfigValue(db, 'config.defaultModel', initialModelId)
    setConfigValue(db, 'config.models', JSON.stringify([{ id: initialModelId, name: initialModelId, enabled: true, supportsThinking: true, maximumContext: 200000, maxTokens: 8192 }]))
    mockResolveLlmCredentials.mockResolvedValue({
      error: undefined,
      serviceId: 'svc-1',
      baseUrl: 'https://mock.local',
      getApiKey: async () => 'test-key'
    })
    mockResolveLlmCredentialsForPair.mockImplementation(async (_db: unknown, modelId: string, serviceId: string) => {
      const found = Object.entries(MODEL_BASELINE).find(([id]) => id === modelId)
      if (!found) return { error: 'model missing' }
      return { model: { id: modelId, name: found[0], supportsThinking: true }, serviceId, providerModelName: found[0], baseUrl: 'https://mock.local', getApiKey: async () => 'test-key' }
    })
  })

  afterEach(async () => {
    await fs.rm(testWorkDir, { recursive: true, force: true })
  })
  function makeDeps(overrides: Record<string, unknown> = {}) {
    return {
      db,
      sessionStorage: createSqliteSessionStorage(db),
      turnRuntime: makeRuntime(db),
      admissionGate: new CallAdmissionGate(),
      getWorkDir: () => testWorkDir,
      getActiveWorkDirProfilePath: () => String((overrides.getWorkDir as (() => string) | undefined)?.() ?? testWorkDir),
      getUserDataPath: () => '/tmp/ud',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG as const }),
      resolveWorkDirForSession: () => testWorkDir,
      ...overrides
    }
  }

  function cancellationIdForRequest(requestId: string): string {
    const turn = getDbConnection(db).prepare('SELECT turn_id AS turnId FROM turns WHERE request_id = ?').get(requestId) as { turnId?: string } | undefined
    return turn?.turnId ?? requestId
  }

  it('显式任务工作区在桌面 Profile 改变后固定绑定到 run snapshot 和 session', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-task-root-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({ async *[Symbol.asyncIterator]() {}, finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } })) })) } })
    const task = createAutomationTask(db, { name: 'pinned', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none', workDirs: [workDir], modelId, modelServiceId: 'svc-pinned', modelOverride: model.name, reasoningEffort: 'high' })
    const deps = makeDeps({ getWorkDir: () => testWorkDir, getActiveWorkDirProfilePath: () => testWorkDir })
    const result = await runButlerTask(deps, task.id, { trigger: 'manual', requestId: 'req-task-root-pinned' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const run = getLatestRunForTask(db, task.id)!
    expect(run.configSnapshot).toMatchObject({ workDir: await fs.realpath(workDir), workDirSource: 'task', modelId, serviceId: 'svc-pinned', requestedEffort: 'high', effectiveEffort: 'high' })
    expect(run.configSnapshot?.routeIdentity).toBeTruthy()
    expect(getSession(db, run.sessionId!)?.fixedWorkDir).toBe(await fs.realpath(workDir))
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it.each(['returns false', 'throws'] as const)('continues an automation turn when session ledger readiness %s', async (failureMode) => {
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }))
    })) } })
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    const task = createAutomationTask(db, { name: 'ledger unavailable', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'report', deliveryPref: 'none', workDirs: [testWorkDir], modelId, modelServiceId: 'svc-ledger', modelOverride: model.name })
    const ensureSessionLedgerReady = vi.fn(failureMode === 'returns false'
      ? async () => false : async () => { throw new Error('injected readiness failure') })
    const sessionStorage = createSqliteSessionStorage(db, { getWorkDirForSession: () => testWorkDir, ensureSessionLedgerReady })

    const result = await runButlerTask(makeDeps({ sessionStorage }), task.id, { trigger: 'manual', requestId: 'req-ledger-unavailable' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(mockCreateAnthropicClient).toHaveBeenCalledOnce()
    expect(ensureSessionLedgerReady).toHaveBeenCalledOnce()
  })

  it('uses the receipt-bound Shell working directory even when another authorized root sorts first', async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-shell-cwd-first-'))
    const shellRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-shell-cwd-selected-'))
    const shellRootCanonical = await fs.realpath(shellRoot)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }))
    })) } })
    const task = createAutomationTaskWithToolPermission(db, {
      name: 'receipt-bound shell cwd', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none',
      workDirs: [firstRoot, shellRoot]
    }, {
      kind: 'local-shell', scopeRoots: [firstRoot, shellRoot],
      commands: [{ command: 'git log --oneline -5', workingDirectory: shellRoot }]
    })

    try {
      const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-shell-cwd-receipt' })

      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(getLatestRunForTask(db, task.id)?.configSnapshot).toMatchObject({ workDir: shellRootCanonical })
      expect(getSession(db, getLatestRunForTask(db, task.id)!.sessionId!)?.fixedWorkDir).toBe(shellRootCanonical)
    } finally {
      await fs.rm(firstRoot, { recursive: true, force: true })
      await fs.rm(shellRoot, { recursive: true, force: true })
    }
  })

  it('dispatches separately approved Shell calls from each of their working directories', async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-shell-multi-cwd-first-'))
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-shell-multi-cwd-second-'))
    const firstCanonical = await fs.realpath(firstRoot)
    const secondCanonical = await fs.realpath(secondRoot)
    const command = 'pwd'
    const dispatchCwds: string[] = []
    let providerCalls = 0
    const executionSpy = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback').mockImplementation(async (prepared) => {
      dispatchCwds.push(prepared.cwd)
      return { success: true, data: { stdout: prepared.cwd }, duration: 0 } as never
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => {
        providerCalls += 1
        return providerCalls === 1 ? {
          content: [{ type: 'tool_use', id: 'butler-shell-first-root', name: 'run_shell', input: { command, workingDirectory: firstCanonical } },
            { type: 'tool_use', id: 'butler-shell-second-root', name: 'run_shell', input: { command, workingDirectory: secondCanonical } }],
          stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 4 }
        } : { content: [{ type: 'text', text: 'both directories checked' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 4 } }
      })
    })) } })
    const task = createAutomationTaskWithToolPermission(db, {
      name: 'two approved shell directories', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'check both directories',
      deliveryPref: 'none', workDirs: [firstRoot, secondRoot]
    }, {
      kind: 'local-shell', scopeRoots: [firstRoot, secondRoot],
      commands: [{ command, workingDirectory: firstRoot }, { command, workingDirectory: secondRoot }]
    })

    try {
      const result = await runButlerTask(makeDeps({ getShellConfig: () => ({ ...DEFAULT_SHELL_CONFIG, enabled: true }) }), task.id,
        { trigger: 'manual', requestId: 'req-shell-multi-cwd' })

      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(providerCalls).toBe(2)
      expect(dispatchCwds.sort()).toEqual([firstCanonical, secondCanonical].sort())
    } finally {
      executionSpy.mockRestore()
      await fs.rm(firstRoot, { recursive: true, force: true })
      await fs.rm(secondRoot, { recursive: true, force: true })
    }
  })

  it('revalidates a deep exact target from direct facts and blocks a later symlink before model dispatch', async () => {
    const container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-deep-target-container-')))
    const root = path.join(container, 'project')
    const outputDir = path.join(container, 'output')
    await fs.mkdir(root)
    const deepDirectory = path.join(root, '1', '2', '3', '4')
    await fs.mkdir(outputDir)
    await fs.mkdir(deepDirectory, { recursive: true })
    const targetPath = path.join(deepDirectory, 'note.txt')
    await fs.writeFile(targetPath, 'preflight verified content')
    const provider = new TaskPathFactsProvider()
    const initialFacts = await provider.collect([root], outputDir)
    const proposedPathCandidates = await provider.inspectPaths([targetPath])
    const resolution = resolveTaskTarget({
      rawText: `Read ${targetPath}`,
      target: { kind: 'exact', path: targetPath, targetType: 'file' },
      roots: [root], outputRoot: outputDir,
      facts: { ...initialFacts, proposedPathCandidates }, taskRevision: 1
    })
    if (!resolution.ok) throw new Error(`deep target setup failed: ${resolution.issue.code}`)

    let providerCalls = 0
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => {
        providerCalls += 1
        return { content: [{ type: 'text', text: 'deep target was processed' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }
      })
    })) } })
    const task = createAutomationTask(db, {
      name: 'deep exact target', prompt: `Read ${targetPath}`, schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'none', authorizedDirs: [root], workDirs: [root], outputDir, outputOrganization: 'direct'
    }, { targetBindings: [resolution.binding] })

    try {
      const firstRun = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-deep-target-valid' })
      expect(firstRun.ok, JSON.stringify(firstRun)).toBe(true)
      expect(providerCalls).toBe(1)
      expect(getLatestRunForTask(db, task.id)?.configSnapshot?.preflightVersion).toBe(1)

      await fs.rm(targetPath)
      await fs.symlink(path.join(root, 'outside.txt'), targetPath)
      const secondRun = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-deep-target-symlink' })
      expect(secondRun.ok).toBe(false)
      expect(providerCalls).toBe(1)
    } finally {
      await fs.rm(container, { recursive: true, force: true })
    }
  })

  it('writes an output-only automation task into its scheduled archive without adding output root to read roots', async () => {
    const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-output-only-')))
    const scheduledFor = Date.now() - 1_000
    const runOutputDir = resolveAutomationRunOutputDir(outputDir, 'daily', scheduledFor)
    const outputOnlyReadPath = path.join(outputDir, 'private-existing.txt')
    await fs.writeFile(outputOnlyReadPath, 'output root is not read-authorized')
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    let providerCalls = 0
    const readSpy = vi.spyOn(readFileExecutor, 'execute')
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => {
        providerCalls += 1
        if (providerCalls === 1) return { content: [{ type: 'tool_use', id: 'butler-output-root-read', name: 'read_file', input: { path: outputOnlyReadPath } }], stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 2 } }
        if (providerCalls === 2) return { content: [{ type: 'tool_use', id: 'butler-output-scope-write', name: 'write_file', input: { path: path.join(runOutputDir, 'summary.md'), content: 'scheduled output' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 3 } }
        return { content: [{ type: 'text', text: 'summary saved' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } }
      })
    })) } })
    const task = createAutomationTask(db, {
      name: 'output only', schedule: { kind: 'interval', intervalMinutes: 60 }, prompt: 'write summary.txt', deliveryPref: 'none',
      authorizedDirs: [], workDirs: [], outputDir, outputOrganization: 'daily', modelId, modelServiceId: 'svc-pinned', modelOverride: model.name, reasoningEffort: 'off', nextRunAt: scheduledFor
    }, {
      targetBindings: [],
      authorizationRecord: {
        id: 'result-write-receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: Date.now(), taskRevision: 1,
        permissions: [{ kind: 'result-write', outputDirectory: outputDir, organization: 'daily' }]
      }
    })
    const claim = claimDueSlotAndAdvance(db, { taskId: task.id, slot: scheduledFor, nextSlot: scheduledFor + 60 * 60 * 1000, clientId: 'butler-output-only-claim' })

    try {
      const result = await runButlerTask(makeDeps(), task.id, { trigger: 'schedule', runId: claim.runId, scheduledFor })

      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(readSpy).not.toHaveBeenCalled()
      expect(await fs.readFile(outputOnlyReadPath, 'utf8')).toBe('output root is not read-authorized')
      expect(await fs.readFile(path.join(runOutputDir, 'summary.md'), 'utf8')).toBe('scheduled output')
      expect(getLatestRunForTask(db, task.id)?.configSnapshot).toMatchObject({
        authorizedDirs: [], workDirs: [], outputDir, outputOrganization: 'daily', scheduledFor, runOutputDir,
        targetSelections: [],
        accessPermissions: { authorizationRecord: { permissions: [{ kind: 'result-write', outputDirectory: outputDir, organization: 'daily' }] } }
      })
    } finally {
      readSpy.mockRestore()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('rejects an authorized root replaced by a symlink before model or session creation, even with output-only bindings', async () => {
    const approvedRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-approved-root-')))
    const outsideRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-outside-root-')))
    const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-drift-output-')))
    const approvedRootMoved = `${approvedRoot}-approved`
    const scheduledFor = Date.now() - 1_000
    const binding = {
      kind: 'output' as const, path: path.join(outputDir, 'summary.txt'), ancestor: outputDir, relativeSuffix: 'summary.txt', outputRoot: outputDir,
      expectedType: 'file' as const, rawText: 'write summary.txt', resolverVersion: 3,
      rootsDigest: createHash('sha256').update(JSON.stringify({ outputRoot: path.normalize(outputDir) })).digest('hex'), taskRevision: 1
    }
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })) } })
    const task = createAutomationTask(db, {
      name: 'root drift', schedule: { kind: 'interval', intervalMinutes: 60 }, prompt: 'write summary.txt', deliveryPref: 'none',
      authorizedDirs: [approvedRoot], workDirs: [approvedRoot], outputDir, outputOrganization: 'daily', modelId, modelServiceId: 'svc-pinned', modelOverride: model.name, reasoningEffort: 'off', nextRunAt: scheduledFor
    }, { targetBindings: [binding] })
    const claim = claimDueSlotAndAdvance(db, { taskId: task.id, slot: scheduledFor, nextSlot: scheduledFor + 60 * 60 * 1000, clientId: 'butler-root-drift-claim' })
    const writeDispatch = vi.spyOn(writeFileExecutor, 'execute')
    const originalCollectFacts = TaskPathFactsProvider.prototype.collect
    const factsSpy = vi.spyOn(TaskPathFactsProvider.prototype, 'collect').mockImplementation(async function (this: TaskPathFactsProvider, roots, outputRoot) {
      const facts = await originalCollectFacts.call(this, roots, outputRoot)
      await fs.rename(approvedRoot, approvedRootMoved)
      await fs.symlink(outsideRoot, approvedRoot, directorySymlinkType)
      return facts
    })

    try {
      const result = await runButlerTask(makeDeps(), task.id, { trigger: 'schedule', runId: claim.runId, scheduledFor })

      expect(result).toMatchObject({ ok: false, error: 'TASK_AUTHORIZED_ROOT_DRIFT' })
      expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
      expect(writeDispatch).not.toHaveBeenCalled()
      expect(factsSpy).toHaveBeenCalledOnce()
      expect(getLatestRunForTask(db, task.id)).toMatchObject({ status: 'failed' })
      expect(getLatestRunForTask(db, task.id)?.sessionId).toBeUndefined()
    } finally {
      factsSpy.mockRestore()
      writeDispatch.mockRestore()
      await fs.rm(approvedRoot, { recursive: true, force: true })
      await fs.rm(approvedRootMoved, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('fails an unsafe archive path before creating an automation session or invoking the model', async () => {
    const outputDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-output-archive-invalid-')))
    const scheduledFor = Date.now() - 1_000
    const archiveDir = resolveAutomationRunOutputDir(outputDir, 'daily', scheduledFor)
    await fs.writeFile(archiveDir, 'occupied by a file')
    const task = createAutomationTask(db, {
      name: 'invalid archive', schedule: { kind: 'interval', intervalMinutes: 60 }, prompt: 'write a result', deliveryPref: 'none',
      authorizedDirs: [], workDirs: [], outputDir, outputOrganization: 'daily', nextRunAt: scheduledFor
    }, { targetBindings: [] })
    const claim = claimDueSlotAndAdvance(db, { taskId: task.id, slot: scheduledFor, nextSlot: scheduledFor + 60 * 60 * 1000, clientId: 'butler-invalid-archive-claim' })

    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'schedule', runId: claim.runId, scheduledFor })

    expect(result).toMatchObject({ ok: false, error: 'OUTPUT_DIRECTORY_COMPONENT_INVALID' })
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    expect(getLatestRunForTask(db, task.id)).toMatchObject({ status: 'failed' })
    expect(getLatestRunForTask(db, task.id)?.sessionId).toBeUndefined()
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  it('concurrent consumers of one queued run allow only one invocation past the snapshot CAS', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-concurrent-claim-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({ async *[Symbol.asyncIterator]() {}, finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })) })) } })
    const task = createAutomationTask(db, { name: 'single consumer', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none', workDirs: [workDir], modelId, modelServiceId: 'svc-pinned', modelOverride: model.name })
    const claim = insertManualTaskClaim(db, task.id, 'single-consumer-claim')
    const identity = { taskId: task.id, runId: claim.runId!, requestId: 'single-consumer-request', trigger: 'manual' as const, slot: 0, generation: claim.scheduleGeneration! }
    const [first, second] = await Promise.all([executeClaimedRun(makeDeps(), identity), executeClaimedRun(makeDeps(), identity)])
    expect([first, second].filter((result) => result.ok)).toHaveLength(1)
    expect(mockCreateAnthropicClient).toHaveBeenCalledTimes(1)
    expect(getRunById(db, claim.runId!)?.status).toBe('completed')
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('scheduler passes its precreated claim directly into the real invoker without a second run row', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-scheduler-invoker-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'scheduled complete' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }))
    })) } })
    const task = createAutomationTask(db, { name: 'scheduler integration', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none', workDirs: [workDir], modelId, modelServiceId: 'svc-pinned', modelOverride: model.name, nextRunAt: Date.now() })
    const deps = makeDeps()
    const port = vi.fn((taskId: string, request: SchedulerRunRequest) => runButlerTask(deps, taskId, request))
    const scheduler = new ButlerTaskScheduler({ db, runTask: port, isTrayEnabled: () => true, now: () => Date.now() })
    await scheduler.tick()
    expect(port).toHaveBeenCalledOnce()
    const request = port.mock.calls[0]![1]
    const runs = getDbConnection(db).prepare('SELECT id,status,trigger,scheduled_for FROM automation_task_runs WHERE task_id=?').all(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: request.runId, status: 'completed', trigger: 'schedule', scheduled_for: request.scheduledFor })
    expect(getLatestRunForTask(db, task.id)?.resultSummary).toBe('scheduled complete')
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('admission 排队期间更新的 task config 会在准入后重新读取并冻结', async () => {
    const initialDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-admission-old-'))
    const queuedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-admission-new-'))
    const modelIds = Object.entries(MODEL_BASELINE).filter(([, baseline]) => baseline.sourceProvider === 'anthropic').slice(0, 2).map(([id]) => id)
    setConfigValue(db, 'config.models', JSON.stringify(modelIds.map((id) => ({ ...MODEL_BASELINE[id]!, id, name: id, enabled: true, supportsThinking: true }))))
    const task = createAutomationTask(db, { name: 'queued config', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none', workDirs: [initialDir], modelId: modelIds[0], modelServiceId: 'svc-pinned', modelOverride: modelIds[0], reasoningEffort: 'low' })
    let admit!: (value: { ok: true; ticket: { request: never; release: () => boolean } }) => void
    const admissionGate = { acquire: () => new Promise<{ ok: true; ticket: { request: never; release: () => boolean } }>((resolve) => { admit = resolve }) }
    const runPromise = runButlerTask(makeDeps({ admissionGate }), task.id, { trigger: 'manual', requestId: 'req-admission-refresh' })
    await Promise.resolve()
    updateAutomationTask(db, task.id, { workDirs: [queuedDir], modelId: modelIds[1], modelServiceId: 'svc-pinned', modelOverride: modelIds[1], reasoningEffort: 'high' })
    admit({ ok: true, ticket: { request: {} as never, release: () => true } })
    const result = await runPromise
    const run = getLatestRunForTask(db, task.id)!
    expect(run.configSnapshot, JSON.stringify({ result, run })).toMatchObject({ workDir: await fs.realpath(queuedDir), modelId: modelIds[1], providerModelName: modelIds[1], requestedEffort: 'high' })
    await fs.rm(initialDir, { recursive: true, force: true })
    await fs.rm(queuedDir, { recursive: true, force: true })
  })

  it('legacy task without a stored root fails even when an active Profile path exists', async () => {
    const task = createStoredAutomationTask(db, { name: 'legacy no profile', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none' })
    const result = await runButlerTask(makeDeps({ getActiveWorkDirProfilePath: () => testWorkDir }), task.id, { trigger: 'manual', requestId: 'req-legacy-no-profile' })
    expect(result).toMatchObject({ ok: false, error: '任务工作目录不能为空' })
    const run = getLatestRunForTask(db, task.id)!
    expect(run).toMatchObject({ status: 'failed', configSnapshot: { resolutionStatus: 'failed', error: '任务工作目录不能为空' } })
    expect(run.sessionId).toBeUndefined()
  })

  it('database closes during failure handling but still returns a structured task failure', async () => {
    const task = createAutomationTask(db, { name: 'db close race', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none', workDirs: [testWorkDir] })
    const result = await runButlerTask(makeDeps({ onSessionCreated: () => { db.close(); throw new Error('injected execution failure') } }), task.id, { trigger: 'manual', requestId: 'req-db-close-race' })
    expect(result).toMatchObject({ ok: false, runId: expect.any(String), error: 'injected execution failure' })
  })

  it('explicit pair revoked after config resolution fails before accepted turn or provider request', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-revoked-root-'))
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const model = { ...MODEL_BASELINE[modelId]!, id: modelId, name: modelId, enabled: true, supportsThinking: true }
    setConfigValue(db, 'config.models', JSON.stringify([model]))
    const resolved = { model, serviceId: 'svc-pinned', providerModelName: modelId, baseUrl: 'https://mock.local', getApiKey: async () => 'test-key' }
    mockResolveLlmCredentialsForPair.mockResolvedValueOnce(resolved).mockResolvedValueOnce({ error: 'service disabled' })
    const task = createAutomationTask(db, { name: 'revoked', schedule: { kind: 'interval', intervalMinutes: 30 }, prompt: 'report', deliveryPref: 'none', workDirs: [workDir], modelId, modelServiceId: 'svc-pinned', modelOverride: modelId, reasoningEffort: 'high' })
    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-task-pair-revoked' })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('service disabled') })
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS n FROM turns WHERE request_id = ?').get('req-task-pair-revoked')).toEqual({ n: 0 })
    expect(getLatestRunForTask(db, task.id)?.configSnapshot).toMatchObject({ resolutionStatus: 'resolved', modelId, serviceId: 'svc-pinned' })
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('手动触发：会话创建归属正确，回合完成，run 记录 completed + usage + summary', async () => {
    const task = createAutomationTask(db, {
      name: '巡检',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '检查磁盘空间',
      deliveryPref: 'none', workDirs: [testWorkDir]
    })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: '磁盘 42% 已用，一切正常。' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 120, output_tokens: 30 }
          }))
        }))
      }
    })

    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-butler-1' })
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const run = getLatestRunForTask(db, task.id)
    expect(run?.status).toBe('completed')
    expect(run?.sessionId).toBeTruthy()
    expect(run?.resultSummary).toContain('磁盘')
    expect(run?.usageJson).toContain('input_tokens')
    expect(run?.trigger).toBe('manual')
    expect(run?.configSnapshot).toMatchObject({ resolutionStatus: 'resolved', workDir: await fs.realpath(testWorkDir), workDirSource: 'task', providerModelName: expect.any(String), serviceId: 'svc-1' })

    const session = run?.sessionId ? getSession(db, run.sessionId) : undefined
    expect(session?.ownership).toBe('automation')
    expect(session?.visibility).toBe('section')
    const conn = getDbConnection(db)
    const turn = conn.prepare('SELECT turn_id AS turnId FROM turns WHERE request_id = ?').get('req-butler-1') as { turnId?: string }
    expect(turn.turnId).toBeTruthy()
    const stepFacts = getUsageStepFactsForTurn(db, session!.id, turn.turnId!)
    expect(stepFacts).toHaveLength(1)
    expect(stepFacts[0]).toMatchObject({ sessionId: session!.id, turnId: turn.turnId, stepId: 'req-butler-1:model:1:attempt:1', modelId: run?.configSnapshot?.modelId, providerModelName: run?.configSnapshot?.providerModelName, routeIdentity: run?.configSnapshot?.routeIdentity })
    expect(stepFacts[0]?.attributionJson).not.toBeNull()
    expect(stepFacts[0]?.estimatorVersion).not.toBeNull()
    const turnFact = getUsageTurnFact(db, turn.turnId!)
    expect(turnFact).toMatchObject({ sessionId: session!.id, turnId: turn.turnId, modelId: run?.configSnapshot?.modelId, providerModelName: run?.configSnapshot?.providerModelName, routeIdentity: run?.configSnapshot?.routeIdentity })
    expect(turnFact?.toolAttributionJson).not.toBeNull()
    expect(JSON.parse(turnFact!.toolAttributionJson!)).toMatchObject({
      tools: expect.any(Object), toolSource: expect.any(Object), toolResults: expect.any(Object)
    })
    const persistedToolDimensions = JSON.parse(turnFact!.toolAttributionJson!) as { tools: Record<string, number>; toolSource: Record<string, number> }
    expect(Object.values(persistedToolDimensions.tools).some((value) => value > 0)).toBe(true)
    expect(Object.values(persistedToolDimensions.toolSource).some((value) => value > 0)).toBe(true)
  })

  it('Hosted transcript commit uncertain leaves the automation run interrupted, not failed', async () => {
    const task = createAutomationTask(db, {
      name: 'uncertain transcript commit', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'perform one action', deliveryPref: 'none', workDirs: [testWorkDir]
    })
    const runTurn = vi.spyOn(toolChatLoop, 'runToolChatSession').mockRejectedValue(
      new HostedTurnFinalizedError(new Error('SESSION_TRANSCRIPT_COMMIT_UNCERTAIN:checkpoint-write-failed'), 'commit-uncertain')
    )

    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-butler-commit-uncertain' })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('SESSION_TRANSCRIPT_COMMIT_UNCERTAIN') })
    expect(getLatestRunForTask(db, task.id)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('SESSION_TRANSCRIPT_COMMIT_UNCERTAIN')
    })
    expect(runTurn).toHaveBeenCalledOnce()
    runTurn.mockRestore()
  })

  it.each(['checkpoint', 'history-terminal'] as const)('SQLite $fault failure through the real Hosted handoff preserves the Butler outcome', async (fault) => {
    const conn = getDbConnection(db)
    conn.exec(fault === 'checkpoint'
      ? `CREATE TRIGGER fail_transcript_checkpoint_update BEFORE INSERT ON session_transcript_checkpoints
          WHEN NEW.version > 0 BEGIN SELECT RAISE(ABORT, 'injected hosted checkpoint failure'); END`
      : `CREATE TRIGGER fail_transcript_checkpoint_update BEFORE INSERT ON agent_history_events
          WHEN NEW.kind='invocation-completed' BEGIN SELECT RAISE(ABORT, 'injected hosted terminal failure'); END`)
    const task = createAutomationTask(db, {
      name: 'hosted checkpoint uncertainty', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'complete once', deliveryPref: 'none', workDirs: [testWorkDir]
    })
    let providerCalls = 0
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => {
        providerCalls += 1
        return { content: [{ type: 'text', text: 'canonical answer' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }
      })
    })) } })

    const requestId = `req-butler-real-${fault}-failure`
    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId })

    const injectedFailure = fault === 'checkpoint' ? 'injected hosted checkpoint failure' : 'injected hosted terminal failure'
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(injectedFailure) })
    expect(providerCalls).toBe(1)
    const run = getLatestRunForTask(db, task.id)!
    expect(run).toMatchObject({
      status: fault === 'checkpoint' ? 'interrupted' : 'failed', error: expect.stringContaining(injectedFailure)
    })
    const turn = conn.prepare('SELECT turn_id AS turnId, session_id AS sessionId FROM turns WHERE request_id=?').get(requestId) as { turnId: string; sessionId: string }
    const history = await new SqliteAgentHistory(conn).read(turn.turnId)
    expect(history.events.at(-1)).toMatchObject(fault === 'checkpoint'
      ? { kind: 'invocation-completed', payload: { status: 'completed' } }
      : { kind: 'invocation-failed', payload: { status: 'failed' } })
    if (fault === 'checkpoint') {
      expect(conn.prepare('SELECT status FROM session_transcript_checkpoints WHERE session_id=?').get(turn.sessionId))
        .toEqual({ status: 'commit_uncertain' })
      expect(conn.prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(turn.sessionId))
        .toEqual({ status: 'commit_uncertain' })
    } else {
      expect(conn.prepare('SELECT outcome FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get(turn.sessionId, turn.turnId))
        .toEqual({ outcome: 'failed' })
    }
    conn.exec('DROP TRIGGER fail_transcript_checkpoint_update')
  })

  it('Automation checkpoint failure after a real Hosted tool result keeps the side effect single across SQLite restart', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-tool-checkpoint-restart-'))
    const dbPath = path.join(workDir, 'automation.db')
    const requestId = 'req-butler-tool-checkpoint-restart'
    let readCalls = 0
    const originalRead = readFileExecutor.execute
    const readSpy = vi.spyOn(readFileExecutor, 'execute').mockImplementation(async (...args) => {
      readCalls += 1
      return await originalRead(...args)
    })
    try {
      db.close()
      db = openDatabase(dbPath)
      const defaultModelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
      setConfigValue(db, 'config.defaultModel', defaultModelId)
      setConfigValue(db, 'config.models', JSON.stringify([{ id: defaultModelId, name: defaultModelId, enabled: true, supportsThinking: true, maximumContext: 200000, maxTokens: 8192 }]))
      const notePath = path.join(workDir, 'note.txt')
      await fs.writeFile(notePath, 'canonical tool side effect')
      const task = createAutomationTask(db, {
        name: 'tool checkpoint restart', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
      })
      getDbConnection(db).exec(`CREATE TRIGGER fail_tool_transcript_checkpoint BEFORE INSERT ON session_transcript_checkpoints
        WHEN NEW.version > 0 BEGIN SELECT RAISE(ABORT, 'injected tool checkpoint failure'); END`)
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => {
          providerCalls += 1
          return providerCalls === 1
            ? { content: [{ type: 'tool_use', id: 'butler-checkpoint-read', name: 'read_file', input: { path: notePath } }], stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 3 } }
            : { content: [{ type: 'text', text: 'read finished' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }
        })
      })) } })

      const first = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId })

      expect(first).toMatchObject({ ok: false, error: expect.stringContaining('injected tool checkpoint failure') })
      expect(readCalls).toBe(1)
      expect(providerCalls).toBe(2)
      const run = getLatestRunForTask(db, task.id)!
      expect(run).toMatchObject({ status: 'interrupted', error: expect.stringContaining('injected tool checkpoint failure') })
      const turn = getDbConnection(db).prepare('SELECT turn_id AS turnId,session_id AS sessionId FROM turns WHERE request_id=?')
        .get(requestId) as { turnId: string; sessionId: string }
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(turn.turnId)
      expect(history.events.filter((event) => event.kind === 'tool-call-started')).toHaveLength(1)
      expect(history.events.filter((event) => event.kind === 'tool-call-finished')).toHaveLength(1)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(turn.sessionId))
        .toEqual({ status: 'commit_uncertain' })

      db.close()
      db = openDatabase(dbPath)
      const providerCallsBeforeRetry = providerCalls
      const retry = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId })

      expect(retry).toMatchObject({ ok: false, error: expect.stringContaining('重复触发') })
      expect(providerCalls).toBe(providerCallsBeforeRetry)
      expect(readCalls).toBe(1)
      expect(getLatestRunForTask(db, task.id)).toMatchObject({ status: 'interrupted' })
    } finally {
      readSpy.mockRestore()
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each([
    { deliveryTarget: 'ou-test', expectedStatus: 'delivery-uncertain', deliveryPorts: { sendFeishu: vi.fn(async () => { throw new Error('ack missing') }) } },
    { deliveryTarget: undefined, expectedStatus: 'failed-degraded', deliveryPorts: {} },
    { deliveryTarget: 'ou-test', expectedStatus: 'pending', deliveryPorts: { sendFeishu: vi.fn(async () => undefined), isFeishuReachable: () => false } },
    { deliveryTarget: 'ou-test', expectedStatus: 'delivered', deliveryPorts: { sendFeishu: vi.fn(async () => undefined) } }
  ] as const)('IM 投递为 $expectedStatus 时不伪记 deliveredAt', async ({ deliveryTarget, expectedStatus, deliveryPorts }) => {
    const task = createAutomationTask(db, {
      name: '不确定送达', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '检查状态', deliveryPref: 'feishu', workDirs: [testWorkDir], ...(deliveryTarget ? { deliveryTarget } : {})
    })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: '检查完成' }], stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 4 }
          }))
        }))
      }
    })

    const result = await runButlerTask(makeDeps({ deliveryPorts }), task.id, { trigger: 'manual', requestId: `req-butler-${expectedStatus}-delivery-at` })

    expect(result).toMatchObject({ ok: true, deliveryStatus: expectedStatus })
    if (expectedStatus === 'delivered') expect(getLatestRunForTask(db, task.id)?.deliveredAt).toEqual(expect.any(Number))
    else expect(getLatestRunForTask(db, task.id)?.deliveredAt).toBeUndefined()
  })

  it('Automation Anthropic invocation freezes a provider route from resolved service credentials', async () => {
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')?.[0]
    expect(modelId).toBeTruthy()
    const previousRuntime = getDefaultAgentRuntime()
    setDefaultAgentRuntime(createDesktopAgentRuntime())
    const runLoop = vi.spyOn(toolChatLoop, 'runToolChatSession').mockResolvedValue({
      ok: true, content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn'
    })
    try {
      setConfigValue(db, 'config.defaultModel', modelId!)
      const task = createAutomationTask(db, {
        name: 'provider route test', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'summarize status', deliveryPref: 'none', workDirs: [testWorkDir]
      })
      await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-butler-provider-route' })
      const invocation = runLoop.mock.calls[0]?.[0] as { profile: { providerRouteId?: string }; acceptedTurn?: { turnId: string; requestId: string; currentUserMessageId: string } } | undefined
      const runOptions = runLoop.mock.calls[0]?.[2] as { onHostedTurnHandoff?: unknown } | undefined
      expect(invocation?.profile.providerRouteId).toBeTruthy()
      expect(invocation?.acceptedTurn).toMatchObject({
        turnId: expect.any(String), requestId: 'req-butler-provider-route', currentUserMessageId: expect.any(String)
      })
      expect(runOptions?.onHostedTurnHandoff).toEqual(expect.any(Function))
      expect(getDefaultAgentRuntime().modelProviders.getRoute(invocation!.profile.providerRouteId!)).toMatchObject({
        profile: { modelId, endpoint: 'https://mock.local' },
        providerId: 'pi-ai-anthropic-messages'
      })
    } finally {
      runLoop.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
    }
  })

  it('Automation rejects a changed accepted prompt before Hosted/provider execution', async () => {
    const task = createAutomationTask(db, {
      name: 'accepted prompt guard', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'original accepted prompt', deliveryPref: 'none', workDirs: [testWorkDir]
    })
    const runtime = makeRuntime(db)
    const prepare = runtime.prepare.bind(runtime)
    vi.spyOn(runtime, 'prepare').mockImplementation((intent) => {
      const started = prepare(intent)
      getDbConnection(db).prepare('UPDATE messages SET content = ? WHERE id = ?').run('mutated prompt', started.userMessage?.id)
      return started
    })
    const runLoop = vi.spyOn(toolChatLoop, 'runToolChatSession').mockResolvedValue({
      ok: true, content: [{ type: 'text', text: 'unexpected model response' }], stopReason: 'end_turn'
    })
    try {
      const result = await runButlerTask(makeDeps({ turnRuntime: runtime }), task.id, {
        trigger: 'manual', requestId: 'req-butler-input-mismatch'
      })

      expect(result).toMatchObject({ ok: false, error: 'TURN_USER_INPUT_FINGERPRINT_MISMATCH' })
      expect(runLoop).not.toHaveBeenCalled()
      expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-input-mismatch')
      expect(history.events.filter((event) => event.kind === 'model-request-started')).toHaveLength(0)
    } finally {
      runLoop.mockRestore()
    }
  })

  it('Automation Hosted Runtime composition failure stops provider and tool execution', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-runtime-compose-failure-'))
    const requestId = 'req-butler-runtime-compose-failure'
    const executor = vi.spyOn(readFileExecutor, 'execute')
    hostedRuntimeFailureInjection.requestId = requestId
    try {
      await fs.writeFile(path.join(workDir, 'note.txt'), 'must not be read')
      const task = createAutomationTask(db, {
        name: 'hosted runtime compose failure', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
      })
      let createdSessionId: string | undefined
      mockCreateAnthropicClient.mockReturnValue({
        messages: { stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'tool_use', id: 'butler-compose-failure-read', name: 'read_file', input: { path: 'note.txt' } }],
            stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 4 }
          }))
        })) }
      })
      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir,
        onSessionCreated: (session: { id: string }) => { createdSessionId = session.id }
      }), task.id, { trigger: 'manual', requestId })

      expect(result.ok).toBe(false)
      expect(hostedRuntimeFailureInjection.composeCalls).toBe(1)
      expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()
      expect(createdSessionId).toBeTruthy()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.some((event) => event.kind === 'invocation-failed')).toBe(true)
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      const session = getSession(db, createdSessionId!)!
      const sink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_call' || event.type === 'tool_result')).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'failed' })
      } finally { await sink.close() }
    } finally {
      executor.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['turn_start', 'tool_call'] as const)('Automation Hosted %s secondary ledger failure preserves canonical History and continues tool dispatch', async (failedEvent) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-ledger-failure-'))
    try {
      await fs.writeFile(path.join(workDir, 'note.txt'), 'must not be read')
      const task = createAutomationTask(db, {
        name: 'ledger projection failure',
        schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
      })
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              if (providerCalls > 1) return {
                content: [{ type: 'text', text: 'finished after secondary ledger failure' }],
                stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 4 }
              }
              return {
                content: [{ type: 'tool_use', id: 'butler-ledger-read', name: 'read_file', input: { path: 'note.txt' } }],
                stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 4 }
              }
            })
          }))
        }
      })
      sessionEventFailure.nextType = failedEvent

      const result = await runButlerTask(makeDeps({ getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir }), task.id, {
        trigger: 'manual', requestId: 'req-butler-ledger-projection-failure'
      })

      expect(result).toMatchObject({ ok: true, summary: 'finished after secondary ledger failure' })
      expect(providerCalls).toBe(2)
      expect(getLatestRunForTask(db, task.id)?.status).toBe('completed')
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-ledger-projection-failure')
      expect(history.events.map((event) => event.kind)).toContain('model-response-committed')
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'butler-ledger-read' })
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({ toolCallId: 'butler-ledger-read' })
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-not-dispatched')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted provider failure closes the started SessionEvent turn', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-terminal-failure-'))
    try {
      const task = createAutomationTask(db, {
        name: 'provider terminal failure', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'respond', deliveryPref: 'none', workDirs: [workDir]
      })
      mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => { throw new Error('injected provider failure') })
      })) } })
      let createdSessionId = ''

      const result = await runButlerTask(makeDeps({ getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir, onSessionCreated: (session: { id: string }) => { createdSessionId = session.id } }), task.id, {
        trigger: 'manual', requestId: 'req-butler-terminal-failure'
      })

      expect(result).toMatchObject({ ok: false, error: 'injected provider failure' })
      expect(getLatestRunForTask(db, task.id)).toMatchObject({ status: 'failed', error: 'injected provider failure' })
      const canonical = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-terminal-failure')
      expect(canonical.events.filter((event) => ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind)))
        .toEqual([expect.objectContaining({ kind: 'invocation-failed' })])
      const session = getSession(db, createdSessionId)!
      const sink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        const turnId = projected.find((event) => event.type === 'turn_start')?.payload.turnId
        expect(turnId).toEqual(expect.any(String))
        const turnEnd = projected.find((event) => event.type === 'turn_end')
        expect(turnEnd?.payload.turnId).toBe(turnId)
        expect(turnEnd?.payload.reason).toBe('failed')
      } finally { await sink.close() }
    } finally { await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it('Automation repairs a failed terminal projection from completed canonical History on restart', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-terminal-recovery-'))
    const dbPath = path.join(workDir, 'automation.db')
    let createdSessionId = ''
    try {
      db.close()
      db = openDatabase(dbPath)
      const defaultModelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
      setConfigValue(db, 'config.defaultModel', defaultModelId)
      setConfigValue(db, 'config.models', JSON.stringify([{ id: defaultModelId, name: defaultModelId, enabled: true, supportsThinking: true, maximumContext: 200000, maxTokens: 8192 }]))
      const task = createAutomationTask(db, {
        name: 'terminal projection recovery', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'respond', deliveryPref: 'none', workDirs: [workDir]
      })
      mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => ({
          content: [{ type: 'text', text: 'canonical automation result' }],
          stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 }
        }))
      })) } })
      sessionEventFailure.nextType = 'turn_end'

      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir,
        onSessionCreated: (session: { id: string }) => { createdSessionId = session.id }
      }), task.id, { trigger: 'manual', requestId: 'req-butler-terminal-recovery' })

      expect(result).toMatchObject({ ok: true, summary: 'canonical automation result' })
      const session = getSession(db, createdSessionId)!
      const beforeRecoverySink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      let beforeRecovery: Awaited<ReturnType<typeof readSessionEvents>>
      try { beforeRecovery = await readSessionEvents(beforeRecoverySink.eventsPath) }
      finally { await beforeRecoverySink.close() }
      expect(beforeRecovery.some((event) => event.type === 'turn_end')).toBe(false)

      const history = new SqliteAgentHistory(getDbConnection(db))
      const repairs = {
        repairInvocationTerminal: async (location: { workDir: string; sessionId: string; createdAt: number }, terminal: Record<string, unknown>) => {
          const recoverySink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
          try { await ensureTurnEndEvent(recoverySink, String(terminal.turnId), String(terminal.reason)) }
          finally { await recoverySink.close() }
        }
      }
      // Reopen the SQLite file before repair to model process restart, rather than
      // relying on the in-memory connection that committed the Hosted terminal.
      db.close()
      db = openDatabase(dbPath)
      const restartedHistory = new SqliteAgentHistory(getDbConnection(db))
      const recoveryErrors: unknown[] = []
      await restartedHistory.recoverInterruptedInvocations({ ...repairs, onInvocationTerminalRepairError: (error) => recoveryErrors.push(error) })
      await restartedHistory.recoverInterruptedInvocations({ ...repairs, onInvocationTerminalRepairError: (error) => recoveryErrors.push(error) })
      const recoveredSink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      try {
        const recovered = await readSessionEvents(recoveredSink.eventsPath)
        const canonical = await restartedHistory.read('req-butler-terminal-recovery')
        const acceptedInput = canonical.events[0]
        const context = canonical.events.find((event) => event.kind === 'invocation-context-committed')
        const requiredUserMessage = (context?.payload as { requiredUserMessage?: { id?: unknown } } | undefined)?.requiredUserMessage
        const terminal = canonical.events.at(-1)
        const turnId = (recovered.find((event) => event.type === 'turn_start')?.payload.turnId)
        expect(recoveryErrors).toEqual([])
        expect(acceptedInput).toMatchObject({
          kind: 'session-input-committed', sequence: 1,
          payload: { sessionId: session.id, role: 'user', messageId: expect.any(String), inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }
        })
        expect(requiredUserMessage?.id).toBe((acceptedInput.payload as { messageId: string }).messageId)
        expect(terminal).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed', sessionLedger: { turnId, reason: 'completed' } } })
        expect(recovered.filter((event) => event.type === 'turn_end')).toEqual([
          expect.objectContaining({ type: 'turn_end', payload: { turnId, reason: 'completed' } })
        ])
      } finally { await recoveredSink.close() }
    } finally { await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it('Automation completes a turn after its SessionEvent tool-result projection fails', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-result-recovery-'))
    let createdSessionId = ''
    try {
      await fs.writeFile(path.join(workDir, 'note.txt'), 'committed canonical tool result')
      const task = createAutomationTask(db, {
        name: 'tool result projection recovery', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
      })
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => {
          providerCalls += 1
          return providerCalls === 1
            ? { content: [{ type: 'tool_use', id: 'butler-result-recovery-read', name: 'read_file', input: { path: 'note.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 4 } }
            : { content: [{ type: 'text', text: 'read completed' }], stop_reason: 'end_turn', usage: { input_tokens: 14, output_tokens: 3 } }
        })
      })) } })
      const executor = vi.spyOn(readFileExecutor, 'execute')
      sessionEventFailure.nextType = 'tool_result'

      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir,
        onSessionCreated: (session: { id: string }) => { createdSessionId = session.id }
      }), task.id, { trigger: 'manual', requestId: 'req-butler-result-recovery' })

      expect(result).toMatchObject({ ok: true, summary: 'read completed' })
      expect(getLatestRunForTask(db, task.id)).toMatchObject({ status: 'completed' })
      expect(providerCalls).toBe(2)
      expect(executor).toHaveBeenCalledOnce()
      const session = getSession(db, createdSessionId)!
      const beforeRecoverySink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      let beforeRecovery: Awaited<ReturnType<typeof readSessionEvents>>
      try { beforeRecovery = await readSessionEvents(beforeRecoverySink.eventsPath) }
      finally { await beforeRecoverySink.close() }
      expect(beforeRecovery.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)

      const history = new SqliteAgentHistory(getDbConnection(db))
      const canonicalEvents = (await history.read('req-butler-result-recovery')).events
      const canonicalResult = canonicalEvents.find((event) => event.kind === 'tool-call-finished')
      const resultTurnId = canonicalResult!.turnId
      expect(canonicalResult?.payload).toMatchObject({ toolCallId: 'butler-result-recovery-read', sessionLedger: {
        location: { workDir: automationEventsRoot(task.id), sessionId: session.id, createdAt: session.createdAt }, result: expect.any(Object)
      } })
      expect(canonicalEvents.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      expect(canonicalResult?.payload).toMatchObject({ toolCallId: 'butler-result-recovery-read', sessionLedger: { result: expect.any(Object) } })
      expect(executor).toHaveBeenCalledOnce()
    } finally { await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it.each([
    { caseName: 'read_file', toolName: 'read_file', callId: 'butler-read-parity', toolInput: { path: 'note.txt' } },
    { caseName: 'list_directory', toolName: 'list_directory', callId: 'butler-directory-parity', toolInput: { path: 'listing-target' } },
    { caseName: 'grep', toolName: 'grep', callId: 'butler-grep-parity', toolInput: { pattern: 'canonical', path: 'note.txt', output_mode: 'content' } }
  ])('Automation Hosted $caseName projections recover exactly from canonical History', async ({ toolName, callId, toolInput }) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-history-parity-'))
    const dbPath = path.join(workDir, 'automation-history.db')
    let sink: ReturnType<typeof getSessionEventSink> | undefined
    try {
      db.close()
      db = openDatabase(dbPath)
      const defaultModelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
      setConfigValue(db, 'config.defaultModel', defaultModelId)
      setConfigValue(db, 'config.models', JSON.stringify([{ id: defaultModelId, name: defaultModelId, enabled: true, supportsThinking: true, maximumContext: 200000, maxTokens: 8192 }]))
      const listingTarget = path.join(workDir, 'listing-target')
      if (toolName === 'list_directory') await fs.mkdir(listingTarget)
      await fs.writeFile(path.join(toolName === 'list_directory' ? listingTarget : workDir, 'note.txt'), 'automation canonical read')
      if (toolName === 'grep') {
        const fixtureRg = path.join(workDir, 'fixture-rg')
        await fs.writeFile(fixtureRg, "#!/bin/sh\nprintf '%s\\n' 'note.txt:1:automation canonical read'\n")
        await fs.chmod(fixtureRg, 0o755)
        ripgrepFixture.path = fixtureRg
      }
      const taskInput = {
        name: 'history parity', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
      }
      const task = toolName === 'grep'
        ? createAutomationTaskWithToolPermission(db, taskInput, { kind: 'grep', scopeRoots: [workDir] })
        : createAutomationTask(db, taskInput)
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: callId, name: toolName, input: toolInput }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 4 }
                  }
                : {
                    content: [{ type: 'text', text: 'The file says automation canonical read.' }],
                    stop_reason: 'end_turn', usage: { input_tokens: 24, output_tokens: 8 }
                  }
            })
          }))
        }
      })

      const requestId = 'req-butler-history-parity'
      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId })

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, summary: 'The file says automation canonical read.' })
      expect(providerCalls).toBe(2)
      const acceptedTurn = getDbConnection(db).prepare('SELECT turn_id AS turnId FROM turns WHERE request_id = ?').get(requestId) as { turnId: string }
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(acceptedTurn.turnId)
      const session = getSession(db, getLatestRunForTask(db, task.id)!.sessionId!)!
      sink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      const projected = await readSessionEvents(sink.eventsPath)
      const canonicalRequests = history.events.filter((event) => event.kind === 'model-request-started')
      expect(canonicalRequests).toHaveLength(2)
      for (const request of canonicalRequests) {
        const ledger = request.payload.sessionLedger as { location?: unknown; requestHeader?: { requestId?: unknown }; requestContext?: { requestId?: unknown } } | undefined
        expect(ledger).toMatchObject({
          location: { workDir: automationEventsRoot(task.id), sessionId: session.id, createdAt: session.createdAt },
          requestHeader: { requestId: expect.any(String) },
          requestContext: { requestId: expect.any(String) }
        })
        expect(projected.filter((event) => event.type === 'request_header').map((event) => event.payload))
          .toContainEqual(ledger!.requestHeader)
      }
      const canonicalToolCalls = history.events
        .filter((event) => event.kind === 'model-response-committed')
        .flatMap((event) => ((event.payload.sessionLedger as { toolCalls?: Array<{ toolUseId: string; name: string; args: unknown }> } | undefined)?.toolCalls ?? []))
        .map(({ toolUseId, name, args }) => ({ toolUseId, name, args }))
      expect(projected.filter((event) => event.type === 'tool_call').map(({ payload }) => ({
        toolUseId: payload.toolUseId, name: payload.name, args: payload.args
      }))).toEqual(canonicalToolCalls)
      const canonicalToolResults = history.events
        .filter((event) => event.kind === 'tool-call-finished')
        .map((event) => ({ toolUseId: event.payload.toolCallId, result: (event.payload.sessionLedger as { result?: unknown } | undefined)?.result }))
      expect(projected.filter((event) => event.type === 'tool_result').map(({ payload }) => ({
        toolUseId: payload.toolUseId, result: payload.result
      }))).toEqual(canonicalToolResults)
      expect(canonicalToolCalls).toEqual([{ toolUseId: callId, name: toolName, args: toolInput }])
      expect(canonicalToolResults).toHaveLength(1)
      expect(canonicalToolResults[0]?.toolUseId).toBe(callId)
      if (toolName === 'list_directory') {
        expect(canonicalToolResults[0]?.result).toMatchObject({
          success: true, data: { entries: expect.arrayContaining([expect.objectContaining({ name: 'note.txt' })]) }
        })
      } else if (toolName === 'grep') {
        expect(canonicalToolResults[0]?.result, JSON.stringify(canonicalToolResults[0]?.result)).toMatchObject({ success: true })
        expect(JSON.stringify(canonicalToolResults[0]?.result)).toContain('automation canonical read')
      } else {
        expect(canonicalToolResults[0]?.result).toMatchObject({ success: true, data: { content: 'automation canonical read' } })
      }

      expect(projected.filter((event) => event.type === 'turn_start' || event.type === 'turn_end')).toEqual([
        expect.objectContaining({ type: 'turn_start', payload: { turnId: expect.any(String) } }),
        expect.objectContaining({ type: 'turn_end', payload: { turnId: expect.any(String), reason: 'completed' } })
      ])

      await sink.close()
      const existingLines = (await fs.readFile(sink.eventsPath, 'utf8')).trim().split('\n')
      const crashWindowLines = existingLines.filter((line) => ![
        'request_header', 'request_context', 'request_usage', 'tool_call', 'tool_result'
      ].includes(JSON.parse(line).type))
      await fs.writeFile(sink.eventsPath, `${crashWindowLines.join('\n')}\n`, 'utf8')
      // Reopen both durable stores before reconstruction to cross a real process boundary.
      db.close()
      db = openDatabase(dbPath)
      const withRecoverySink = async <T>(location: { workDir: string; sessionId: string; createdAt: number }, repair: (repairSink: ReturnType<typeof getSessionEventSink>) => Promise<T>) => {
        const recoverySink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        try { await repair(recoverySink) }
        finally { await recoverySink.close() }
      }
      const historyAdapter = new SqliteAgentHistory(getDbConnection(db))
      const recoveryErrors: unknown[] = []
      const repairs = {
        repairInvocationTerminal: (location: { workDir: string; sessionId: string; createdAt: number }, terminal: Record<string, unknown>) =>
          withRecoverySink(location, (recoverySink) => ensureTurnEndEvent(recoverySink, String(terminal.turnId), String(terminal.reason))),
        repairModelRequestLedger: (location: { workDir: string; sessionId: string; createdAt: number }, projection: Record<string, unknown>) =>
          withRecoverySink(location, (recoverySink) => ensureRequestProjectionEvents(recoverySink, projection as never)),
        repairToolCallLedger: (location: { workDir: string; sessionId: string; createdAt: number }, proposal: Record<string, unknown>) =>
          withRecoverySink(location, (recoverySink) => ensureToolCallEvent(recoverySink, proposal as never)),
        repairToolLedger: (location: { workDir: string; sessionId: string; createdAt: number }, result: Record<string, unknown>) =>
          withRecoverySink(location, (recoverySink) => ensureToolResultEvent(recoverySink, result as never)),
        repairUsageLedger: (location: { workDir: string; sessionId: string; createdAt: number }, usage: Record<string, unknown>) =>
          withRecoverySink(location, (recoverySink) => ensureRequestUsageEvent(recoverySink, usage as never)),
        repairFinalRequestContextLedger: (location: { workDir: string; sessionId: string; createdAt: number }, context: Record<string, unknown>) =>
          withRecoverySink(location, (recoverySink) => ensureFinalRequestContextEvent(recoverySink, context as never))
      }
      await historyAdapter.recoverInterruptedInvocations({ ...repairs,
        onModelRequestLedgerRepairError: (error) => recoveryErrors.push(error),
        onUsageLedgerRepairError: (error) => recoveryErrors.push(error),
        onToolLedgerRepairError: (error) => recoveryErrors.push(error),
        onInvocationTerminalRepairError: (error) => recoveryErrors.push(error)
      })
      await historyAdapter.recoverInterruptedInvocations({ ...repairs,
        onModelRequestLedgerRepairError: (error) => recoveryErrors.push(error),
        onUsageLedgerRepairError: (error) => recoveryErrors.push(error),
        onToolLedgerRepairError: (error) => recoveryErrors.push(error),
        onInvocationTerminalRepairError: (error) => recoveryErrors.push(error)
      })
      const recoveredSink = getSessionEventSink(automationEventsRoot(task.id), session.id, session.createdAt)
      sink = recoveredSink
      const recovered = await readSessionEvents(recoveredSink.eventsPath)
      expect(recoveryErrors).toEqual([])
      expect(recovered.filter((event) => event.type === 'request_header')).toHaveLength(2)
      expect(recovered.filter((event) => event.type === 'request_context')).toHaveLength(4)
      expect(recovered.filter((event) => event.type === 'request_usage')).toHaveLength(2)
      expect(recovered.filter((event) => event.type === 'tool_call')).toHaveLength(1)
      expect(recovered.filter((event) => event.type === 'tool_result')).toHaveLength(1)
      expect(recovered.filter((event) => event.type === 'turn_end')).toHaveLength(1)
      for (const type of ['request_header', 'request_context', 'request_usage', 'tool_call', 'tool_result'] as const) {
        expect(recovered.filter((event) => event.type === type).map(({ payload }) => payload))
          .toEqual(projected.filter((event) => event.type === type).map(({ payload }) => payload))
      }
      for (const type of ['request_header', 'request_context', 'request_usage', 'tool_call', 'tool_result'] as const) {
        expect(recovered.filter((event) => event.type === type).map(({ payload }) => payload))
          .toEqual(projected.filter((event) => event.type === type).map(({ payload }) => payload))
      }
    } finally {
      await sink?.close()
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted handoff rejects stale legacy transcript when canonical session History exists', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-canonical-transcript-'))
    try {
      const task = createAutomationTask(db, {
        name: 'canonical transcript cutover', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'current automation prompt', deliveryPref: 'none', workDirs: [workDir]
      })
      mockCreateAnthropicClient.mockReturnValue({
        messages: { stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'provider should not run' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
        })) }
      })
      let seededSessionId = ''
      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir,
        onSessionCreated: (session: { id: string }) => {
          seededSessionId = session.id
          appendMessage(db, { id: 'stale-legacy-context', sessionId: session.id, role: 'user', content: 'stale legacy context', timestamp: 1, status: 'sent' })
          appendMessage(db, { id: 'stale-legacy-assistant', sessionId: session.id, role: 'assistant', content: 'stale legacy answer', timestamp: 2, status: 'sent' })
          const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
          void history.appendBatch([
            { invocationId: 'prior-automation', turnId: 'prior-automation-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-automation-context', idempotencyKey: 'prior-automation-context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'canonical prior context' }] } },
            { invocationId: 'prior-automation', turnId: 'prior-automation-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-automation-done', idempotencyKey: 'prior-automation-done', kind: 'invocation-completed', payload: { status: 'completed' } }
          ], 0)
        }
      }), task.id, { trigger: 'manual', requestId: 'req-butler-canonical-transcript' })

      expect(seededSessionId).toBeTruthy()
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Canonical session History could not safely provide the Hosted transcript') })
      expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    } finally {
      ripgrepFixture.path = ''
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted run_shell locked deny returns an error tool result without executing', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-shell-deny-'))
    const sentinelPath = path.join(workDir, 'must-not-exist.txt')
    try {
      const task = createAutomationTask(db, {
        name: 'locked shell deny', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'do not execute unauthorized shell commands', deliveryPref: 'none', workDirs: [workDir]
      })
      const justification = '核对自动化任务的工作目录，以便生成运行状态摘要。'
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: 'butler-shell-denied', name: 'run_shell', input: { command: `printf denied > '${sentinelPath}'`, justification } }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 4 }
                  }
                : {
                    content: [{ type: 'text', text: 'The shell command was blocked by automation policy.' }],
                    stop_reason: 'end_turn', usage: { input_tokens: 24, output_tokens: 8 }
                  }
            })
          }))
        }
      })

      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir,
        getShellConfig: () => ({ ...DEFAULT_SHELL_CONFIG, rules: [] })
      }), task.id, { trigger: 'manual', requestId: 'req-butler-hosted-shell-deny' })

      expect(result).toMatchObject({ ok: true, summary: 'The shell command was blocked by automation policy.' })
      expect(providerCalls).toBe(2)
      await expect(fs.access(sentinelPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-hosted-shell-deny')
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'butler-shell-denied', reason: 'POLICY_DENY'
      })
      expect(history.events.find((event) => event.kind === 'model-response-committed')?.payload).toMatchObject({
        message: { toolCalls: [{ id: 'butler-shell-denied', input: { command: `printf denied > '${sentinelPath}'`, justification } }] }
      })
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-started')
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-finished')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted run_script locked deny returns an error tool result without executing', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-script-deny-'))
    const sentinelPath = path.join(workDir, 'must-not-exist.txt')
    try {
      const task = createAutomationTask(db, {
        name: 'locked script deny', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'do not execute scripts with unresolved file access', deliveryPref: 'none', workDirs: [workDir]
      })
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{
                      type: 'tool_use', id: 'butler-script-denied', name: 'run_script',
                      input: { language: 'python', code: `open(str(__import__('pathlib').Path('${sentinelPath}')), 'w').write('denied')` }
                    }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
                  }
                : {
                    content: [{ type: 'text', text: 'The script was blocked by automation policy.' }],
                    stop_reason: 'end_turn', usage: { input_tokens: 24, output_tokens: 8 }
                  }
            })
          }))
        }
      })

      const result = await runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId: 'req-butler-hosted-script-deny' })

      expect(result).toMatchObject({ ok: true, summary: 'The script was blocked by automation policy.' })
      expect(providerCalls).toBe(2)
      await expect(fs.access(sentinelPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-hosted-script-deny')
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'butler-script-denied', reason: 'POLICY_DENY'
      })
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-started')
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-finished')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted read_file revocation after claim records unknown terminal without replay', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-read-revoke-'))
    const originalExecute = readFileExecutor.execute
    try {
      await fs.writeFile(path.join(workDir, 'note.txt'), 'authorized read')
      const task = createAutomationTask(db, {
        name: 'read revocation', schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
      })
      let providerCalls = 0
      let executorSignal: AbortSignal | undefined
      let markEntered!: () => void
      const entered = new Promise<void>((resolve) => { markEntered = resolve })
      const runtime = getDefaultAgentRuntime()
      const executeSpy = vi.spyOn(readFileExecutor, 'execute').mockImplementation(async (_input, context) => {
        executorSignal = context.signal
        markEntered()
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { success: false, error: 'READ_CANCELLED', userMessage: 'read cancelled' }
      })
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: 'butler-read-revoked', name: 'read_file', input: { path: 'note.txt' } }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
                  }
                : {
                    content: [{ type: 'text', text: 'The running read was cancelled after revocation.' }],
                    stop_reason: 'end_turn', usage: { input_tokens: 24, output_tokens: 8 }
                  }
            })
          }))
        }
      })

      const runningTask = runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId: 'req-butler-hosted-read-revoke' })
      await entered
      expect(executorSignal?.aborted).toBe(false)
      expect(runtime.toolRevocations.revokeToolForLane('automation', 'read_file')).toBe(1)
      const result = await runningTask

      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/invocation lifecycle invalidated|tool execution failed after dispatch/) })
      expect(providerCalls).toBe(1)
      expect(executorSignal?.aborted).toBe(true)
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-hosted-read-revoke')
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'butler-read-revoked' })
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'authorization-revoked' }
      })
      expect(history.events.some((event) => event.kind === 'tool-call-finished')).toBe(true)
      expect((runtime.executionAdmission as unknown as { activeLeaseCount(requestId: string): number }).activeLeaseCount('req-butler-hosted-read-revoke')).toBe(0)
      expect(executeSpy).toHaveBeenCalledOnce()
    } finally {
      readFileExecutor.execute = originalExecute
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted request cancellation after executor claim records unknown terminal without retry', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-read-cancel-'))
    const originalExecute = readFileExecutor.execute
    const task = createAutomationTask(db, {
      name: 'read cancellation', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
    })
    const runtime = getDefaultAgentRuntime()
    const requestId = 'req-butler-hosted-read-cancel'
    let providerCalls = 0
    let executorSignal: AbortSignal | undefined
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const executeSpy = vi.spyOn(readFileExecutor, 'execute').mockImplementation(async (_input, context) => {
      executorSignal = context.signal
      markEntered()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('read result became unknown after request cancellation')), { once: true })
      })
    })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => {
            providerCalls += 1
            return {
              content: [{ type: 'tool_use', id: 'butler-read-cancelled-after-claim', name: 'read_file', input: { path: 'note.txt' } }],
              stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
            }
          })
        }))
      }
    })

    try {
      await fs.writeFile(path.join(workDir, 'note.txt'), 'authorized read')
      const runningTask = runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId })
      await entered
      expect(executorSignal?.aborted).toBe(false)
      runtime.chatCancels.signalChatCancel(cancellationIdForRequest(requestId))
      const result = await runningTask
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/agent turn cancelled|invocation lifecycle invalidated|tool execution failed after dispatch/) })

      expect(providerCalls).toBe(1)
      expect(executorSignal?.aborted).toBe(true)
      expect(executeSpy).toHaveBeenCalledOnce()
      const acceptedTurn = getDbConnection(db).prepare('SELECT turn_id AS turnId FROM turns WHERE request_id = ?').get(requestId) as { turnId: string }
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(acceptedTurn.turnId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'butler-read-cancelled-after-claim' })
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted', payload: { status: 'cancelled' }
      })
      expect(history.events.some((event) => event.kind === 'tool-call-finished')).toBe(true)
      expect((runtime.executionAdmission as unknown as { activeLeaseCount(requestId: string): number }).activeLeaseCount(requestId)).toBe(0)
    } finally {
      runtime.chatCancels.signalChatCancel(cancellationIdForRequest(requestId))
      runtime.chatCancels.clear(cancellationIdForRequest(requestId))
      readFileExecutor.execute = originalExecute
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each([
    { toolName: 'list_directory', callId: 'butler-directory-late-result', input: { path: '.' } },
    { toolName: 'grep', callId: 'butler-grep-late-result', input: { pattern: 'authorized', path: 'note.txt', output_mode: 'content' } }
  ].flatMap((tool) => (['revoke', 'cancel'] as const).map((termination) => ({ ...tool, termination }))))(
    'Automation Hosted $toolName does not project a late result after claimed $termination', async ({ toolName, callId, input, termination }) => {
      const requestId = `req-butler-${toolName}-late-${termination}`
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `butler-${toolName}-late-${termination}-`))
      const taskInput = {
        name: `${toolName} late result`, schedule: { kind: 'interval', intervalMinutes: 30 },
        prompt: `use ${toolName}`, deliveryPref: 'none', workDirs: [workDir]
      }
      const task = toolName === 'grep'
        ? createAutomationTaskWithToolPermission(db, taskInput, { kind: 'grep', scopeRoots: [workDir] })
        : createAutomationTask(db, taskInput)
      let createdSessionId: string | undefined
      const runtime = getDefaultAgentRuntime()
      const executor = toolName === 'list_directory' ? listDirectoryExecutor : grepExecutor
      let entered!: () => void
      const executionEntered = new Promise<void>((resolve) => { entered = resolve })
      let signal: AbortSignal | undefined
      const executorSpy = vi.spyOn(executor, 'execute').mockImplementation(async (_input, context) => {
        signal = context.signal
        entered()
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
        return toolName === 'list_directory'
          ? { success: true, data: { entries: [{ name: 'late-secret.txt' }] } }
          : { success: true, data: { output: 'late-secret' } }
      })
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({
        messages: { stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => {
            providerCalls += 1
            return {
              content: [{ type: 'tool_use', id: callId, name: toolName, input }],
              stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
            }
          })
        })) }
      })
      try {
        await fs.writeFile(path.join(workDir, 'note.txt'), 'authorized')
        const runningTask = runButlerTask(makeDeps({
          getWorkDir: () => workDir,
          resolveWorkDirForSession: () => workDir,
          onSessionCreated: (session: { id: string }) => { createdSessionId = session.id }
        }), task.id, { trigger: 'manual', requestId })
        await executionEntered
        expect(signal?.aborted).toBe(false)
        if (termination === 'revoke') {
          expect(runtime.toolRevocations.revokeToolForLane('automation', toolName)).toBe(1)
        } else if (termination === 'cancel') {
          runtime.chatCancels.signalChatCancel(cancellationIdForRequest(requestId))
        }
        expect(signal?.aborted).toBe(true)
        const result = await runningTask
        expect(result.ok).toBe(false)
        expect(providerCalls).toBe(1)
        const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
        expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: callId })
        expect(history.events.some((event) => event.kind === 'tool-call-finished')).toBe(true)
        expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: termination === 'cancel'
          ? { status: 'cancelled' }
          : { status: 'interrupted', reason: 'authorization-revoked' } })
        expect(JSON.stringify(history.events)).not.toContain('late-secret')
        expect((runtime.executionAdmission as unknown as { activeLeaseCount(requestId: string): number }).activeLeaseCount(requestId)).toBe(0)
        const session = createdSessionId ? getSession(db, createdSessionId) : undefined
        expect(session).toBeTruthy()
        const sink = getSessionEventSink(automationEventsRoot(task.id), session!.id, session!.createdAt)
        try {
          const events = await readSessionEvents(sink.eventsPath)
          expect(events.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload)), JSON.stringify(events)).toBe(true)
          expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: termination === 'cancel' ? 'cancelled' : 'interrupted' })
          expect(JSON.stringify(events)).not.toContain('late-secret')
        } finally { await sink.close() }
      } finally {
        runtime.chatCancels.clear(requestId)
        runtime.toolRevocations.clearToolRevocationRequest(requestId)
        executorSpy.mockRestore()
        await fs.rm(workDir, { recursive: true, force: true })
      }
    }
  )

  it('automation runtime ignores legacy disabled IDs and keeps system protection rules active', () => {
    writeDisabledPolicyRuleIds(db, ['automation-sensitive-path-deny'])
    expect(readDisabledPolicyRuleIds(db)).toContain('automation-sensitive-path-deny')
    const policy = resolveEffectivePolicyRulesWithOrigin(db, 'automation')
    expect(policy.disabledRuleIds).toEqual([])
    expect(policy.rules.find((rule) => rule.id === 'automation-sensitive-path-deny')?.action).toBe('deny')
  })

  it.each([
    { toolName: 'read_file', toolUseId: 'butler-read-claim-revoked', input: { path: 'note.txt' } },
    { toolName: 'list_directory', toolUseId: 'butler-directory-claim-revoked', input: { path: 'reports' } },
    { toolName: 'grep', toolUseId: 'butler-grep-claim-revoked', input: { pattern: 'needle', path: 'note.txt', output_mode: 'content' } }
  ].flatMap((tool) => (['revoke', 'cancel'] as const).map((termination) => ({ ...tool, termination }))))(
    'Automation Hosted $toolName $termination before dispatch claim prevents executor entry', async ({ toolName, toolUseId, input, termination }) => {
    const requestId = `req-butler-hosted-${toolName}-claim-${termination}`
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `butler-hosted-${toolName}-claim-revoke-`))
    const toolPath = path.join(workDir, toolName === 'list_directory' ? 'reports' : 'note.txt')
    const taskInput = {
      name: `${toolName} claim revocation`, schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: `${toolName} authorized read`, deliveryPref: 'none', workDirs: [workDir]
    }
    const task = toolName === 'grep'
      ? createAutomationTaskWithToolPermission(db, taskInput, { kind: 'grep', scopeRoots: [workDir] })
      : createAutomationTask(db, taskInput)
    const runtime = getDefaultAgentRuntime()
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const executor = vi.spyOn(toolName === 'list_directory' ? listDirectoryExecutor : toolName === 'grep' ? grepExecutor : readFileExecutor, 'execute')
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
    try {
      if (toolName === 'list_directory') {
        await fs.mkdir(toolPath)
        await fs.writeFile(path.join(toolPath, 'entry.txt'), 'must not list')
      } else {
        await fs.writeFile(toolPath, 'must not read needle')
      }
      let providerCalls = 0
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
                  }
                : { content: [{ type: 'text', text: 'The requested read was not dispatched.' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } }
            })
          }))
        }
      })

      const runningTask = runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('automation', toolName)).toBe(1)
      } else if (termination === 'cancel') {
        runtime.chatCancels.signalChatCancel(cancellationIdForRequest(requestId))
      }
      releaseClaim()
      const result = await runningTask

        expect(result.ok).toBe(false)
      expect(executor).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: toolUseId,
        reason: termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-started')
      expect(history.events.map((event) => event.kind)).not.toContain('tool-call-finished')
      if (termination === 'cancel') {
        expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
      }
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted read_file rejects a replaced target after permit preparation', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-read-target-drift-'))
    const targetPath = path.join(workDir, 'note.txt')
    const task = createAutomationTask(db, {
      name: 'read target drift', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'read note.txt', deliveryPref: 'none', workDirs: [workDir]
    })
    const runtime = getDefaultAgentRuntime()
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const executor = vi.spyOn(readFileExecutor, 'execute')
    let providerCalls = 0
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
    try {
      await fs.writeFile(targetPath, 'authorized original')
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: 'butler-read-target-drift', name: 'read_file', input: { path: 'note.txt' } }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
                  }
                : { content: [{ type: 'text', text: 'Target changed; read denied.' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } }
            })
          }))
        }
      })

      const runningTask = runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId: 'req-butler-hosted-read-target-drift' })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      await fs.rename(targetPath, `${targetPath}.authorized`)
      await fs.writeFile(targetPath, 'replacement secret')
      releaseClaim()
      const result = await runningTask

      expect(result).toMatchObject({ ok: true, summary: 'Target changed; read denied.' })
      expect(providerCalls).toBe(2)
      expect(executor).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-hosted-read-target-drift')
      expect(history.events).toContainEqual(expect.objectContaining({
        kind: 'tool-call-finished',
        payload: expect.objectContaining({
          toolCallId: 'butler-read-target-drift',
          success: false,
          sessionLedger: expect.objectContaining({
            result: expect.objectContaining({
              success: false,
              data: expect.objectContaining({ diagnostic: expect.objectContaining({ caseId: 'read-target-identity-changed' }) })
            })
          })
        })
      }))
      expect(JSON.stringify(history.events)).not.toContain('replacement secret')
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted list_directory rejects a replaced directory after permit preparation', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-directory-target-drift-'))
    const targetPath = path.join(workDir, 'reports')
    const task = createAutomationTask(db, {
      name: 'directory target drift', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'list the reports directory', deliveryPref: 'none', workDirs: [workDir]
    })
    const runtime = getDefaultAgentRuntime()
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const executor = vi.spyOn(listDirectoryExecutor, 'execute')
    let providerCalls = 0
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
    try {
      await fs.mkdir(targetPath)
      await fs.writeFile(path.join(targetPath, 'authorized.txt'), 'original')
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: 'butler-directory-target-drift', name: 'list_directory', input: { path: 'reports' } }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
                  }
                : { content: [{ type: 'text', text: 'Directory changed; listing denied.' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } }
            })
          }))
        }
      })

      const runningTask = runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId: 'req-butler-hosted-directory-target-drift' })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      await fs.rename(targetPath, `${targetPath}.authorized`)
      await fs.mkdir(targetPath)
      await fs.writeFile(path.join(targetPath, 'replacement.txt'), 'replacement secret')
      releaseClaim()
      const result = await runningTask

      expect(result).toMatchObject({ ok: true, summary: 'Directory changed; listing denied.' })
      expect(providerCalls).toBe(2)
      expect(executor).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-hosted-directory-target-drift')
      expect(history.events.map((event) => event.kind)).toContain('tool-call-finished')
      expect(JSON.stringify(history.events)).toContain('read-directory-identity-changed')
      expect(JSON.stringify(history.events)).not.toContain('replacement secret')
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted grep rejects a replaced target after permit preparation', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-grep-target-drift-'))
    const targetPath = path.join(workDir, 'note.txt')
    const task = createAutomationTaskWithToolPermission(db, {
      name: 'grep target drift', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'search note.txt for status', deliveryPref: 'none', workDirs: [workDir]
    }, { kind: 'grep', scopeRoots: [workDir] })
    const runtime = getDefaultAgentRuntime()
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const executor = vi.spyOn(grepExecutor, 'execute')
    let providerCalls = 0
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
    try {
      await fs.writeFile(targetPath, 'authorized needle')
      mockCreateAnthropicClient.mockReturnValue({
        messages: {
          stream: vi.fn(() => ({
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              providerCalls += 1
              return providerCalls === 1
                ? {
                    content: [{ type: 'tool_use', id: 'butler-grep-target-drift', name: 'grep', input: { pattern: 'needle', path: 'note.txt', output_mode: 'content' } }],
                    stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
                  }
                : { content: [{ type: 'text', text: 'File changed; search denied.' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } }
            })
          }))
        }
      })

      const runningTask = runButlerTask(makeDeps({
        getWorkDir: () => workDir,
        resolveWorkDirForSession: () => workDir
      }), task.id, { trigger: 'manual', requestId: 'req-butler-hosted-grep-target-drift' })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      await fs.rename(targetPath, `${targetPath}.authorized`)
      await fs.writeFile(targetPath, 'replacement needle secret')
      releaseClaim()
      const result = await runningTask

      expect(result).toMatchObject({ ok: true, summary: 'File changed; search denied.' })
      expect(providerCalls).toBe(2)
      expect(executor).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-hosted-grep-target-drift')
      expect(history.events.map((event) => event.kind)).toContain('tool-call-finished')
      expect(JSON.stringify(history.events)).toContain('read-target-identity-changed')
      expect(JSON.stringify(history.events)).not.toContain('replacement needle secret')
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Automation Hosted denies a locked write without starting an approval agent or dispatching the executor', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-hosted-automation-write-deny-'))
    const targetPath = path.join(workDir, 'approved-target.txt')
    const task = createAutomationTask(db, {
      name: 'locked write denial', schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: 'Create approved-target.txt with a short status.', deliveryPref: 'none', workDirs: [workDir]
    })
    let providerCalls = 0
    mockCreateAnthropicClient.mockImplementation(() => ({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => {
        providerCalls += 1
        if (providerCalls === 1) return {
          content: [{ type: 'tool_use', id: 'butler-automation-write-denied', name: 'write_file', input: { path: 'approved-target.txt', content: 'must not write' } }],
          stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 }
        }
        return {
          content: [{ type: 'text', text: '无人值守任务不能写入本地文件。' }],
          stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 }
        }
      })
    })) } }))
    const executeWrite = vi.spyOn(writeFileExecutor, 'execute')

    try {
      const result = await runButlerTask(makeDeps({ getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir }), task.id, {
        trigger: 'manual', requestId: 'req-butler-automation-write-denied'
      })
      expect(result).toMatchObject({ ok: true, summary: '无人值守任务不能写入本地文件。' })
      expect(providerCalls).toBe(2)
      expect(executeWrite).not.toHaveBeenCalled()
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = await new SqliteAgentHistory(getDbConnection(db)).read('req-butler-automation-write-denied')
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'butler-automation-write-denied', reason: 'POLICY_DENY'
      })
      expect(history.events.map((event) => event.kind)).not.toContain('approval-waiting')
      expect(history.events.map((event) => event.kind)).not.toContain('approval-resolved')
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeWrite.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('提示词诱导写文件：门控拒绝（无回答者），回合收敛，run 记录说明拒绝原因', async () => {
    const task = createAutomationTask(db, {
      name: '写文件任务',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '请写入 report.txt',
      deliveryPref: 'none', workDirs: [testWorkDir]
    })
    let round = 0
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => {
          const current = round++
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              if (current === 0) {
                return {
                  content: [{ type: 'tool_use', id: 'tu-w', name: 'write_file', input: { path: 'report.txt', content: 'x' } }],
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 50, output_tokens: 10 }
                }
              }
              return {
                content: [{ type: 'text', text: '写文件操作被安全策略拒绝：automation 无人类应答者，无法确认。' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 80, output_tokens: 20 }
              }
            })
          }
        })
      }
    })

    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-butler-2' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const run = getLatestRunForTask(db, task.id)
    expect(run?.status).toBe('completed')
    expect(run?.resultSummary).toContain('拒绝')
    expect(run?.sessionId).toBeTruthy()
  })
})

describe('管家会话创建推送（渲染端列表即时可见）', () => {
  let pushWorkDir: string | undefined
  afterEach(async () => {
    if (pushWorkDir) await fs.rm(pushWorkDir, { recursive: true, force: true })
    pushWorkDir = undefined
  })

  it('onSessionCreated 在会话创建即回调（调度与手动触发共用），字段含归属与可见性', async () => {
    let db: AppDatabase
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-push-workdir-'))
    pushWorkDir = workDir
    const { openDatabase: openDb2, setConfigValue: setCfg } = await import('../database')
    db = openDb2(':memory:')
    const supportedModelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    setCfg(db, 'config.defaultModel', supportedModelId)
    setCfg(db, 'config.models', JSON.stringify([{ id: supportedModelId, name: supportedModelId, enabled: true, supportsThinking: true, maximumContext: 200000, maxTokens: 8192 }]))
    mockResolveLlmCredentials.mockResolvedValue({
      error: undefined,
      serviceId: 'svc-1',
      baseUrl: 'https://mock.local',
      getApiKey: async () => 'test-key'
    })
    mockResolveLlmCredentialsForPair.mockResolvedValue({ model: { id: supportedModelId, name: supportedModelId, enabled: true, supportsThinking: true }, serviceId: 'svc-1', providerModelName: supportedModelId, baseUrl: 'https://mock.local', getApiKey: async () => 'test-key' })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: '完成' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 }
          }))
        }))
      }
    })
    const task = createStoredAutomationTask(db, {
      name: '推送任务',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '检查',
      deliveryPref: 'none',
      workDirs: [workDir]
    })
    const onSessionCreated = vi.fn()
    const pushedResult = await runButlerTask(
      {
        db,
        sessionStorage: createSqliteSessionStorage(db),
        turnRuntime: makeRuntime(db),
        getWorkDir: () => workDir,
        getActiveWorkDirProfilePath: () => workDir,
        getUserDataPath: () => '/tmp/ud',
        getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG as const }),
        resolveWorkDirForSession: () => workDir,
        onSessionCreated
      },
      task.id,
      { trigger: 'manual', requestId: 'req-push-1' }
    )
    expect(pushedResult.ok, JSON.stringify(pushedResult)).toBe(true)
    expect(onSessionCreated).toHaveBeenCalledTimes(1)
    const pushed = onSessionCreated.mock.calls[0]![0] as { id: string; ownership: string; visibility: string }
    expect(pushed.ownership).toBe('automation')
    expect(pushed.visibility).toBe('section')
    db.close()
  })
})
