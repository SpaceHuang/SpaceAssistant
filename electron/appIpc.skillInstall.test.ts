import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'

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
  buildSystemPrompt: vi.fn(() => ''),   probeFromUrl: vi.fn(),   installFromUrl: vi.fn()
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

describe('skill install IPC handlers', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('passes probe candidates and truncation flags through untouched', async () => {
    const probeResult = {
      repo: { owner: 'obra', repo: 'superpowers', branch: 'main', subPath: '' },
      candidates: [
        { name: 'alpha', description: 'a', subPath: 'skills/alpha', totalBytes: 12, status: 'ok' as const },
        { name: 'broken', description: '', subPath: 'skills/broken', totalBytes: 0, status: 'invalid' as const, reason: 'SKILL_FRONT_MATTER_MISSING: x' }
      ],
      truncated: true,
      visitedTruncated: false
    }
    mockSkillManager.probeFromUrl.mockResolvedValue(probeResult)

    const handler = ipc.getHandler('skill:probe-github-url')!
    await expect(handler({}, { sourceUrl: 'https://github.com/obra/superpowers' })).resolves.toEqual({ ok: true, ...probeResult })
    expect(mockSkillManager.probeFromUrl).toHaveBeenCalledWith('https://github.com/obra/superpowers')
  })

  it('forwards subPaths and returns installed, skipped and overwritten', async () => {
    mockSkillManager.installFromUrl.mockResolvedValue({
      installed: [{ meta: { name: 'alpha' } }],
      skipped: [{ subPath: 'skills/beta', name: 'beta', reason: 'SKILL_NAME_CONFLICT: exists' }],
      overwritten: []
    })

    const handler = ipc.getHandler('skill:install-from-url')!
    const result = await handler(
      { sender: { send: vi.fn() } },
      { sourceUrl: 'https://github.com/obra/superpowers', subPaths: ['skills/alpha', 'skills/beta'] }
    )

    expect(mockSkillManager.installFromUrl).toHaveBeenCalledWith(
      'https://github.com/obra/superpowers',
      expect.objectContaining({ subPaths: ['skills/alpha', 'skills/beta'] })
    )
    expect(result).toEqual({
      ok: true,
      skills: [{ meta: { name: 'alpha' } }],
      skipped: [{ subPath: 'skills/beta', name: 'beta', reason: 'SKILL_NAME_CONFLICT: exists' }],
      overwritten: []
    })
  })

  it('returns a coded error when the batch install fails', async () => {
    mockSkillManager.installFromUrl.mockRejectedValue(new Error('SKILL_URL_INVALID: 候选子路径不合法：../x'))

    const handler = ipc.getHandler('skill:install-from-url')!
    const result = await handler({ sender: { send: vi.fn() } }, { sourceUrl: 'https://github.com/a/b', subPaths: ['../x'] })

    expect(result).toEqual({ ok: false, error: 'SKILL_URL_INVALID: 候选子路径不合法：../x' })
  })
})
