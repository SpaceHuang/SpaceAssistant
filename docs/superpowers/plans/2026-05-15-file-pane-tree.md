# File Pane Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat file list in the sider's FilePane with an antd DirectoryTree-based tree browser supporting lazy loading, CRUD operations, context menu, inline input, delete confirmation, and drag-and-drop.

**Architecture:** antd `DirectoryTree` for tree rendering/interaction, `useFileTree` custom hook for business logic (state, API calls, drag validation), thin component layer for rendering. 5 new backend IPC channels for file CRUD/move. All icons from Mingcute set via existing `patchSvg` pattern.

**Tech Stack:** React 18, antd 5 (DirectoryTree), TypeScript, Vitest, @testing-library/react, Electron IPC

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/renderer/components/FileTree/useFileTree.ts` | Hook: tree state, API calls, CRUD, drag validation |
| Create | `src/renderer/components/FileTree/FileTree.tsx` | Main tree component composing hook + antd DirectoryTree |
| Create | `src/renderer/components/FileTree/FileTreeNode.tsx` | Single node render: icon + name or InlineInput |
| Create | `src/renderer/components/FileTree/FileTreeToolbar.tsx` | Toolbar: new file, new directory, refresh |
| Create | `src/renderer/components/FileTree/FileTreeContextMenu.tsx` | Right-click context menu |
| Create | `src/renderer/components/FileTree/DeleteConfirmModal.tsx` | Delete confirmation modal |
| Create | `src/renderer/components/FileTree/InlineInput.tsx` | Inline text input for create/rename |
| Create | `src/renderer/components/FileTree/index.ts` | Barrel export |
| Create | `src/renderer/components/FileTree/fileTree.css` | Scoped style overrides for antd Tree |
| Create | `src/renderer/components/FileTree/useFileTree.test.ts` | Hook unit tests |
| Create | `src/renderer/components/FileTree/InlineInput.test.tsx` | InlineInput component tests |
| Create | `src/renderer/components/FileTree/DeleteConfirmModal.test.tsx` | DeleteConfirmModal component tests |
| Create | `src/renderer/components/FileTree/FileTreeToolbar.test.tsx` | FileTreeToolbar component tests |
| Create | `src/renderer/components/FileTree/FileTreeContextMenu.test.tsx` | FileTreeContextMenu component tests |
| Create | `electron/appIpc.file.test.ts` | Backend IPC handler unit tests |
| Create | `src/renderer/assets/folder_open_line.svg` | Mingcute folder open icon |
| Create | `src/renderer/assets/file_line.svg` | Mingcute file icon |
| Create | `src/renderer/assets/add_line.svg` | Mingcute add icon |
| Create | `src/renderer/assets/new_folder_line.svg` | Mingcute new folder icon |
| Create | `src/renderer/assets/refresh_2_line.svg` | Mingcute refresh icon |
| Create | `src/renderer/assets/delete_line.svg` | Mingcute delete icon |
| Create | `src/renderer/assets/pencil_line.svg` | Mingcute pencil icon |
| Create | `src/renderer/assets/copy_line.svg` | Mingcute copy icon |
| Modify | `src/shared/api.ts` | Add 5 method signatures to SpaceAssistantApi |
| Modify | `electron/preload.ts` | Add 5 IPC invoke mappings |
| Modify | `electron/appIpc.ts` | Add 5 ipcMain.handle handlers |
| Modify | `src/renderer/App.tsx` | Replace FilePane inline function with FileTree component |

---

### Task 1: Copy icon SVGs from Mingcute to assets

**Files:**
- Create: `src/renderer/assets/folder_open_line.svg`
- Create: `src/renderer/assets/file_line.svg`
- Create: `src/renderer/assets/add_line.svg`
- Create: `src/renderer/assets/new_folder_line.svg`
- Create: `src/renderer/assets/refresh_2_line.svg`
- Create: `src/renderer/assets/delete_line.svg`
- Create: `src/renderer/assets/pencil_line.svg`
- Create: `src/renderer/assets/copy_line.svg`

- [ ] **Step 1: Copy 8 SVG files from Mingcute to assets directory**

```bash
cp res/mingcute-icons-main/svg/file/folder_open_line.svg src/renderer/assets/folder_open_line.svg
cp res/mingcute-icons-main/svg/file/file_line.svg src/renderer/assets/file_line.svg
cp res/mingcute-icons-main/svg/system/add_line.svg src/renderer/assets/add_line.svg
cp res/mingcute-icons-main/svg/file/new_folder_line.svg src/renderer/assets/new_folder_line.svg
cp res/mingcute-icons-main/svg/system/refresh_2_line.svg src/renderer/assets/refresh_2_line.svg
cp res/mingcute-icons-main/svg/system/delete_line.svg src/renderer/assets/delete_line.svg
cp res/mingcute-icons-main/svg/editor/pencil_line.svg src/renderer/assets/pencil_line.svg
cp res/mingcute-icons-main/svg/file/copy_line.svg src/renderer/assets/copy_line.svg
```

- [ ] **Step 2: Verify files exist and have correct `fill="#09244B"` pattern**

```bash
grep -l 'fill="#09244B"' src/renderer/assets/folder_open_line.svg src/renderer/assets/file_line.svg src/renderer/assets/add_line.svg src/renderer/assets/new_folder_line.svg src/renderer/assets/refresh_2_line.svg src/renderer/assets/delete_line.svg src/renderer/assets/pencil_line.svg src/renderer/assets/copy_line.svg
```

Expected: all 8 files listed

- [ ] **Step 3: Commit**

```bash
git add src/renderer/assets/folder_open_line.svg src/renderer/assets/file_line.svg src/renderer/assets/add_line.svg src/renderer/assets/new_folder_line.svg src/renderer/assets/refresh_2_line.svg src/renderer/assets/delete_line.svg src/renderer/assets/pencil_line.svg src/renderer/assets/copy_line.svg
git commit -m "feat: add Mingcute icons for file tree"
```

---

### Task 2: Add 5 backend IPC channels

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/appIpc.ts`
- Create: `electron/appIpc.file.test.ts`

- [ ] **Step 1: Write failing tests for the 5 new IPC handlers**

Create `electron/appIpc.file.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'

vi.mock('fs/promises')

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeCtx(): AppIpcContext {
  return {
    db: {} as AppIpcContext['db'],
    backup: { backupSession: vi.fn(), deleteBackup: vi.fn() } as unknown as AppIpcContext['backup'],
    getWorkDir: () => '/fake/workdir',
    setWorkDir: vi.fn(),
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn()
  }
}

describe('file IPC handlers', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.rm).mockResolvedValue(undefined)
    vi.mocked(fs.rename).mockResolvedValue(undefined)
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats)
  })

  describe('file:create-file', () => {
    it('creates an empty file', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await handler({}, 'newfile.txt')
      expect(fs.writeFile).toHaveBeenCalledWith('/fake/workdir/newfile.txt', '')
    })

    it('creates intermediate directories', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await handler({}, 'sub/dir/file.txt')
      expect(fs.mkdir).toHaveBeenCalledWith('/fake/workdir/sub/dir', { recursive: true })
      expect(fs.writeFile).toHaveBeenCalledWith('/fake/workdir/sub/dir/file.txt', '')
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
      expect(fs.mkdir).toHaveBeenCalledWith('/fake/workdir/a/b/c', { recursive: true })
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
      expect(fs.rm).toHaveBeenCalledWith('/fake/workdir/old.txt', { recursive: true, force: true })
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
      expect(fs.rename).toHaveBeenCalledWith('/fake/workdir/old.txt', '/fake/workdir/new.txt')
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
      expect(fs.rename).toHaveBeenCalledWith('/fake/workdir/src/file.txt', '/fake/workdir/dest/file.txt')
    })

    it('rejects if destination is not a directory', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as unknown as import('fs').Stats)
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
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run electron/appIpc.file.test.ts
```

Expected: FAIL — handlers not registered yet (the `getHandler` calls return undefined)

- [ ] **Step 3: Add 5 method signatures to `src/shared/api.ts`**

Add after the `fileReadFile` line:

```ts
  fileCreateFile: (relPath: string) => Promise<void>
  fileCreateDirectory: (relPath: string) => Promise<void>
  fileDelete: (relPath: string) => Promise<void>
  fileRename: (relPath: string, newName: string) => Promise<void>
  fileMove: (srcRelPath: string, destDirRelPath: string) => Promise<void>
```

- [ ] **Step 4: Add 5 IPC invoke mappings to `electron/preload.ts`**

Add after the `fileReadFile` line:

```ts
  fileCreateFile: (relPath) => ipcRenderer.invoke('file:create-file', relPath),
  fileCreateDirectory: (relPath) => ipcRenderer.invoke('file:create-directory', relPath),
  fileDelete: (relPath) => ipcRenderer.invoke('file:delete', relPath),
  fileRename: (relPath, newName) => ipcRenderer.invoke('file:rename', relPath, newName),
  fileMove: (srcRelPath, destDirRelPath) => ipcRenderer.invoke('file:move', srcRelPath, destDirRelPath),
```

- [ ] **Step 5: Add 5 IPC handlers to `electron/appIpc.ts`**

Add after the `file:read-file` handler block, before `search:execute`:

```ts
  ipcMain.handle('file:create-file', async (_e, rel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '')
  })

  ipcMain.handle('file:create-directory', async (_e, rel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    await fs.mkdir(target, { recursive: true })
  })

  ipcMain.handle('file:delete', async (_e, rel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    await fs.rm(target, { recursive: true, force: true })
  })

  ipcMain.handle('file:rename', async (_e, rel: string, newName: string): Promise<void> => {
    if (newName.includes('/') || newName.includes('\\')) {
      throw new Error('新名称不允许包含路径分隔符')
    }
    const root = ctx.getWorkDir()
    const oldPath = resolveSafePath(root, rel)
    const newPath = path.join(path.dirname(oldPath), newName)
    await fs.rename(oldPath, newPath)
  })

  ipcMain.handle('file:move', async (_e, srcRel: string, destDirRel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const srcPath = resolveSafePath(root, srcRel)
    const destDirPath = resolveSafePath(root, destDirRel)
    const destStat = await fs.stat(destDirPath)
    if (!destStat.isDirectory()) {
      throw new Error('目标路径不是目录')
    }
    const srcName = path.basename(srcPath)
    await fs.rename(srcPath, path.join(destDirPath, srcName))
  })
```

Note: `path` is already imported at the top of `appIpc.ts`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run electron/appIpc.file.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/api.ts electron/preload.ts electron/appIpc.ts electron/appIpc.file.test.ts
git commit -m "feat: add file CRUD and move IPC channels with tests"
```

---

### Task 3: Create `useFileTree` hook

**Files:**
- Create: `src/renderer/components/FileTree/useFileTree.ts`
- Create: `src/renderer/components/FileTree/useFileTree.test.ts`

- [ ] **Step 1: Write failing tests for `useFileTree`**

Create `src/renderer/components/FileTree/useFileTree.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileTree } from './useFileTree'

const mockApi = {
  fileListDirectory: vi.fn(),
  fileCreateFile: vi.fn(),
  fileCreateDirectory: vi.fn(),
  fileDelete: vi.fn(),
  fileRename: vi.fn(),
  fileMove: vi.fn()
}

beforeEach(() => {
  vi.stubGlobal('window', { api: mockApi })
  mockApi.fileListDirectory.mockResolvedValue([
    { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
    { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 100 }
  ])
  mockApi.fileCreateFile.mockResolvedValue(undefined)
  mockApi.fileCreateDirectory.mockResolvedValue(undefined)
  mockApi.fileDelete.mockResolvedValue(undefined)
  mockApi.fileRename.mockResolvedValue(undefined)
  mockApi.fileMove.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useFileTree', () => {
  it('loads root children on init', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())
    expect(mockApi.fileListDirectory).toHaveBeenCalledWith('')
    expect(result.current.treeData).toHaveLength(1)
    const root = result.current.treeData[0]
    expect(root.name).toBe('project')
    expect(root.children).toHaveLength(2)
  })

  it('sorts directories before files', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())
    const root = result.current.treeData[0]
    expect(root.children[0].isDirectory).toBe(true)
    expect(root.children[1].isDirectory).toBe(false)
  })

  it('toggles expand and lazy-loads children', async () => {
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
      { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 100 }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'b.txt', path: 'dir1/b.txt', isDirectory: false, size: 50 }
    ])

    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    expect(result.current.expandedKeys).not.toContain('dir1')
    expect(result.current.treeData[0].children[0].children).toHaveLength(0)

    await act(async () => {
      await result.current.toggleExpand('dir1')
    })

    expect(mockApi.fileListDirectory).toHaveBeenCalledWith('dir1')
    expect(result.current.expandedKeys).toContain('dir1')
    expect(result.current.treeData[0].children[0].children).toHaveLength(1)
  })

  it('collapses an expanded directory', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.toggleExpand('dir1')
    })
    expect(result.current.expandedKeys).toContain('dir1')

    await act(async () => {
      await result.current.toggleExpand('dir1')
    })
    expect(result.current.expandedKeys).not.toContain('dir1')
  })

  it('creates a file and refreshes parent', async () => {
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
      { name: 'new.txt', path: 'dir1/new.txt', isDirectory: false, size: 0 }
    ])

    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.createFile('dir1', 'new.txt')
    })

    expect(mockApi.fileCreateFile).toHaveBeenCalledWith('dir1/new.txt')
    expect(mockApi.fileListDirectory).toHaveBeenCalledWith('dir1')
  })

  it('creates a directory and refreshes parent', async () => {
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
      { name: 'sub', path: 'dir1/sub', isDirectory: true, size: undefined }
    ])

    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.createDirectory('dir1', 'sub')
    })

    expect(mockApi.fileCreateDirectory).toHaveBeenCalledWith('dir1/sub')
  })

  it('deletes a node', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.deleteNode('a.txt')
    })

    expect(mockApi.fileDelete).toHaveBeenCalledWith('a.txt')
    expect(result.current.treeData[0].children.find((c: { key: string }) => c.key === 'a.txt')).toBeUndefined()
  })

  it('renames a node', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.renameNode('a.txt', 'b.txt')
    })

    expect(mockApi.fileRename).toHaveBeenCalledWith('a.txt', 'b.txt')
    expect(result.current.treeData[0].children.find((c: { key: string }) => c.key === 'a.txt')).toBeUndefined()
    expect(result.current.treeData[0].children.find((c: { key: string }) => c.key === 'b.txt')).toBeDefined()
  })

  it('refreshes the entire tree', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'newdir', path: 'newdir', isDirectory: true, size: undefined }
    ])

    await act(async () => {
      await result.current.refreshTree()
    })

    expect(result.current.treeData[0].children).toHaveLength(1)
    expect(result.current.treeData[0].children[0].name).toBe('newdir')
  })

  it('sets inlineInput state', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    expect(result.current.inlineInput).toBeNull()

    act(() => {
      result.current.setInlineInput({ parentKey: '', type: 'file', defaultName: 'untitled' })
    })

    expect(result.current.inlineInput).toEqual({ parentKey: '', type: 'file', defaultName: 'untitled' })
  })

  it('sets renamingKey state', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    expect(result.current.renamingKey).toBeNull()

    act(() => {
      result.current.setRenamingKey('a.txt')
    })

    expect(result.current.renamingKey).toBe('a.txt')
  })

  it('validates drag: rejects drop on self', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    const valid = result.current.validateDrop('dir1', 'dir1')
    expect(valid).toBe(false)
  })

  it('validates drag: rejects drop on same parent', async () => {
    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    // a.txt's parent is root (key='')
    const valid = result.current.validateDrop('a.txt', '')
    expect(valid).toBe(false)
  })

  it('validates drag: rejects drop on own descendant', async () => {
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'sub', path: 'dir1/sub', isDirectory: true, size: undefined }
    ])

    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.toggleExpand('dir1')
    })

    // dir1 is parent of dir1/sub, so dropping dir1 onto dir1/sub is invalid
    const valid = result.current.validateDrop('dir1', 'dir1/sub')
    expect(valid).toBe(false)
  })

  it('validates drag: accepts valid drop', async () => {
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
      { name: 'dir2', path: 'dir2', isDirectory: true, size: undefined }
    ])

    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    const valid = result.current.validateDrop('a.txt', 'dir1')
    expect(valid).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/renderer/components/FileTree/useFileTree.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement `useFileTree` hook**

Create `src/renderer/components/FileTree/useFileTree.ts`:

```ts
import { useState, useCallback, useRef, useEffect } from 'react'
import type { FileInfo } from '../../../shared/domainTypes'

export interface FileTreeNode {
  key: string
  name: string
  relPath: string
  isDirectory: boolean
  size?: number
  expanded: boolean
  loading: boolean
  children: FileTreeNode[]
}

export interface InlineInputState {
  parentKey: string
  type: 'file' | 'directory'
  defaultName: string
}

export function useFileTree(workDir: string) {
  const rootName = workDir.split(/[/\\]/).filter(Boolean).pop() || 'project'

  const [treeData, setTreeData] = useState<FileTreeNode[]>([
    { key: '', name: rootName, relPath: '', isDirectory: true, expanded: true, loading: false, children: [] }
  ])
  const [expandedKeys, setExpandedKeys] = useState<string[]>([''])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)

  const nodeMapRef = useRef(new Map<string, FileTreeNode>())

  const rebuildNodeMap = useCallback((nodes: FileTreeNode[]) => {
    const map = new Map<string, FileTreeNode>()
    const walk = (list: FileTreeNode[]) => {
      for (const n of list) {
        map.set(n.key, n)
        if (n.children.length > 0) walk(n.children)
      }
    }
    walk(nodes)
    nodeMapRef.current = map
    return map
  }, [])

  const ensureNodeMap = useCallback(() => {
    if (nodeMapRef.current.size === 0) rebuildNodeMap(treeData)
    return nodeMapRef.current
  }, [treeData, rebuildNodeMap])

  const fileInfoToNode = useCallback((info: FileInfo): FileTreeNode => ({
    key: info.path,
    name: info.name,
    relPath: info.path,
    isDirectory: info.isDirectory,
    size: info.size,
    expanded: false,
    loading: false,
    children: []
  }), [])

  const sortNodes = useCallback((nodes: FileTreeNode[]): FileTreeNode[] =>
    [...nodes].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  , [])

  // Load root children on mount
  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.fileListDirectory('')
        const root = treeData[0]
        root.children = sortNodes(list.map(fileInfoToNode))
        const newData = [{ ...root, children: [...root.children] }]
        setTreeData(newData)
        rebuildNodeMap(newData)
      } catch { /* ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleExpand = useCallback(async (key: string) => {
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node || !node.isDirectory) return

    if (node.expanded) {
      node.expanded = false
      setExpandedKeys((prev) => prev.filter((k) => k !== key))
      setTreeData((prev) => [...prev])
      return
    }

    // Lazy load
    if (node.children.length === 0 && !node.loading) {
      node.loading = true
      setTreeData((prev) => [...prev])
      try {
        const list = await window.api.fileListDirectory(key)
        node.children = sortNodes(list.map(fileInfoToNode))
      } catch {
        node.children = []
      }
      node.loading = false
    }

    node.expanded = true
    setExpandedKeys((prev) => [...prev, key])
    setTreeData((prev) => [...prev])
    rebuildNodeMap(treeData)
  }, [ensureNodeMap, fileInfoToNode, sortNodes, treeData])

  const refreshDirectory = useCallback(async (key: string) => {
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node || !node.isDirectory) return

    try {
      const list = await window.api.fileListDirectory(key === '' ? '' : key)
      node.children = sortNodes(list.map(fileInfoToNode))
    } catch {
      node.children = []
    }
    setTreeData((prev) => [...prev])
    rebuildNodeMap(treeData)
  }, [ensureNodeMap, fileInfoToNode, sortNodes, treeData])

  const refreshTree = useCallback(async () => {
    try {
      const list = await window.api.fileListDirectory('')
      const root = treeData[0]
      root.children = sortNodes(list.map(fileInfoToNode))
      const newData = [{ ...root, children: [...root.children] }]
      setTreeData(newData)
      setExpandedKeys([''])
      rebuildNodeMap(newData)
    } catch { /* ignore */ }
  }, [fileInfoToNode, sortNodes, treeData])

  const createFile = useCallback(async (parentKey: string, name: string) => {
    const parent = parentKey === '' ? '' : parentKey
    const relPath = parent ? `${parent}/${name}` : name
    await window.api.fileCreateFile(relPath)
    await refreshDirectory(parentKey)
  }, [refreshDirectory])

  const createDirectory = useCallback(async (parentKey: string, name: string) => {
    const parent = parentKey === '' ? '' : parentKey
    const relPath = parent ? `${parent}/${name}` : name
    await window.api.fileCreateDirectory(relPath)
    await refreshDirectory(parentKey)
  }, [refreshDirectory])

  const deleteNode = useCallback(async (key: string) => {
    await window.api.fileDelete(key)
    // Remove from parent's children
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node) return
    const parentKey = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : ''
    const parent = map.get(parentKey)
    if (parent) {
      parent.children = parent.children.filter((c) => c.key !== key)
    }
    map.delete(key)
    setTreeData((prev) => [...prev])
    if (selectedKey === key) setSelectedKey(null)
  }, [ensureNodeMap, selectedKey])

  const renameNode = useCallback(async (key: string, newName: string) => {
    await window.api.fileRename(key, newName)
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node) return

    const parentKey = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : ''
    const newKey = parentKey ? `${parentKey}/${newName}` : newName

    // Update in parent's children
    const parent = map.get(parentKey)
    if (parent) {
      const idx = parent.children.findIndex((c) => c.key === key)
      if (idx >= 0) {
        parent.children = sortNodes(
          parent.children.map((c) =>
            c.key === key ? { ...c, key: newKey, name: newName, relPath: newKey } : c
          )
        )
      }
    }
    map.delete(key)
    map.set(newKey, { ...node, key: newKey, name: newName, relPath: newKey })
    setTreeData((prev) => [...prev])
    if (selectedKey === key) setSelectedKey(newKey)
    setRenamingKey(null)
  }, [ensureNodeMap, selectedKey, sortNodes])

  const validateDrop = useCallback((srcKey: string, destDirKey: string): boolean => {
    if (srcKey === destDirKey) return false

    // Reject drop on same parent
    const srcParentKey = srcKey.includes('/') ? srcKey.substring(0, srcKey.lastIndexOf('/')) : ''
    if (srcParentKey === destDirKey) return false

    // Reject drop on own descendant
    if (destDirKey.startsWith(srcKey + '/')) return false

    return true
  }, [])

  const onDrop = useCallback(async (srcKey: string, destDirKey: string) => {
    if (!validateDrop(srcKey, destDirKey)) return
    await window.api.fileMove(srcKey, destDirKey)

    // Remove from old parent
    const map = ensureNodeMap()
    const srcParentKey = srcKey.includes('/') ? srcKey.substring(0, srcKey.lastIndexOf('/')) : ''
    const oldParent = map.get(srcParentKey)
    if (oldParent) {
      oldParent.children = oldParent.children.filter((c) => c.key !== srcKey)
    }

    // Refresh new parent
    await refreshDirectory(destDirKey)
  }, [validateDrop, ensureNodeMap, refreshDirectory])

  return {
    treeData,
    expandedKeys,
    selectedKey,
    setSelectedKey,
    inlineInput,
    setInlineInput: (v: InlineInputState | null) => setInlineInput(v),
    renamingKey,
    setRenamingKey: (v: string | null) => setRenamingKey(v),
    toggleExpand,
    refreshTree,
    refreshDirectory,
    createFile,
    createDirectory,
    deleteNode,
    renameNode,
    validateDrop,
    onDrop,
    workDir
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/renderer/components/FileTree/useFileTree.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/FileTree/useFileTree.ts src/renderer/components/FileTree/useFileTree.test.ts
git commit -m "feat: add useFileTree hook with tests"
```

---

### Task 4: Create InlineInput component

**Files:**
- Create: `src/renderer/components/FileTree/InlineInput.tsx`
- Create: `src/renderer/components/FileTree/InlineInput.test.tsx`

- [ ] **Step 1: Write failing tests for InlineInput**

Create `src/renderer/components/FileTree/InlineInput.test.tsx`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InlineInput } from './InlineInput'

describe('InlineInput', () => {
  it('renders with default value', () => {
    render(<InlineInput defaultValue="untitled" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    expect(input).toBeDefined()
    expect((input as HTMLInputElement).value).toBe('untitled')
  })

  it('confirms on Enter', () => {
    const onConfirm = vi.fn()
    render(<InlineInput defaultValue="test" onConfirm={onConfirm} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('test')
  })

  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    render(<InlineInput defaultValue="test" onConfirm={vi.fn()} onCancel={onCancel} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('confirms on blur', () => {
    const onConfirm = vi.fn()
    render(<InlineInput defaultValue="blurtest" onConfirm={onConfirm} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)
    expect(onConfirm).toHaveBeenCalledWith('blurtest')
  })

  it('trims whitespace on confirm', () => {
    const onConfirm = vi.fn()
    render(<InlineInput defaultValue="  spaced  " onConfirm={onConfirm} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('spaced')
  })

  it('does not confirm empty name', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<InlineInput defaultValue="  " onConfirm={onConfirm} onCancel={onCancel} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/renderer/components/FileTree/InlineInput.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement InlineInput**

Create `src/renderer/components/FileTree/InlineInput.tsx`:

```tsx
import { useRef, useEffect } from 'react'

interface InlineInputProps {
  defaultValue: string
  onConfirm: (name: string) => void
  onCancel: () => void
}

export function InlineInput({ defaultValue, onConfirm, onCancel }: InlineInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const confirmedRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const handleConfirm = () => {
    if (confirmedRef.current) return
    confirmedRef.current = true
    const val = ref.current?.value.trim() ?? ''
    if (val) {
      onConfirm(val)
    } else {
      onCancel()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      confirmedRef.current = true
      onCancel()
    }
  }

  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      onKeyDown={handleKeyDown}
      onBlur={handleConfirm}
      style={{
        width: '100%',
        border: '1px solid #1677ff',
        borderRadius: 4,
        padding: '0 4px',
        fontSize: 13,
        lineHeight: '22px',
        outline: 'none',
        background: '#fff'
      }}
    />
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/renderer/components/FileTree/InlineInput.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/FileTree/InlineInput.tsx src/renderer/components/FileTree/InlineInput.test.tsx
git commit -m "feat: add InlineInput component with tests"
```

---

### Task 5: Create DeleteConfirmModal component

**Files:**
- Create: `src/renderer/components/FileTree/DeleteConfirmModal.tsx`
- Create: `src/renderer/components/FileTree/DeleteConfirmModal.test.tsx`

- [ ] **Step 1: Write failing tests for DeleteConfirmModal**

Create `src/renderer/components/FileTree/DeleteConfirmModal.test.tsx`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeleteConfirmModal } from './DeleteConfirmModal'

describe('DeleteConfirmModal', () => {
  it('shows file-specific message', () => {
    render(<DeleteConfirmModal open={true} name="test.txt" isDirectory={false} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/test.txt/)).toBeDefined()
    expect(screen.getByText(/不可撤销/)).toBeDefined()
  })

  it('shows directory-specific message', () => {
    render(<DeleteConfirmModal open={true} name="mydir" isDirectory={true} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/mydir/)).toBeDefined()
    expect(screen.getByText(/一并删除/)).toBeDefined()
  })

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn()
    render(<DeleteConfirmModal open={true} name="f" isDirectory={false} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls onConfirm when delete is clicked', () => {
    const onConfirm = vi.fn()
    render(<DeleteConfirmModal open={true} name="f" isDirectory={false} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('删除'))
    expect(onConfirm).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/renderer/components/FileTree/DeleteConfirmModal.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement DeleteConfirmModal**

Create `src/renderer/components/FileTree/DeleteConfirmModal.tsx`:

```tsx
import { Modal } from 'antd'

interface DeleteConfirmModalProps {
  open: boolean
  name: string
  isDirectory: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmModal({ open, name, isDirectory, onConfirm, onCancel }: DeleteConfirmModalProps) {
  const description = isDirectory
    ? `确定要删除 "${name}" 吗？该目录下所有内容将被一并删除。`
    : `确定要删除 "${name}" 吗？此操作不可撤销。`

  return (
    <Modal
      open={open}
      title="确认删除"
      onCancel={onCancel}
      okText="删除"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      onOk={onConfirm}
      destroyOnClose
    >
      <p>{description}</p>
    </Modal>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/renderer/components/FileTree/DeleteConfirmModal.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/FileTree/DeleteConfirmModal.tsx src/renderer/components/FileTree/DeleteConfirmModal.test.tsx
git commit -m "feat: add DeleteConfirmModal component with tests"
```

---

### Task 6: Create FileTreeToolbar component

**Files:**
- Create: `src/renderer/components/FileTree/FileTreeToolbar.tsx`
- Create: `src/renderer/components/FileTree/FileTreeToolbar.test.tsx`

- [ ] **Step 1: Write failing tests for FileTreeToolbar**

Create `src/renderer/components/FileTree/FileTreeToolbar.test.tsx`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileTreeToolbar } from './FileTreeToolbar'

describe('FileTreeToolbar', () => {
  it('renders three icon buttons', () => {
    render(<FileTreeToolbar onNewFile={vi.fn()} onNewDirectory={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByTitle('新建文件')).toBeDefined()
    expect(screen.getByTitle('新建目录')).toBeDefined()
    expect(screen.getByTitle('刷新')).toBeDefined()
  })

  it('calls onNewFile when new file button clicked', () => {
    const onNewFile = vi.fn()
    render(<FileTreeToolbar onNewFile={onNewFile} onNewDirectory={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByTitle('新建文件'))
    expect(onNewFile).toHaveBeenCalled()
  })

  it('calls onNewDirectory when new directory button clicked', () => {
    const onNewDirectory = vi.fn()
    render(<FileTreeToolbar onNewFile={vi.fn()} onNewDirectory={onNewDirectory} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByTitle('新建目录'))
    expect(onNewDirectory).toHaveBeenCalled()
  })

  it('calls onRefresh when refresh button clicked', () => {
    const onRefresh = vi.fn()
    render(<FileTreeToolbar onNewFile={vi.fn()} onNewDirectory={vi.fn()} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTitle('刷新'))
    expect(onRefresh).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/renderer/components/FileTree/FileTreeToolbar.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement FileTreeToolbar**

Create `src/renderer/components/FileTree/FileTreeToolbar.tsx`:

```tsx
import { Tooltip } from 'antd'
import addLineRaw from '../../assets/add_line.svg?raw'
import newFolderLineRaw from '../../assets/new_folder_line.svg?raw'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'

const patchSvg = (raw: string) => raw.replace(/fill="#09244B"/g, 'fill="currentColor"')

const addSvg = patchSvg(addLineRaw)
const newFolderSvg = patchSvg(newFolderLineRaw)
const refreshSvg = patchSvg(refresh2LineRaw)

interface FileTreeToolbarProps {
  onNewFile: () => void
  onNewDirectory: () => void
  onRefresh: () => void
}

export function FileTreeToolbar({ onNewFile, onNewDirectory, onRefresh }: FileTreeToolbarProps) {
  const btnStyle: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 4,
    display: 'inline-flex',
    alignItems: 'center',
    color: '#8c8c8c',
    lineHeight: 0
  }

  return (
    <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
      <Tooltip title="新建文件">
        <button type="button" style={btnStyle} onClick={onNewFile} dangerouslySetInnerHTML={{ __html: addSvg }} />
      </Tooltip>
      <Tooltip title="新建目录">
        <button type="button" style={btnStyle} onClick={onNewDirectory} dangerouslySetInnerHTML={{ __html: newFolderSvg }} />
      </Tooltip>
      <Tooltip title="刷新">
        <button type="button" style={btnStyle} onClick={onRefresh} dangerouslySetInnerHTML={{ __html: refreshSvg }} />
      </Tooltip>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/renderer/components/FileTree/FileTreeToolbar.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/FileTree/FileTreeToolbar.tsx src/renderer/components/FileTree/FileTreeToolbar.test.tsx
git commit -m "feat: add FileTreeToolbar component with tests"
```

---

### Task 7: Create FileTreeContextMenu component

**Files:**
- Create: `src/renderer/components/FileTree/FileTreeContextMenu.tsx`
- Create: `src/renderer/components/FileTree/FileTreeContextMenu.test.tsx`

- [ ] **Step 1: Write failing tests for FileTreeContextMenu**

Create `src/renderer/components/FileTree/FileTreeContextMenu.test.tsx`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileTreeContextMenu } from './FileTreeContextMenu'

describe('FileTreeContextMenu', () => {
  const defaultProps = {
    relPath: 'src/file.ts',
    name: 'file.ts',
    isDirectory: false,
    onAddToChat: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelPath: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn()
  }

  it('renders all menu items', () => {
    render(<FileTreeContextMenu {...defaultProps} />)
    expect(screen.getByText('添加到对话')).toBeDefined()
    expect(screen.getByText('复制路径')).toBeDefined()
    expect(screen.getByText('复制相对路径')).toBeDefined()
    expect(screen.getByText('重命名...')).toBeDefined()
    expect(screen.getByText('删除')).toBeDefined()
  })

  it('calls onAddToChat', () => {
    render(<FileTreeContextMenu {...defaultProps} />)
    fireEvent.click(screen.getByText('添加到对话'))
    expect(defaultProps.onAddToChat).toHaveBeenCalled()
  })

  it('calls onCopyPath', () => {
    render(<FileTreeContextMenu {...defaultProps} />)
    fireEvent.click(screen.getByText('复制路径'))
    expect(defaultProps.onCopyPath).toHaveBeenCalled()
  })

  it('calls onCopyRelPath', () => {
    render(<FileTreeContextMenu {...defaultProps} />)
    fireEvent.click(screen.getByText('复制相对路径'))
    expect(defaultProps.onCopyRelPath).toHaveBeenCalled()
  })

  it('calls onRename', () => {
    render(<FileTreeContextMenu {...defaultProps} />)
    fireEvent.click(screen.getByText('重命名...'))
    expect(defaultProps.onRename).toHaveBeenCalled()
  })

  it('calls onDelete', () => {
    render(<FileTreeContextMenu {...defaultProps} />)
    fireEvent.click(screen.getByText('删除'))
    expect(defaultProps.onDelete).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/renderer/components/FileTree/FileTreeContextMenu.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement FileTreeContextMenu**

Create `src/renderer/components/FileTree/FileTreeContextMenu.tsx`:

```tsx
import { Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'
import copyLineRaw from '../../assets/copy_line.svg?raw'
import deleteLineRaw from '../../assets/delete_line.svg?raw'
import pencilLineRaw from '../../assets/pencil_line.svg?raw'

const patchSvg = (raw: string) => raw.replace(/fill="#09244B"/g, 'fill="currentColor"')

const copySvg = patchSvg(copyLineRaw)
const deleteSvg = patchSvg(deleteLineRaw)
const pencilSvg = patchSvg(pencilLineRaw)

const iconStyle: React.CSSProperties = { width: 14, height: 14, display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }

interface FileTreeContextMenuProps {
  relPath: string
  name: string
  isDirectory: boolean
  onAddToChat: () => void
  onCopyPath: () => void
  onCopyRelPath: () => void
  onRename: () => void
  onDelete: () => void
  children: React.ReactNode
}

export function FileTreeContextMenu({
  relPath, name, isDirectory, onAddToChat, onCopyPath, onCopyRelPath, onRename, onDelete, children
}: FileTreeContextMenuProps) {
  const items: MenuProps['items'] = [
    {
      key: 'add-to-chat',
      label: '添加到对话',
      onClick: () => {
        onAddToChat()
        message.info('功能开发中')
      }
    },
    { type: 'divider' },
    {
      key: 'copy-path',
      label: '复制路径',
      icon: <span dangerouslySetInnerHTML={{ __html: copySvg }} style={iconStyle} />,
      onClick: onCopyPath
    },
    {
      key: 'copy-rel-path',
      label: '复制相对路径',
      onClick: onCopyRelPath
    },
    { type: 'divider' },
    {
      key: 'rename',
      label: '重命名...',
      icon: <span dangerouslySetInnerHTML={{ __html: pencilSvg }} style={iconStyle} />,
      onClick: onRename
    },
    {
      key: 'delete',
      label: '删除',
      danger: true,
      icon: <span dangerouslySetInnerHTML={{ __html: deleteSvg }} style={iconStyle} />,
      onClick: onDelete
    }
  ]

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/renderer/components/FileTree/FileTreeContextMenu.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/FileTree/FileTreeContextMenu.tsx src/renderer/components/FileTree/FileTreeContextMenu.test.tsx
git commit -m "feat: add FileTreeContextMenu component with tests"
```

---

### Task 8: Create FileTreeNode and FileTree components + CSS

**Files:**
- Create: `src/renderer/components/FileTree/FileTreeNode.tsx`
- Create: `src/renderer/components/FileTree/FileTree.tsx`
- Create: `src/renderer/components/FileTree/fileTree.css`
- Create: `src/renderer/components/FileTree/index.ts`

- [ ] **Step 1: Create FileTreeNode component**

Create `src/renderer/components/FileTree/FileTreeNode.tsx`:

```tsx
import { InlineInput } from './InlineInput'
import folderLineRaw from '../../assets/folder_line.svg?raw'
import folderOpenLineRaw from '../../assets/folder_open_line.svg?raw'
import fileLineRaw from '../../assets/file_line.svg?raw'

const patchSvg = (raw: string) => raw.replace(/fill="#09244B"/g, 'fill="currentColor"')

const folderSvg = patchSvg(folderLineRaw)
const folderOpenSvg = patchSvg(folderOpenLineRaw)
const fileSvg = patchSvg(fileLineRaw)

interface FileTreeNodeProps {
  name: string
  isDirectory: boolean
  expanded: boolean
  isRenaming: boolean
  isNewInput: boolean
  newInputType: 'file' | 'directory'
  newInputDefaultName: string
  onRenameConfirm: (newName: string) => void
  onRenameCancel: () => void
  onCreateConfirm: (name: string) => void
  onCreateCancel: () => void
}

const iconStyle: React.CSSProperties = { width: 16, height: 16, marginRight: 6, flexShrink: 0, verticalAlign: '-2px' }

export function FileTreeNode({
  name, isDirectory, expanded, isRenaming, isNewInput, newInputType, newInputDefaultName,
  onRenameConfirm, onRenameCancel, onCreateConfirm, onCreateCancel
}: FileTreeNodeProps) {
  const icon = isDirectory
    ? (expanded ? folderOpenSvg : folderSvg)
    : fileSvg

  if (isRenaming) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', width: '100%' }}>
        <span dangerouslySetInnerHTML={{ __html: icon }} style={iconStyle} />
        <InlineInput defaultValue={name} onConfirm={onRenameConfirm} onCancel={onRenameCancel} />
      </span>
    )
  }

  if (isNewInput) {
    const inputIcon = newInputType === 'directory' ? folderSvg : fileSvg
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', width: '100%' }}>
        <span dangerouslySetInnerHTML={{ __html: inputIcon }} style={iconStyle} />
        <InlineInput defaultValue={newInputDefaultName} onConfirm={onCreateConfirm} onCancel={onCreateCancel} />
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', overflow: 'hidden' }}>
      <span dangerouslySetInnerHTML={{ __html: icon }} style={iconStyle} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </span>
  )
}
```

- [ ] **Step 2: Create FileTree CSS**

Create `src/renderer/components/FileTree/fileTree.css`:

```css
.file-tree .ant-tree-treenode {
  padding: 0;
  height: 32px;
  align-items: center;
}

.file-tree .ant-tree-treenode:hover .ant-tree-node-content-wrapper {
  background: rgba(0, 0, 0, 0.04) !important;
}

.file-tree .ant-tree-treenode-selected .ant-tree-node-content-wrapper,
.file-tree .ant-tree-treenode-selected:hover .ant-tree-node-content-wrapper {
  background: rgba(22, 119, 255, 0.12) !important;
}

.file-tree .ant-tree-indent-unit {
  width: 16px;
}

.file-tree .ant-tree-dragging .ant-tree-treenode-dragging {
  opacity: 0.5;
}

.file-tree .ant-tree-treenode-drop-over .ant-tree-node-content-wrapper {
  background: rgba(22, 119, 255, 0.08) !important;
}

.file-tree .ant-tree-node-content-wrapper {
  flex: 1;
  min-width: 0;
}

.file-tree .ant-tree-switcher {
  width: 16px;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Create FileTree main component**

Create `src/renderer/components/FileTree/FileTree.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { DirectoryTree } from 'antd'
import { message } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { useFileTree } from './useFileTree'
import type { FileTreeNode as FileTreeNodeData } from './useFileTree'
import { FileTreeNode } from './FileTreeNode'
import { FileTreeToolbar } from './FileTreeToolbar'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import './fileTree.css'

interface FileTreeProps {
  workDir: string
  onFileSelect?: (relPath: string) => void
}

export function FileTree({ workDir, onFileSelect }: FileTreeProps) {
  const tree = useFileTree(workDir)
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; name: string; isDirectory: boolean } | null>(null)

  const toAntdDataNodes = useCallback((nodes: FileTreeNodeData[]): DataNode[] => {
    return nodes.map((node) => ({
      key: node.key,
      title: (
        <FileTreeNode
          name={node.name}
          isDirectory={node.isDirectory}
          expanded={node.expanded}
          isRenaming={tree.renamingKey === node.key}
          isNewInput={tree.inlineInput?.parentKey === node.key ? false : false}
          newInputType="file"
          newInputDefaultName=""
          onRenameConfirm={(newName) => tree.renameNode(node.key, newName)}
          onRenameCancel={() => tree.setRenamingKey(null)}
          onCreateConfirm={() => {}}
          onCreateCancel={() => {}}
        />
      ),
      children: node.isDirectory ? toAntdDataNodes(node.children) : undefined,
      isLeaf: !node.isDirectory
    }))
  }, [tree])

  // Handle inline input for new file/directory: inject an extra "virtual" child
  const toAntdDataNodesWithInput = useCallback((nodes: FileTreeNodeData[]): DataNode[] => {
    return nodes.map((node) => {
      const isInputTarget = tree.inlineInput?.parentKey === node.key
      const children = node.isDirectory ? toAntdDataNodesWithInput(node.children) : undefined
      const inputChild: DataNode | null = isInputTarget
        ? {
            key: `__inline_input__${node.key}`,
            title: (
              <FileTreeNode
                name=""
                isDirectory={tree.inlineInput.type === 'directory'}
                expanded={false}
                isRenaming={false}
                isNewInput={true}
                newInputType={tree.inlineInput.type}
                newInputDefaultName={tree.inlineInput.defaultName}
                onRenameConfirm={() => {}}
                onRenameCancel={() => {}}
                onCreateConfirm={(name) => {
                  if (tree.inlineInput.type === 'file') {
                    tree.createFile(node.key, name)
                  } else {
                    tree.createDirectory(node.key, name)
                  }
                  tree.setInlineInput(null)
                }}
                onCreateCancel={() => tree.setInlineInput(null)}
              />
            ),
            isLeaf: true
          }
        : null

      return {
        key: node.key,
        title: (
          <FileTreeContextMenu
            relPath={node.relPath}
            name={node.name}
            isDirectory={node.isDirectory}
            onAddToChat={() => {}}
            onCopyPath={() => {
              const abs = workDir + (node.relPath ? '/' + node.relPath : '')
              void navigator.clipboard.writeText(abs)
              message.success('已复制绝对路径')
            }}
            onCopyRelPath={() => {
              void navigator.clipboard.writeText(node.relPath || '.')
              message.success('已复制相对路径')
            }}
            onRename={() => tree.setRenamingKey(node.key)}
            onDelete={() => setDeleteTarget({ key: node.key, name: node.name, isDirectory: node.isDirectory })}
          >
            <FileTreeNode
              name={node.name}
              isDirectory={node.isDirectory}
              expanded={node.expanded}
              isRenaming={tree.renamingKey === node.key}
              isNewInput={false}
              newInputType="file"
              newInputDefaultName=""
              onRenameConfirm={(newName) => tree.renameNode(node.key, newName)}
              onRenameCancel={() => tree.setRenamingKey(null)}
              onCreateConfirm={() => {}}
              onCreateCancel={() => {}}
            />
          </FileTreeContextMenu>
        ),
        children: inputChild && children ? [...children, inputChild] : inputChild ? [inputChild] : children,
        isLeaf: !node.isDirectory
      }
    })
  }, [tree, workDir])

  const antdTreeData = toAntdDataNodesWithInput(tree.treeData)

  const handleSelect = (_selectedKeys: React.Key[], info: { node: EventDataNode }) => {
    const key = info.node.key as string
    const node = tree.treeData.length > 0 ? findNode(tree.treeData, key) : null
    if (!node) return
    tree.setSelectedKey(key)
    if (node.isDirectory) {
      void tree.toggleExpand(key)
    } else {
      onFileSelect?.(key)
    }
  }

  const handleExpand = (keys: React.Key[]) => {
    // Find newly expanded keys and load them
    const newKeys = keys.filter((k) => !tree.expandedKeys.includes(k as string))
    for (const k of newKeys) {
      void tree.toggleExpand(k as string)
    }
    // Handle collapsed keys
    const collapsedKeys = tree.expandedKeys.filter((k) => !keys.includes(k))
    for (const k of collapsedKeys) {
      void tree.toggleExpand(k)
    }
  }

  const handleNewFile = () => {
    const parentKey = tree.selectedKey || ''
    tree.setInlineInput({ parentKey, type: 'file', defaultName: 'untitled' })
    // Ensure parent is expanded
    if (!tree.expandedKeys.includes(parentKey)) {
      void tree.toggleExpand(parentKey)
    }
  }

  const handleNewDirectory = () => {
    const parentKey = tree.selectedKey || ''
    tree.setInlineInput({ parentKey, type: 'directory', defaultName: '新建文件夹' })
    if (!tree.expandedKeys.includes(parentKey)) {
      void tree.toggleExpand(parentKey)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="sider-content-header" style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>文件</span>
        <FileTreeToolbar onNewFile={handleNewFile} onNewDirectory={handleNewDirectory} onRefresh={() => tree.refreshTree()} />
      </div>
      <div className="sider-content-body" style={{ overflow: 'auto', padding: '0 4px' }}>
        <DirectoryTree
          className="file-tree"
          treeData={antdTreeData}
          expandedKeys={tree.expandedKeys}
          selectedKeys={tree.selectedKey ? [tree.selectedKey] : []}
          onSelect={handleSelect}
          onExpand={handleExpand}
          draggable={{ icon: false, nodeDraggable: () => true }}
          allowDrop={({ dragNode, dropNode, dropPosition }) => {
            // Only allow dropping on directories (dropPosition 0 = on node)
            if (dropPosition !== 0) return false
            const dragKey = dragNode.key as string
            const dropKey = dropNode.key as string
            return tree.validateDrop(dragKey, dropKey)
          }}
          onDrop={(info) => {
            const dragKey = info.dragNode.key as string
            const dropKey = info.node.key as string
            void tree.onDrop(dragKey, dropKey).catch((e: unknown) => {
              message.error(e instanceof Error ? e.message : '移动失败')
            })
          }}
          blockNode
        />
      </div>
      <DeleteConfirmModal
        open={deleteTarget !== null}
        name={deleteTarget?.name ?? ''}
        isDirectory={deleteTarget?.isDirectory ?? false}
        onConfirm={() => {
          if (deleteTarget) {
            void tree.deleteNode(deleteTarget.key)
            setDeleteTarget(null)
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

function findNode(nodes: FileTreeNodeData[], key: string): FileTreeNodeData | null {
  for (const n of nodes) {
    if (n.key === key) return n
    if (n.children.length > 0) {
      const found = findNode(n.children, key)
      if (found) return found
    }
  }
  return null
}
```

- [ ] **Step 4: Create barrel export**

Create `src/renderer/components/FileTree/index.ts`:

```ts
export { FileTree } from './FileTree'
```

- [ ] **Step 5: Run the full test suite to ensure nothing is broken**

```bash
npx vitest run
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/FileTree/FileTreeNode.tsx src/renderer/components/FileTree/FileTree.tsx src/renderer/components/FileTree/fileTree.css src/renderer/components/FileTree/index.ts
git commit -m "feat: add FileTree, FileTreeNode components and CSS"
```

---

### Task 9: Integrate FileTree into App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Replace FilePane inline function with FileTree component**

In `src/renderer/App.tsx`:

1. Add import at top:
```ts
import { FileTree } from './components/FileTree'
```

2. Remove the entire `FilePane` function (lines 88-142 in current file).

3. In `AppShell`, replace the FilePane usage:
```tsx
{siderKey === 'files' && <FilePane />}
```
with:
```tsx
{siderKey === 'files' && <FileTree workDir={config?.workDir ?? ''} onFileSelect={handleFileSelect} />}
```

4. Add `handleFileSelect` callback and preview state inside `AppShell`:
```ts
const [filePreview, setFilePreview] = useState('')

const handleFileSelect = async (relPath: string) => {
  try {
    const r = await window.api.fileReadFile(relPath)
    setFilePreview(r.content.slice(0, 4000))
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}
```

5. In the right sider area, replace the placeholder text with the file preview (matching existing FilePane behavior):
```tsx
<Layout.Sider width={240} theme="light" style={{ borderLeft: '1px solid #f0f0f0', padding: 16 }}>
  {filePreview ? (
    <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflow: 'auto', height: '100%' }}>{filePreview}</div>
  ) : (
    <Text type="secondary">右侧栏预留（功能开发中）</Text>
  )}
</Layout.Sider>
```

5. Get `config` from the store inside `AppShell`:
```ts
const config = useTypedSelector((s) => s.config.config)
```

6. Remove the `sider-content-header` that shows "文件" text (it's now inside FileTree).

- [ ] **Step 2: Verify the app compiles**

```bash
npx vite build 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: integrate FileTree component into App"
```

---

### Task 10: Manual verification and final polish

**Files:**
- Possibly modify: `src/renderer/components/FileTree/FileTree.tsx`
- Possibly modify: `src/renderer/components/FileTree/fileTree.css`

- [ ] **Step 1: Start the dev server and visually verify**

```bash
npm run dev
```

Check the following:
- Tree renders with root directory name
- Directories show folder icon, files show file icon
- Clicking directory expands/collapses with lazy loading
- Clicking file triggers preview
- Toolbar buttons are visible and functional
- Right-click context menu appears with correct items
- Inline input works for new file/directory
- Inline rename works
- Delete confirmation modal appears with correct text
- Drag and drop works (visual feedback, validation)

- [ ] **Step 2: Fix any visual issues found during manual testing**

Common adjustments:
- Indent spacing may need tuning
- Row height may need adjustment
- Icon sizes may need tweaking
- Context menu positioning

- [ ] **Step 3: Run all tests one final time**

```bash
npx vitest run
```

Expected: PASS

- [ ] **Step 4: Commit any fixes**

```bash
git add -u
git commit -m "fix: polish file tree UI after manual verification"
```
