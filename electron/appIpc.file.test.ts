import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { waitForToolConfirm } from './toolConfirmRegistry'
import * as database from './database'
import { getMainWindow } from './windowRef'
import { BrowserWindow } from 'electron'

const WORK_DIR = path.resolve('/fake/workdir')

const mockFs = vi.hoisted(() => ({
  writeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  mkdtemp: vi.fn<() => Promise<string>>().mockResolvedValue('/tmp/spaceassistant-markdown-pdf-test'),
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
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: vi.fn()
}))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  listPersistedTurns: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getTurnByRequestId: vi.fn(),
  getPersistedTurn: vi.fn(),
  listTurnErrorsByAssistantMessageIds: vi.fn((): Array<{ assistantMessageId: string; message: string }> => []),
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
  listSearchHistory: vi.fn(() => []),
  getDbConnection: vi.fn(() => ({}))
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
    mockFs.stat.mockReset()
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats)
    vi.mocked(BrowserWindow).mockReset()
    vi.mocked(BrowserWindow).mockImplementation(class {
      loadFile = vi.fn().mockResolvedValue(undefined)
      webContents = { printToPDF: vi.fn().mockResolvedValue(Buffer.from('pdf')) }
      destroy = vi.fn()
    } as never)
    mockSkillManager.route.mockResolvedValue({ skills: [] })
    mockSkillManager.buildSystemPrompt.mockReturnValue('')
    vi.mocked(getMainWindow).mockReturnValue(undefined)

    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('统一 Markdown 导出接口拒绝非法参数且不弹保存框', async () => {
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'html', markdown: '# x', sourcePath: 'x.md' })).resolves.toEqual({ ok: false, error: '导出参数无效' })
    const { dialog } = await import('electron')
    expect(vi.mocked(dialog.showSaveDialog)).not.toHaveBeenCalled()
  })

  it('统一 Markdown 导出接口拒绝非 Markdown 来源', async () => {
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# x', sourcePath: 'x.txt' })).resolves.toEqual({ ok: false, error: '仅支持导出 Markdown 文件' })
  })

  it('保存框取消时不生成文件', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' } as never)
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# x', sourcePath: '方案.v2.md' })).resolves.toEqual({ ok: false, canceled: true })
    expect(vi.mocked(dialog.showSaveDialog)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ defaultPath: expect.stringMatching(/方案\.v2\.pdf$/), filters: [{ name: 'PDF', extensions: ['pdf'] }] }))
  })

  it('DOCX 保存框使用正确过滤器并通过统一写入边界', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.docx' } as never)
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'docx', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: true, path: '/tmp/方案.docx' })
    expect(vi.mocked(dialog.showSaveDialog)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: [{ name: 'Word 文档', extensions: ['docx'] }] }))
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(mockFs.rename).toHaveBeenCalled()
  })

  it('补正扩展名后使用最终 PDF 路径完成导出', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.txt' } as never)
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0 } as never)
    let statCalls = 0
    mockFs.stat.mockImplementation(async () => ({ dev: 1, ino: statCalls++ === 0 ? 1 : 2, isDirectory: () => false } as unknown as import('fs').Stats))
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: true, path: '/tmp/方案.pdf' })
  })

  it('PDF 使用离屏打印、A4 参数和原子写入', async () => {
    const { dialog, BrowserWindow } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.txt' } as never)
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1 } as never)
    mockFs.stat.mockResolvedValueOnce({ dev: 1, ino: 1, isDirectory: () => false } as unknown as import('fs').Stats)
    mockFs.stat.mockRejectedValueOnce(new Error('ENOENT'))
    const printToPDF = vi.fn().mockResolvedValue(Buffer.from('pdf'))
    const destroy = vi.fn()
    vi.mocked(BrowserWindow).mockImplementation(class {
      loadURL = vi.fn().mockResolvedValue(undefined)
      loadFile = vi.fn().mockResolvedValue(undefined)
      webContents = { printToPDF }
      destroy = destroy
    } as never)
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: true, path: '/tmp/方案.pdf' })
    expect(printToPDF).toHaveBeenCalledWith({ printBackground: true, pageSize: 'A4' })
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
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
      listActive: vi.fn(() => []),
      subscribe: vi.fn(() => () => undefined)
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

  it('配置阶段失败时把 source-failed 事实（含真实原因）交给 projection，渲染层才能标失败并显示原因', async () => {
    const started = {
      turnId: 'failed-configuring-turn', requestId: 'failed-configuring-request', sessionId: 'session-1',
      userMessage: { id: 'user-1', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'failed-token', intentFingerprint: '{}', executionConfig: {}
    }
    const runtimeConsume = vi.fn(() => ({
      ...started,
      version: 3,
      assistantMessage: { ...started.assistantMessage, status: 'failed' as const }
    }))
    ctx.turnRuntime = {
      coordinator: {
        prepare: vi.fn().mockReturnValue(started),
        consume: vi.fn(),
        restoreTurn: vi.fn(),
        recover: vi.fn(),
        getTerminal: vi.fn()
      },
      consume: runtimeConsume,
      cancel: vi.fn(),
      listActive: vi.fn(() => []),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    vi.mocked(database.getTurnByRequestId).mockReturnValue(undefined)
    vi.mocked(database.getPersistedTurn).mockReturnValue({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
    })
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)
    mockSkillManager.route.mockRejectedValueOnce(new Error('会话模型「claude-sonnet-4-20250514」当前不可用'))

    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:prepare-turn')!

    // prepare 只交还已占有的 turn，配置在后台继续；失败必须经由 projection 出口通知渲染层。
    await expect(handler({}, {
      mode: 'create-user', requestId: 'failed-configuring-request', sessionId: 'session-1', input: { text: 'hello' }, config: {}
    })).resolves.toMatchObject({ turnId: 'failed-configuring-turn' })

    // 直接调用 coordinator.consume 不会经过 runtime 的 projection 出口，渲染层会一直停在「生成中」。
    await vi.waitFor(() => expect(runtimeConsume).toHaveBeenCalled())
    expect(runtimeConsume).toHaveBeenCalledWith('failed-configuring-turn', {
      type: 'source-failed',
      message: '会话模型「claude-sonnet-4-20250514」当前不可用'
    })
    expect(database.failConfiguringTurn).toHaveBeenCalledWith(
      expect.anything(),
      'failed-configuring-turn',
      3,
      expect.objectContaining({ code: 'configuration-failed' })
    )
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
    ctx.turnRuntime = { coordinator, cancel: runtimeCancel, listActive: vi.fn(() => []), subscribe: vi.fn(() => () => undefined) } as unknown as AppIpcContext['turnRuntime']
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
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const result = await ipc.getHandler('chat:cancel-turn')!({}, 'turn-desktop-1')

    expect(result).toBe(true)
    expect(runtimeCancel).toHaveBeenCalledWith('turn-desktop-1')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('desktop confirm IPC resolves the pending Core confirmation without emitting a fact directly', async () => {
    const pending = waitForToolConfirm('request-confirm-1', 'tool-1', [], { toolName: 'run_shell', lane: 'desktop', sessionId: 'session-1' })
    const handler = ipc.getHandler('tool:confirm-response')!

    await handler({}, { requestId: 'request-confirm-1', toolUseId: 'tool-1', sessionId: 'session-1', approved: false })
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

  it('renderer 无 known 重载时仍返回 checkpoint 尚未提交的 terminal', async () => {
    const terminal = {
      turnId: 'terminal-pending-1', requestId: 'request-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', version: 4, outcome: 'completed' as const,
      message: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: 'done', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    }
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus: vi.fn().mockReturnValue('pending')
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: Array<{ turnId: string; lifecycle: string }> }
    expect(changed.changed).toHaveLength(1)
    expect(changed.changed[0]).toMatchObject({ turnId: terminal.turnId, lifecycle: 'completed' })
  })

  it('已提交的历史 terminal 不会在 renderer 无 known 重载时重新注入', async () => {
    const terminal = {
      turnId: 'terminal-committed-1', requestId: 'request-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', version: 4, outcome: 'completed' as const,
      message: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: 'done', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    }
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus: vi.fn().mockReturnValue('committed')
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: unknown[] }
    expect(changed.changed).toEqual([])
  })

  it('低版本 checkpoint 已提交时仍恢复更高版本的 terminal', async () => {
    const terminal = {
      turnId: 'terminal-versioned-1', requestId: 'request-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', version: 4, outcome: 'completed' as const,
      message: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: 'done', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    }
    const checkpointStatus = vi.fn((_turnId: string, targetVersion?: number) => targetVersion !== undefined && targetVersion > 3 ? 'pending' as const : 'committed' as const)
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: Array<{ turnId: string }> }
    expect(changed.changed).toHaveLength(1)
    expect(checkpointStatus).toHaveBeenCalledWith(terminal.turnId, terminal.version)
  })
  describe('chat:get-turn-errors', () => {
    it('按 assistantMessageId 返回持久化失败原因', async () => {
      vi.mocked(database.listTurnErrorsByAssistantMessageIds).mockReturnValue([
        { assistantMessageId: 'a1', message: '会话模型「x」当前不可用（未知模型）' }
      ])
      const handler = ipc.getHandler('chat:get-turn-errors')!

      expect(await handler({}, { assistantMessageIds: ['a1', 'a2'] })).toEqual([
        { assistantMessageId: 'a1', message: '会话模型「x」当前不可用（未知模型）' }
      ])
      expect(database.listTurnErrorsByAssistantMessageIds).toHaveBeenCalledWith(ctx.db, ['a1', 'a2'])
    })

    it('内存终态优先于持久化记录', async () => {
      vi.mocked(database.listTurnErrorsByAssistantMessageIds).mockReturnValue([
        { assistantMessageId: 'a1', message: '旧的持久化原因' }
      ])
      const getTerminalByAssistantMessageId = vi.fn((messageId: string) =>
        messageId === 'a1' ? { error: { code: 'source-failed', message: '内存里的最新原因' } } : undefined
      )
      ctx.turnRuntime = {
        coordinator: { getTerminalByAssistantMessageId, recover: vi.fn(), listActive: vi.fn(() => []) },
        listActive: vi.fn(() => []),
        cancel: vi.fn(),
        subscribe: vi.fn(() => () => undefined)
      } as unknown as AppIpcContext['turnRuntime']
      ipc = mockIpcMain()
      registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
      const handler = ipc.getHandler('chat:get-turn-errors')!

      expect(await handler({}, { assistantMessageIds: ['a1'] })).toEqual([
        { assistantMessageId: 'a1', message: '内存里的最新原因' }
      ])
      expect(getTerminalByAssistantMessageId).toHaveBeenCalledWith('a1')
    })

    it('没有可查 id 时不查库', async () => {
      const handler = ipc.getHandler('chat:get-turn-errors')!

      expect(await handler({}, { assistantMessageIds: [] })).toEqual([])
      expect(await handler({}, undefined)).toEqual([])
      expect(database.listTurnErrorsByAssistantMessageIds).not.toHaveBeenCalled()
    })
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
