import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { appendSearchHistory } from './database'
import type { Message, Session } from '../src/shared/domainTypes'

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
  listSearchHistory: vi.fn(() => [])
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

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeCtx(messages: Message[] = [], sessions: Session[] = []): AppIpcContext {
  return {
    db: {
      data: { messages, sessions, searchHistory: [], config: {}, secrets: {} }
    } as AppIpcContext['db'],
    backup: { backupSession: vi.fn(), deleteBackup: vi.fn() } as unknown as AppIpcContext['backup'],
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

describe('search:execute IPC handler', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.readdir.mockResolvedValue([])
    mockFs.readFile.mockResolvedValue('')
    ipc = mockIpcMain()
  })

  it('returns empty array for blank query', async () => {
    const ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('search:execute')!
    const results = await handler({}, '   ')
    expect(results).toEqual([])
    expect(appendSearchHistory).not.toHaveBeenCalled()
  })

  it('returns session results with sessionId and messageId', async () => {
    const sessions: Session[] = [
      {
        id: 's1',
        name: '性能讨论',
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 1
      }
    ]
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: '如何优化 React 渲染性能',
        timestamp: 1,
        status: 'sent',
        schemaVersion: 1
      }
    ]
    const ctx = makeCtx(messages, sessions)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('search:execute')!
    const results = await handler({}, 'React')
    expect(appendSearchHistory).toHaveBeenCalledWith(ctx.db, 'React')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'msg:m1',
      type: 'session',
      title: '性能讨论',
      sessionId: 's1',
      messageId: 'm1',
      preview: '如何优化 React 渲染性能'
    })
  })

  it('returns file results with path', async () => {
    const ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    mockFs.readdir.mockResolvedValue([
      { name: 'perf.ts', isDirectory: () => false, isFile: () => true }
    ])
    mockFs.readFile.mockResolvedValue('export function memoize<T>(fn: T): T { return fn }')

    const handler = ipc.getHandler('search:execute')!
    const results = await handler({}, 'memoize')
    const fileHit = results.find((r: { type: string }) => r.type === 'file')
    expect(fileHit).toMatchObject({
      type: 'file',
      title: expect.stringContaining('perf.ts'),
      path: expect.stringContaining('perf.ts')
    })
  })
})
