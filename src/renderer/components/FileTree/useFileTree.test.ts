import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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

let originalApi: unknown

beforeEach(() => {
  originalApi = (window as Record<string, unknown>).api
  ;(window as Record<string, unknown>).api = mockApi
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
  ;(window as Record<string, unknown>).api = originalApi
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
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
      { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 100 }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'inner.txt', path: 'dir1/inner.txt', isDirectory: false, size: 50 }
    ])

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

  it('selectPath expands parents without collapsing already expanded dirs', async () => {
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'dir1', path: 'dir1', isDirectory: true, size: undefined },
      { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 100 }
    ])
    mockApi.fileListDirectory.mockResolvedValueOnce([
      { name: 'inner.txt', path: 'dir1/inner.txt', isDirectory: false, size: 50 }
    ])

    const { result } = renderHook(() => useFileTree('/project'))
    await act(() => Promise.resolve())

    await act(async () => {
      await result.current.toggleExpand('dir1')
    })
    expect(result.current.expandedKeys).toContain('dir1')

    await act(async () => {
      await result.current.selectPath('dir1/inner.txt')
    })

    expect(result.current.expandedKeys).toContain('dir1')
    expect(result.current.selectedKey).toBe('dir1/inner.txt')
  })
})
