import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { waitForToolConfirm } from './toolConfirmRegistry'
import type { CacheKey } from '../src/shared/confirmation/types'

const WORK_DIR = path.resolve('/fake/workdir')

const mockRecordUserAnswerToCache = vi.fn()

vi.mock('fs/promises', () => ({
  default: {},
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => []),
  setSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(),
  deleteSessionUsage: vi.fn()
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn()
}))

vi.mock('./confirmation/decisionCacheWriter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/decisionCacheWriter')>()
  return {
    ...actual,
    recordUserAnswerToCache: (...args: unknown[]) => mockRecordUserAnswerToCache(...args)
  }
})

vi.mock('./shell/shellCommandTrust', () => ({
  addTrustedCommand: vi.fn(() => ({
    id: 't1',
    schemaVersion: 2,
    executable: 'git',
    fixedArgvPrefix: ['status'],
    source: 'desktop',
    createdAt: 1,
    lastUsedAt: 1,
    expired: false
  }))
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
    db: { save: vi.fn() } as unknown as AppIpcContext['db'],
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

const sessionTierKey: CacheKey = { kind: 'domain', domain: 'example.com', level: 'domain-any-action', sessionId: 's1' }
const persistentTierKey: CacheKey = { kind: 'shell-command', verb: 'git status', level: 'exact' }

describe('tool:confirm-response memoryTier 校验（B1/B2）', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
  })

  const invoke = (payload: Record<string, unknown>) =>
    ipc.getHandler('tool:confirm-response')?.(null, payload) as Promise<void>

  it('接受 pending decision 档位内的会话级键，并按 sessionId 派生 session scope', async () => {
    const pending = waitForToolConfirm('req-a', 'tool-a', [
      { key: sessionTierKey, label: '本会话' },
      { key: persistentTierKey, label: '永久' }
    ])
    await invoke({
      requestId: 'req-a',
      toolUseId: 'tool-a',
      approved: true,
      sessionId: 's1',
      memoryTier: sessionTierKey
    })
    expect(mockRecordUserAnswerToCache).toHaveBeenCalledTimes(1)
    const args = mockRecordUserAnswerToCache.mock.calls[0]![0] as { key: CacheKey; scope: string }
    expect(args.key).toEqual(sessionTierKey)
    expect(args.scope).toBe('session')
    await pending
  })

  it('接受档位内的持久键并派生 persistent scope', async () => {
    const pending = waitForToolConfirm('req-b', 'tool-b', [{ key: persistentTierKey, label: '永久' }])
    await invoke({
      requestId: 'req-b',
      toolUseId: 'tool-b',
      approved: true,
      sessionId: 's1',
      memoryTier: persistentTierKey
    })
    expect(mockRecordUserAnswerToCache).toHaveBeenCalledTimes(1)
    const args = mockRecordUserAnswerToCache.mock.calls[0]![0] as { scope: string }
    expect(args.scope).toBe('persistent')
    await pending
  })

  it('拒绝不在 pending decision 档位内的任意键（IPC 权限提升面）', async () => {
    const pending = waitForToolConfirm('req-c', 'tool-c', [{ key: sessionTierKey, label: '本会话' }])
    await invoke({
      requestId: 'req-c',
      toolUseId: 'tool-c',
      approved: true,
      sessionId: 's1',
      // 渲染端伪造：把会话档改成无 sessionId 的持久档
      memoryTier: { kind: 'domain', domain: 'example.com', level: 'domain-any-action' }
    })
    expect(mockRecordUserAnswerToCache).not.toHaveBeenCalled()
    await pending
  })

  it('无 pending 确认请求时拒绝写缓存', async () => {
    await invoke({
      requestId: 'req-nonexistent',
      toolUseId: 'tool-x',
      approved: true,
      memoryTier: persistentTierKey
    })
    expect(mockRecordUserAnswerToCache).not.toHaveBeenCalled()
  })

  it('approved=false 时不写缓存（既有行为保持）', async () => {
    const pending = waitForToolConfirm('req-d', 'tool-d', [{ key: persistentTierKey, label: '永久' }])
    await invoke({
      requestId: 'req-d',
      toolUseId: 'tool-d',
      approved: false,
      memoryTier: persistentTierKey
    })
    expect(mockRecordUserAnswerToCache).not.toHaveBeenCalled()
    await pending
  })

  it('信任此命令双写 decision_cache（B6：信任在确认记忆页可见可撤销）', async () => {
    const pending = waitForToolConfirm('req-e', 'tool-e')
    await invoke({
      requestId: 'req-e',
      toolUseId: 'tool-e',
      approved: true,
      sessionId: 's1',
      trustCommand: 'git status'
    })
    expect(mockRecordUserAnswerToCache).toHaveBeenCalledTimes(1)
    const args = mockRecordUserAnswerToCache.mock.calls[0]![0] as { key: CacheKey; scope: string }
    expect(args.key).toEqual({ kind: 'shell-command', verb: 'git status', level: 'exact' })
    expect(args.scope).toBe('persistent')
    await pending
  })
})
