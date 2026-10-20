import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { createSession } from '../database/operations'
import { setConfigValue } from '../database'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { executeDeferredImTool } from './imDeferredToolExecutor'

describe('IM deferred tool executor', () => {
  afterEach(() => resetDefaultAgentRuntimeForTests())

  it('用持久调用身份经实时 SafetyGate 直接执行原 RegisteredTool，不请求模型', async () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.wiki', JSON.stringify({ ...DEFAULT_WIKI_CONFIG, rootPath: 'deferred-wiki-fixture' }))
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-v1.6', snapshot: {}, updatedAt: Date.now(), eventId: 'deferred-executor' })
    const session = createSession(db, { name: 'deferred-executor-session' })
    const storage = createSqliteSessionStorage(db)
    const providerStream = vi.fn(async function* () { yield { type: 'finish' as const, reason: 'stop' as const } })
    const runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: 'deferred-executor-model', protocol: 'anthropic-messages', dialect: 'test', adapterVersion: '1', modelId: 'model' }, {
      providerId: 'deferred-executor-provider', stream: providerStream
    })
    setDefaultAgentRuntime(runtime)
    const execute = vi.fn(async () => ({ success: true, data: 'done' }))
    let executionWikiConfig: Record<string, unknown> | undefined
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'memory.wiki_save_page', actionClass: 'write',
      parseInput: (raw) => raw as { title: string },
      plan: async (input, context) => {
        executionWikiConfig = context.executionContext?.wikiConfig as Record<string, unknown> | undefined
        return input
      }, execute }))

    await expect(executeDeferredImTool({
      db, sessionStorage: storage, sessionId: session.id, requestId: 'persisted-request', turnId: 'persisted-turn',
      invocationId: 'persisted-invocation', toolCallId: 'persisted-tool-call', toolName: 'memory_wiki_save_page',
      input: { title: 'approved page' }, confirmationReceipt: 'approval:reply-1',
      lane: 'feishu', remoteContext: { source: 'feishu', messageId: 'original-platform-message', confirmPolicy: 'always',
        authOwner: 'owner-1', chatId: 'chat-1', originSessionId: session.id },
      model: 'model', providerRouteId: 'deferred-executor-model', toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'unused-key', getBaseUrl: () => 'https://unused.invalid', workDirManager: {
        listProfiles: () => [], getActiveProfileId: () => 'profile', getActiveWorkDir: () => '/tmp', checkDirectoryWritable: () => ({ ok: true })
      } as never, registry
    })).resolves.toMatchObject({ output: { success: true, data: 'done' }, isError: false })

    expect(execute).toHaveBeenCalledOnce()
    expect(executionWikiConfig).toMatchObject({ rootPath: 'deferred-wiki-fixture' })
    expect(providerStream).not.toHaveBeenCalled()
    db.close()
  })
})
