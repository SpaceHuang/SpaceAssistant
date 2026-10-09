import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { executeDeferredImTool } from './imDeferredToolExecutor'

describe('IM deferred tool executor', () => {
  afterEach(() => resetDefaultAgentRuntimeForTests())

  it('用持久调用身份经实时 SafetyGate 直接执行原 RegisteredTool，不请求模型', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'deferred-executor-session' })
    const storage = createSqliteSessionStorage(db)
    const providerStream = vi.fn(async function* () { yield { type: 'finish' as const, reason: 'stop' as const } })
    const runtime = createDesktopAgentRuntime()
    runtime.modelProviders.register({ routeId: 'deferred-executor-model', protocol: 'anthropic-messages', dialect: 'test', adapterVersion: '1', modelId: 'model' }, {
      providerId: 'deferred-executor-provider', stream: providerStream
    })
    setDefaultAgentRuntime(runtime)
    const execute = vi.fn(async () => ({ success: true, data: 'done' }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, plan: async (input) => input, execute }))

    await expect(executeDeferredImTool({
      db, sessionStorage: storage, sessionId: session.id, requestId: 'persisted-request', turnId: 'persisted-turn',
      invocationId: 'persisted-invocation', toolCallId: 'persisted-tool-call', toolName: 'write_file',
      input: { path: 'approved.txt', content: 'original' }, confirmationReceipt: 'approval:reply-1',
      lane: 'feishu', remoteContext: { source: 'feishu', messageId: 'original-platform-message', confirmPolicy: 'always',
        authOwner: 'owner-1', chatId: 'chat-1', originSessionId: session.id },
      model: 'model', providerRouteId: 'deferred-executor-model', toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'unused-key', getBaseUrl: () => 'https://unused.invalid', workDirManager: {
        listProfiles: () => [], getActiveProfileId: () => 'profile', getActiveWorkDir: () => '/tmp', checkDirectoryWritable: () => ({ ok: true })
      } as never, registry
    })).resolves.toMatchObject({ output: { success: true, data: 'done' }, isError: false })

    expect(execute).toHaveBeenCalledOnce()
    expect(providerStream).not.toHaveBeenCalled()
    db.close()
  })
})
