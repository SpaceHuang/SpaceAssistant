import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, appendMessage, createPersistedTurn, createSession, setConfigValue, type AppDatabase } from './database'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { MODEL_BASELINE } from '../src/shared/modelBaseline'
import { createAgentRuntime } from './runtime/agentRuntime'
import { createDesktopAgentRuntime } from './runtime/desktopAgentRuntime'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry, writeFileExecutor } from './tools/builtinExecutors'
import { createDesktopAnthropicRouteProfile } from './piAiAnthropicBridge'
import { SqliteAgentHistory } from './runtime/sqliteAgentHistory'
import { getDbConnection } from './database'
import { registerClaudeStreamHandlers } from './testSupport/claudeStreamHandlers'
import { ipcMain } from 'electron'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => true), decryptString: vi.fn((value: Buffer) => value.toString()) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
}))
vi.mock('./agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn() }))
vi.mock('./safeWebContentsSend', () => ({ safeWebContentsSend: vi.fn() }))
vi.mock('./toolConfirmRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./toolConfirmRegistry')>()),
  waitForToolConfirm: vi.fn(async () => 'approved')
}))
vi.mock('./confirmation/approvalAgent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/approvalAgent')>()
  return { ...actual, runApprovalAgent: vi.fn(async () => ({ ok: true,
    verdict: { kind: 'approve', reason: { summary: 'checkpoint retry test' }, riskLevel: 'low', authorization: 'high' } })) }
})
vi.mock('./projectMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./projectMemory')>()), getCachedMemoryContent: vi.fn(() => null)
}))

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function seedTrustedModel(db: AppDatabase, modelId: string): void {
  setConfigValue(db, 'config.models', JSON.stringify([
    { id: modelId, name: modelId, maximumContext: MODEL_BASELINE[modelId]!.maximumContext,
      maxTokens: MODEL_BASELINE[modelId]!.maxTokens, isDefault: false, isFast: false, isVision: false, enabled: true }
  ]))
  setConfigValue(db, 'config.llmServices', JSON.stringify([
    { id: 'svc-hosted', name: 'Hosted Test', baseUrl: 'https://hosted.example.test', supportedModelIds: [modelId], createdAt: '1', updatedAt: '1' }
  ]))
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['svc-hosted']))
  setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ 'svc-hosted': 'enc:test-key' }))
}

describe('Desktop Hosted checkpoint restart', () => {
  let db: AppDatabase
  let runtime: ReturnType<typeof createAgentRuntime>
  let providerCalls: number
  let workDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    providerCalls = 0
    workDir = ''
    resetDefaultAgentRuntimeForTests()
    db = openDatabase(':memory:')
  })

  afterEach(async () => {
    db.close()
    if (workDir) await fs.rm(workDir, { recursive: true, force: true })
    resetDefaultAgentRuntimeForTests()
  })

  it('does not repeat a Desktop Hosted file write after checkpoint failure and database restart', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-hosted-write-checkpoint-restart-'))
    const dbPath = path.join(workDir, 'runtime.db')
    db.close()
    db = openDatabase(dbPath)
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    seedTrustedModel(db, modelId)
    const endpoint = 'https://hosted.example.test'
    const route = createDesktopAnthropicRouteProfile({ modelId, endpoint, credentialRef: 'llm-service:svc-hosted',
      contextWindow: MODEL_BASELINE[modelId]!.maximumContext, maxOutputTokens: MODEL_BASELINE[modelId]!.maxTokens,
      reasoning: MODEL_BASELINE[modelId]!.reasoning })
    runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: route.routeId, protocol: route.protocol, dialect: route.dialect,
      adapterVersion: route.adapterVersion, modelId: route.modelId, endpoint: route.endpoint }, {
      providerId: 'pi-ai-anthropic-messages', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'desktop-checkpoint-write', toolName: 'write_file',
            input: { path: 'written-once.txt', content: 'committed side effect' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'write completed' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    })
    const registerProvider = runtime.modelProviders.register.bind(runtime.modelProviders)
    runtime.modelProviders.register = (profile, provider) => profile.routeId === route.routeId ? route.routeId : registerProvider(profile, provider)
    setDefaultAgentRuntime(runtime)

    const session = createSession(db, { name: 'desktop-write-checkpoint-restart', model: modelId, maxTokens: 512 })
    const user = appendMessage(db, { id: 'desktop-write-checkpoint-user', sessionId: session.id, role: 'user', content: 'write once', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'desktop-write-checkpoint-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'desktop-write-checkpoint-turn', requestId: 'desktop-write-checkpoint-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id, contextBoundarySequence: user.sequence,
      state: 'prepared', startToken: 'desktop-write-checkpoint-token',
      executionConfig: { lane: 'desktop', model: modelId, baseUrl: endpoint, llmServiceId: 'svc-hosted', system: 'system', maxTokens: 512, enableThinking: false, locale: 'zh-CN' } })
    getDbConnection(db).exec(`CREATE TRIGGER fail_desktop_write_transcript_checkpoint BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.version > 0 BEGIN SELECT RAISE(ABORT, 'injected desktop write checkpoint failure'); END`)
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'test-key', getWorkDir: () => workDir, resolveWorkDirForSession: () => workDir,
      getUserDataPath: () => '/tmp', getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes: 100 }),
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir }), turnRuntime: { bindRequest: vi.fn(), consumeForRequest: vi.fn() } as never
    })
    const writeSpy = vi.spyOn(writeFileExecutor, 'execute')

    const firstResult = await execute(makeSender(), { requestId: 'desktop-write-checkpoint-request', turnId: 'desktop-write-checkpoint-turn',
      turnStartToken: 'desktop-write-checkpoint-token', sessionId: session.id })

    expect(firstResult).toMatchObject({ ok: false, outcome: 'commit-uncertain', error: expect.stringContaining('injected desktop write checkpoint failure') })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    await expect(fs.readFile(path.join(workDir, 'written-once.txt'), 'utf8')).resolves.toBe('committed side effect')

    db.close()
    db = openDatabase(dbPath)
    const retryResult = await execute(makeSender(), { requestId: 'desktop-write-checkpoint-request', turnId: 'desktop-write-checkpoint-turn',
      turnStartToken: 'desktop-write-checkpoint-token', sessionId: session.id })

    expect(retryResult).toMatchObject({ ok: false })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(providerCalls).toBe(2)
    const history = await new SqliteAgentHistory(getDbConnection(db)).read('desktop-write-checkpoint-turn')
    expect(history.events.filter((event) => event.kind === 'tool-call-started' && event.payload.toolCallId === 'desktop-checkpoint-write')).toHaveLength(1)
    expect(history.events.filter((event) => event.kind === 'tool-call-finished' && event.payload.toolCallId === 'desktop-checkpoint-write')).toHaveLength(1)
    writeSpy.mockRestore()
  })
})
