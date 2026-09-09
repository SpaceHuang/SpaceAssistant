import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { waitForToolConfirm } from './toolConfirmRegistry'
import * as database from './database'

const WORK_DIR = path.resolve('/fake/workdir')

const mockFs = vi.hoisted(() => ({
  writeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  mkdir: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  rm: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  rename: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  stat: vi.fn<() => Promise<import('fs').Stats>>().mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
  unlink: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('fs/promises', () => ({
  default: mockFs,
  ...mockFs
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  listPersistedTurns: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getTurnByRequestId: vi.fn(),
  getPersistedTurn: vi.fn(),
  setPersistedTurnExecutionConfig: vi.fn(() => true),
  failConfiguringTurn: vi.fn(() => true),
  getMessage: vi.fn(),
  getRecentTurnRoutingMessages: vi.fn(() => []),
  hasVisionInTurnRoutingContext: vi.fn(() => false),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => [])
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

const mockSkillManager = vi.hoisted(() => ({
  route: vi.fn().mockResolvedValue({ skills: [] }),
  buildSystemPrompt: vi.fn(() => '')
}))

vi.mock('./skills/skillManager', () => ({
  createSkillManager: vi.fn(() => mockSkillManager)
}))

vi.mock('./turnExecutionConfig', () => ({
  resolveTrustedTurnExecutionConfig: vi.fn().mockResolvedValue({
    lane: 'desktop', model: 'deepseek-chat', llmServiceId: 'service-1', baseUrl: 'https://example.test', maxTokens: 4096, enableThinking: false
  })
}))

vi.mock('./llmServiceResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('./llmServiceResolver')>(),
  resolveLlmCredentialsForModel: vi.fn().mockResolvedValue({ serviceId: 'service-1', baseUrl: 'https://example.test', getApiKey: vi.fn() })
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn()
}))

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeWorkDirManager(): AppIpcContext['workDirManager'] {
  return {
    listProfiles: () => [],
    addProfile: vi.fn().mockReturnValue({ success: true }),
    updateProfile: vi.fn().mockReturnValue({ success: true }),
    removeProfile: vi.fn().mockReturnValue({ success: true }),
    switchProfile: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    getActiveProfile: () => undefined,
    getActiveWorkDir: () => WORK_DIR,
    getActiveProfileId: () => 'default',
    validateProfilesForSave: () => ({ valid: true }),
    validateProfileInput: () => ({ valid: true }),
    checkDirectoryWritable: () => ({ ok: true }),
    migrateFromLegacy: vi.fn(),
    persistProfiles: vi.fn()
  }
}

function makeCtx(): AppIpcContext {
  return {
    db: {} as AppIpcContext['db'],
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      deleteBackup: vi.fn()
    } as unknown as AppIpcContext['backup'],
    workDirManager: makeWorkDirManager(),
    getWorkDir: () => WORK_DIR,
    setWorkDir: vi.fn(),
    getUserDataPath: () => '/fake/userdata',
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
    getBrowserDetectContext: () => ({
      isPackaged: false,
      appPath: '/fake/app',
      devRoot: '/fake/project'
    })
  }
}

describe('file IPC handlers', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.writeFile.mockResolvedValue(undefined)
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.rm.mockResolvedValue(undefined)
    mockFs.rename.mockResolvedValue(undefined)
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats)
    mockSkillManager.route.mockResolvedValue({ skills: [] })
    mockSkillManager.buildSystemPrompt.mockReturnValue('')

    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('accepts a prepared turn and starts execution asynchronously', async () => {
    const executeTurn = vi.fn().mockResolvedValue(undefined)
    ctx.executeTurn = executeTurn
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:execute-turn')!
    const sender = { send: vi.fn() }
    const payload = {
      requestId: 'request-1',
      turnId: 'turn-1',
      turnStartToken: 'token-1',
      sessionId: 'session-1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }]
    }

    await expect(handler({ sender }, payload)).resolves.toEqual({ ok: true, accepted: true, turnId: 'turn-1' })
    expect(executeTurn).toHaveBeenCalledWith(sender, {
      requestId: 'request-1', turnId: 'turn-1', turnStartToken: 'token-1', sessionId: 'session-1'
    })
  })

  it('相同 requestId 重放优先返回冻结 turn，不读取漂移后的当前配置', async () => {
    const frozenConfig = { lane: 'desktop' as const, model: 'deepseek-chat', maxTokens: 4096, enableThinking: false, locale: 'zh-CN' }
    vi.mocked(database.getTurnByRequestId).mockReturnValue({
      turnId: 'frozen-turn', requestId: 'stable-request', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', userMessageId: 'user-1', state: 'prepared', version: 0,
      startToken: 'frozen-token',
      intentFingerprint: JSON.stringify({ mode: 'create-user', input: JSON.stringify({ v: 1, text: 'hello', attachments: [] }), excludeMessageIds: [], config: frozenConfig }),
      excludeMessageIds: [], executionConfig: frozenConfig
    })
    vi.mocked(database.getMessage).mockImplementation((_db, messageId) => messageId === 'user-1'
      ? { id: 'user-1', sessionId: 'session-1', role: 'user', content: 'hello', timestamp: 1, status: 'sent', schemaVersion: 1 }
      : { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 2, status: 'streaming', schemaVersion: 1 })

    const handler = ipc.getHandler('chat:prepare-turn')!
    await expect(handler({}, {
      mode: 'create-user', requestId: 'stable-request', sessionId: 'session-1', input: { text: 'hello' }, config: {}
    })).resolves.toMatchObject({ turnId: 'frozen-turn', startToken: 'frozen-token' })
    await expect(handler({}, {
      mode: 'create-user', requestId: 'stable-request', sessionId: 'session-1', input: { text: 'changed' }, config: {}
    })).rejects.toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')

    expect(database.getSession).not.toHaveBeenCalled()
    expect(database.getMessages).not.toHaveBeenCalled()
    expect(database.appendMessage).not.toHaveBeenCalled()
  })

  it('相同 requestId 在配置尚未冻结时等待同一单飞路由，且只路由一次', async () => {
    let releaseRoute!: (value: { skills: [] }) => void
    mockSkillManager.route.mockImplementationOnce(() => new Promise((resolve) => { releaseRoute = resolve }))
    const started = {
      turnId: 'configuring-turn', requestId: 'configuring-request', sessionId: 'session-1',
      userMessage: { id: 'user-1', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'configuring-token', intentFingerprint: '{}', executionConfig: {}
    }
    const coordinator = {
      prepare: vi.fn().mockReturnValue(started),
      consume: vi.fn(),
      restoreTurn: vi.fn(),
      recover: vi.fn(),
      getTerminal: vi.fn()
    }
    ctx.turnRuntime = {
      coordinator,
      cancel: vi.fn(),
      listActive: vi.fn(() => [])
    } as unknown as AppIpcContext['turnRuntime']
    const executeTurn = vi.fn().mockResolvedValue(undefined)
    ctx.executeTurn = executeTurn
    vi.mocked(database.getTurnByRequestId)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
        assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
        contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
      })
    vi.mocked(database.getPersistedTurn).mockReturnValue({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
    })
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)

    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:prepare-turn')!
    const intent = { mode: 'create-user' as const, requestId: 'configuring-request', sessionId: 'session-1', input: { text: 'hello' }, config: {} }

    const first = handler({}, intent)
    await vi.waitFor(() => expect(mockSkillManager.route).toHaveBeenCalledTimes(1))
    await expect(first).resolves.toMatchObject({ turnId: started.turnId, startToken: started.startToken })
    const execute = ipc.getHandler('chat:execute-turn')!
    await expect(execute({ sender: {} }, {
      requestId: started.requestId, turnId: started.turnId, turnStartToken: started.startToken, sessionId: started.sessionId
    })).resolves.toMatchObject({ accepted: true, turnId: started.turnId })
    expect(executeTurn).not.toHaveBeenCalled()
    const retry = handler({}, intent)
    let retrySettled = false
    void Promise.resolve(retry).then(() => { retrySettled = true })
    await Promise.resolve()
    expect(retrySettled).toBe(false)
    expect(mockSkillManager.route).toHaveBeenCalledTimes(1)

    releaseRoute({ skills: [] })
    await expect(retry).resolves.toMatchObject({ turnId: started.turnId, startToken: started.startToken })
    await vi.waitFor(() => expect(executeTurn).toHaveBeenCalledTimes(1))
    expect(database.setPersistedTurnExecutionConfig).toHaveBeenCalledTimes(1)
  })

  it('取消 configuring turn 会中止技能路由，且 execute 不启动 provider', async () => {
    let routeSignal: AbortSignal | undefined
    mockSkillManager.route.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      routeSignal = signal
      signal?.addEventListener('abort', () => reject(new Error('routing aborted')), { once: true })
    }))
    const started = {
      turnId: 'cancel-configuring-turn', requestId: 'cancel-configuring-request', sessionId: 'session-1',
      userMessage: { id: 'cancel-user', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'cancel-assistant', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'cancel-token', intentFingerprint: '{}', executionConfig: {}
    }
    const coordinator = {
      prepare: vi.fn().mockReturnValue(started),
      consume: vi.fn(),
      restoreTurn: vi.fn(),
      recover: vi.fn(),
      getTerminal: vi.fn()
    }
    const runtimeCancel = vi.fn(() => true)
    ctx.turnRuntime = { coordinator, cancel: runtimeCancel, listActive: vi.fn(() => []) } as unknown as AppIpcContext['turnRuntime']
    const executeTurn = vi.fn().mockResolvedValue(undefined)
    ctx.executeTurn = executeTurn
    let cancelled = false
    vi.mocked(database.getTurnByRequestId).mockReturnValueOnce(undefined)
    vi.mocked(database.getPersistedTurn).mockImplementation(() => ({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: cancelled ? 'terminal' : 'configuring', version: 0, startToken: started.startToken
    }))
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)

    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const prepared = await ipc.getHandler('chat:prepare-turn')!({}, {
      mode: 'create-user', requestId: started.requestId, sessionId: started.sessionId, input: { text: 'hello' }, config: {}
    }) as { turnId: string }
    await vi.waitFor(() => expect(routeSignal).toBeDefined())
    cancelled = true
    expect(ipc.getHandler('chat:cancel-turn')!({}, started.turnId)).toBe(true)
    expect(runtimeCancel).toHaveBeenCalledWith(started.turnId)
    expect(routeSignal?.aborted).toBe(true)

    await vi.waitFor(() => expect(database.failConfiguringTurn).not.toHaveBeenCalled())
    await expect(ipc.getHandler('chat:execute-turn')!({ sender: {} }, {
      requestId: started.requestId, turnId: prepared.turnId, turnStartToken: started.startToken, sessionId: started.sessionId
    })).resolves.toMatchObject({ accepted: false, turnId: started.turnId })
    expect(executeTurn).not.toHaveBeenCalled()
  })

  it('desktop cancel IPC delegates control to the Core coordinator', async () => {
    const cancel = vi.fn().mockReturnValue(true)
    const recover = vi.fn()
    const runtimeCancel = vi.fn().mockReturnValue(true)
    ctx.turnRuntime = {
      coordinator: { cancel, recover },
      cancel: runtimeCancel,
      listActive: vi.fn().mockReturnValue([])
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const result = await ipc.getHandler('chat:cancel-turn')!({}, 'turn-desktop-1')

    expect(result).toBe(true)
    expect(runtimeCancel).toHaveBeenCalledWith('turn-desktop-1')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('desktop confirm IPC resolves the pending Core confirmation without emitting a fact directly', async () => {
    const pending = waitForToolConfirm('request-confirm-1', 'tool-1', [], { toolName: 'run_shell', lane: 'desktop' })
    const handler = ipc.getHandler('tool:confirm-response')!

    await handler({}, { requestId: 'request-confirm-1', toolUseId: 'tool-1', approved: false })
    await expect(pending).resolves.toBe('rejected')
  })

  it('records a local IPC handler dispatch baseline for the final pipeline report', async () => {
    const handler = ipc.getHandler('chat:list-active-turns')!
    const sampleCount = 1_000
    const startedAt = performance.now()
    for (let i = 0; i < sampleCount; i++) await handler({}, { sessionId: 's1' })
    const elapsedMs = performance.now() - startedAt
    console.log('[chat-ipc-dispatch-perf]', JSON.stringify({ sampleCount, elapsedMs, p50ApproxMs: elapsedMs / sampleCount }))
    expect(elapsedMs).toBeGreaterThanOrEqual(0)
  })

  describe('file:create-file', () => {
    it('creates an empty file', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await handler({}, 'newfile.txt')
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join(WORK_DIR, 'newfile.txt'), '')
    })

    it('creates intermediate directories', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await handler({}, 'sub/dir/file.txt')
      expect(mockFs.mkdir).toHaveBeenCalledWith(path.join(WORK_DIR, 'sub', 'dir'), { recursive: true })
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join(WORK_DIR, 'sub', 'dir', 'file.txt'), '')
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await expect(handler({}, '../escape.txt')).rejects.toThrow()
    })
  })

  describe('file:create-directory', () => {
    it('creates a directory recursively', async () => {
      const handler = ipc.getHandler('file:create-directory')!
      await handler({}, 'a/b/c')
      expect(mockFs.mkdir).toHaveBeenCalledWith(path.join(WORK_DIR, 'a', 'b', 'c'), { recursive: true })
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:create-directory')!
      await expect(handler({}, '../evil')).rejects.toThrow()
    })
  })

  describe('file:delete', () => {
    it('deletes a file', async () => {
      const handler = ipc.getHandler('file:delete')!
      await handler({}, 'old.txt')
      expect(mockFs.rm).toHaveBeenCalledWith(path.join(WORK_DIR, 'old.txt'), { recursive: true, force: true })
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:delete')!
      await expect(handler({}, '../../etc/passwd')).rejects.toThrow()
    })
  })

  describe('file:rename', () => {
    it('renames a file', async () => {
      const handler = ipc.getHandler('file:rename')!
      await handler({}, 'old.txt', 'new.txt')
      expect(mockFs.rename).toHaveBeenCalledWith(path.join(WORK_DIR, 'old.txt'), path.join(WORK_DIR, 'new.txt'))
    })

    it('rejects newName with path separator /', async () => {
      const handler = ipc.getHandler('file:rename')!
      await expect(handler({}, 'file.txt', 'sub/evil.txt')).rejects.toThrow()
    })

    it('rejects newName with path separator \\', async () => {
      const handler = ipc.getHandler('file:rename')!
      await expect(handler({}, 'file.txt', 'sub\\evil.txt')).rejects.toThrow()
    })

    it('rejects path traversal in relPath', async () => {
      const handler = ipc.getHandler('file:rename')!
      await expect(handler({}, '../escape.txt', 'ok.txt')).rejects.toThrow()
    })
  })

  describe('file:move', () => {
    it('moves a file to target directory', async () => {
      const handler = ipc.getHandler('file:move')!
      await handler({}, 'src/file.txt', 'dest')
      expect(mockFs.rename).toHaveBeenCalledWith(path.join(WORK_DIR, 'src', 'file.txt'), path.join(WORK_DIR, 'dest', 'file.txt'))
    })

    it('rejects if destination is not a directory', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => false } as unknown as import('fs').Stats)
      const handler = ipc.getHandler('file:move')!
      await expect(handler({}, 'file.txt', 'notadir')).rejects.toThrow()
    })

    it('rejects path traversal in source', async () => {
      const handler = ipc.getHandler('file:move')!
      await expect(handler({}, '../escape', 'dest')).rejects.toThrow()
    })

    it('rejects path traversal in destination', async () => {
      const handler = ipc.getHandler('file:move')!
      await expect(handler({}, 'src', '../escape')).rejects.toThrow()
    })
  })

  describe('file:to-viewer-url', () => {
    it('returns file url for valid relative path', async () => {
      mockFs.stat.mockResolvedValueOnce({ isFile: () => true } as unknown as import('fs').Stats)
      const handler = ipc.getHandler('file:to-viewer-url')!
      const result = await handler({}, 'pages/index.html')
      expect(result).toEqual({
        ok: true,
        url: expect.stringMatching(/^file:\/\//)
      })
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:to-viewer-url')!
      const result = await handler({}, '../escape.html')
      expect(result.ok).toBe(false)
    })

    it('rejects non-file paths', async () => {
      mockFs.stat.mockResolvedValueOnce({ isFile: () => false } as unknown as import('fs').Stats)
      const handler = ipc.getHandler('file:to-viewer-url')!
      const result = await handler({}, 'folder')
      expect(result).toEqual({ ok: false, error: 'not a file' })
    })
  })
})
