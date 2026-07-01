import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'

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

    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
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
