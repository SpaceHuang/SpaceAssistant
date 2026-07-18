import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { FileInfo } from '../../../shared/domainTypes'
import { resetFileTreeSyncBusForTests, emitFileTreeSyncForTests } from '../../services/fileTreeSyncBus'
import { useFileTree, type FileTreeNode } from './useFileTree'

/** mock window.api 的文件相关方法，listDir 控制目录列表返回 */
function mockFileApi(listDir: (relPath: string) => FileInfo[]): void {
  const api = (window as unknown as { api?: Record<string, unknown> }).api ?? {}
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    ...api,
    fileListDirectory: vi.fn(async (relPath: string) => listDir(relPath)),
    fileOnTreeChanged: vi.fn(() => () => {}),
    fileCreateFile: vi.fn(async () => {}),
    fileCreateDirectory: vi.fn(async () => {}),
    fileDelete: vi.fn(async () => {}),
    fileRename: vi.fn(async () => {}),
    fileMove: vi.fn(async () => {})
  }
}

function findNode(nodes: FileTreeNode[], key: string): FileTreeNode | undefined {
  for (const n of nodes) {
    if (n.key === key) return n
    if (n.children.length > 0) {
      const found = findNode(n.children, key)
      if (found) return found
    }
  }
  return undefined
}

/** 构造 root -> a -> b -> c.txt 三层树，a 与 a/b 均已展开懒加载（同步 mock） */
async function setupExpandedTree() {
  const listDir = async (relPath: string): Promise<FileInfo[]> => {
    if (relPath === '') return [{ name: 'a', path: 'a', isDirectory: true }]
    if (relPath === 'a') return [{ name: 'b', path: 'a/b', isDirectory: true }]
    if (relPath === 'a/b') return [{ name: 'c.txt', path: 'a/b/c.txt', isDirectory: false }]
    return []
  }
  mockFileApi((p) => listDir(p))
  const hook = renderHook(() => useFileTree('/work', {}))
  await waitFor(() => {
    expect(hook.result.current.treeData[0].children.some((c) => c.key === 'a')).toBe(true)
  })
  await act(async () => {
    await hook.result.current.toggleExpand('a')
  })
  await act(async () => {
    await hook.result.current.toggleExpand('a/b')
  })
  return hook
}

describe('useFileTree - refreshDirectory 展开态保留', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('refreshDirectory 保留已展开子目录的 expanded 与懒加载子树', async () => {
    const { result } = await setupExpandedTree()

    const bBefore = findNode(result.current.treeData, 'a/b')
    expect(bBefore?.expanded).toBe(true)
    expect(bBefore?.children.some((c) => c.key === 'a/b/c.txt')).toBe(true)

    await act(async () => {
      await result.current.refreshDirectory('a')
    })

    const bAfter = findNode(result.current.treeData, 'a/b')
    expect(bAfter?.expanded).toBe(true)
    expect(bAfter?.children.some((c) => c.key === 'a/b/c.txt')).toBe(true)
  })

  it('refreshDirectory 保留 selectedKey', async () => {
    const { result } = await setupExpandedTree()

    await act(async () => {
      result.current.setSelectedKey('a/b/c.txt')
    })
    expect(result.current.selectedKey).toBe('a/b/c.txt')

    await act(async () => {
      await result.current.refreshDirectory('a')
    })
    expect(result.current.selectedKey).toBe('a/b/c.txt')
  })

  it('连续两次 refreshDirectory 后子树展开态仍保留（无 stale 闭包）', async () => {
    const { result } = await setupExpandedTree()

    await act(async () => {
      await result.current.refreshDirectory('a')
    })
    expect(findNode(result.current.treeData, 'a/b')?.expanded).toBe(true)

    await act(async () => {
      await result.current.refreshDirectory('a')
    })
    const b = findNode(result.current.treeData, 'a/b')
    expect(b?.expanded).toBe(true)
    expect(b?.children.some((c) => c.key === 'a/b/c.txt')).toBe(true)
  })
})

/** 用 pending Promise 控制 fileListDirectory 的 resolve 时机，用于验证并发读取 */
async function setupExpandedTreeWithPendingApi() {
  const calls: string[] = []
  const resolvers = new Map<string, (v: FileInfo[]) => void>()
  const fileListDirectory = vi.fn((relPath: string): Promise<FileInfo[]> => {
    calls.push(relPath)
    return new Promise<FileInfo[]>((resolve) => {
      resolvers.set(relPath, resolve)
    })
  })
  const api = (window as unknown as { api?: Record<string, unknown> }).api ?? {}
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    ...api,
    fileListDirectory,
    fileOnTreeChanged: vi.fn(() => () => {}),
    fileCreateFile: vi.fn(async () => {}),
    fileCreateDirectory: vi.fn(async () => {}),
    fileDelete: vi.fn(async () => {}),
    fileRename: vi.fn(async () => {}),
    fileMove: vi.fn(async () => {})
  }
  const hook = renderHook(() => useFileTree('/work', {}))
  const resolveDir = (relPath: string, files: FileInfo[]) => {
    resolvers.get(relPath)?.(files)
  }

  await waitFor(() => expect(calls).toContain(''))
  resolveDir('', [
    { name: 'a', path: 'a', isDirectory: true },
    { name: 'b', path: 'b', isDirectory: true }
  ])
  await waitFor(() => expect(hook.result.current.treeData[0].children.length).toBe(2))

  await act(async () => {
    void hook.result.current.toggleExpand('a')
  })
  await waitFor(() => expect(calls.filter((c) => c === 'a').length).toBeGreaterThanOrEqual(1))
  resolveDir('a', [{ name: 'a1.txt', path: 'a/a1.txt', isDirectory: false }])
  await waitFor(() => expect(findNode(hook.result.current.treeData, 'a/a1.txt')).toBeDefined())

  await act(async () => {
    void hook.result.current.toggleExpand('b')
  })
  await waitFor(() => expect(calls.filter((c) => c === 'b').length).toBeGreaterThanOrEqual(1))
  resolveDir('b', [{ name: 'b1.txt', path: 'b/b1.txt', isDirectory: false }])
  await waitFor(() => expect(findNode(hook.result.current.treeData, 'b/b1.txt')).toBeDefined())

  return { hook, calls, resolveDir }
}

describe('useFileTree - 批量合并刷新（P4）', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('refreshExpanded 多目录并发读取（批量合并）', async () => {
    const { hook, calls, resolveDir } = await setupExpandedTreeWithPendingApi()

    const callsBefore = calls.length
    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'refreshExpanded' })
      await new Promise((r) => setTimeout(r, 500))
    })
    // 串行实现卡在 root('') pending；先 resolve root 让其继续，暴露 a->b 串行
    resolveDir('', [
      { name: 'a', path: 'a', isDirectory: true },
      { name: 'b', path: 'b', isDirectory: true }
    ])
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    // 批量 Promise.all：a 与 b 在 resolve 前都被调用（并发）
    // 串行 for...of await：root 完成后仅 a 被调（等 a resolve 才调 b），不含 b
    const newCalls = calls.slice(callsBefore)
    expect(newCalls).toContain('a')
    expect(newCalls).toContain('b')

    await act(async () => {
      resolveDir('a', [
        { name: 'a1.txt', path: 'a/a1.txt', isDirectory: false },
        { name: 'a2.txt', path: 'a/a2.txt', isDirectory: false }
      ])
      resolveDir('b', [
        { name: 'b1.txt', path: 'b/b1.txt', isDirectory: false },
        { name: 'b2.txt', path: 'b/b2.txt', isDirectory: false }
      ])
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(findNode(hook.result.current.treeData, 'a/a2.txt')).toBeDefined()
    expect(findNode(hook.result.current.treeData, 'b/b2.txt')).toBeDefined()
  })

  it('paths 事件多目录并发读取（批量合并）', async () => {
    const { hook, calls, resolveDir } = await setupExpandedTreeWithPendingApi()
    const callsBefore = calls.length
    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'paths', relPaths: ['a/a2.txt', 'b/b2.txt'] })
      await new Promise((r) => setTimeout(r, 500))
    })

    // paths 事件 dirs=['a','b']（不含 root）；串行卡在 a pending，b 未调
    const newCalls = calls.slice(callsBefore)
    expect(newCalls).toContain('a')
    expect(newCalls).toContain('b')

    await act(async () => {
      resolveDir('a', [
        { name: 'a1.txt', path: 'a/a1.txt', isDirectory: false },
        { name: 'a2.txt', path: 'a/a2.txt', isDirectory: false }
      ])
      resolveDir('b', [
        { name: 'b1.txt', path: 'b/b1.txt', isDirectory: false },
        { name: 'b2.txt', path: 'b/b2.txt', isDirectory: false }
      ])
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(findNode(hook.result.current.treeData, 'a/a2.txt')).toBeDefined()
    expect(findNode(hook.result.current.treeData, 'b/b2.txt')).toBeDefined()
  })

  it('无变化的批量刷新不产生新 treeData 引用（短路，§7.4）', async () => {
    const listDir = async (relPath: string): Promise<FileInfo[]> => {
      if (relPath === '') return [{ name: 'a', path: 'a', isDirectory: true }]
      if (relPath === 'a') return [{ name: 'a1.txt', path: 'a/a1.txt', isDirectory: false }]
      return []
    }
    mockFileApi((p) => listDir(p))
    const { result } = renderHook(() => useFileTree('/work', {}))
    await waitFor(() =>
      expect(result.current.treeData[0].children.some((c) => c.key === 'a')).toBe(true)
    )
    await act(async () => {
      await result.current.toggleExpand('a')
    })
    await waitFor(() => expect(findNode(result.current.treeData, 'a/a1.txt')).toBeDefined())

    const refBefore = result.current.treeData
    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'refreshExpanded' })
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(result.current.treeData).toBe(refBefore)
  })
})

describe('useFileTree - refreshTree 保留展开态（P2）', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('refreshTree 保留 expandedKeys（不重置为仅 root）', async () => {
    const { result } = await setupExpandedTree()
    expect(result.current.expandedKeys).toContain('a')
    expect(result.current.expandedKeys).toContain('a/b')
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(result.current.expandedKeys).toContain('a')
    expect(result.current.expandedKeys).toContain('a/b')
  })

  it('refreshTree 保留 selectedKey 与已加载子树', async () => {
    const { result } = await setupExpandedTree()
    await act(async () => {
      result.current.setSelectedKey('a/b/c.txt')
    })
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(result.current.selectedKey).toBe('a/b/c.txt')
    const b = findNode(result.current.treeData, 'a/b')
    expect(b?.expanded).toBe(true)
    expect(b?.children.some((c) => c.key === 'a/b/c.txt')).toBe(true)
  })

  it('refreshTree 刷新所有已展开目录（整树刷新，子目录新文件出现）', async () => {
    let aCall = 0
    const listDir = async (relPath: string): Promise<FileInfo[]> => {
      if (relPath === '') return [{ name: 'a', path: 'a', isDirectory: true }]
      if (relPath === 'a') {
        aCall++
        return aCall >= 2
          ? [
              { name: 'a1.txt', path: 'a/a1.txt', isDirectory: false },
              { name: 'a2.txt', path: 'a/a2.txt', isDirectory: false }
            ]
          : [{ name: 'a1.txt', path: 'a/a1.txt', isDirectory: false }]
      }
      return []
    }
    mockFileApi((p) => listDir(p))
    const { result } = renderHook(() => useFileTree('/work', {}))
    await waitFor(() => expect(findNode(result.current.treeData, 'a')).toBeDefined())
    await act(async () => {
      await result.current.toggleExpand('a')
    })
    expect(findNode(result.current.treeData, 'a/a1.txt')).toBeDefined()
    expect(findNode(result.current.treeData, 'a/a2.txt')).toBeUndefined()

    await act(async () => {
      await result.current.refreshTree()
    })

    expect(result.current.expandedKeys).toContain('a')
    expect(findNode(result.current.treeData, 'a/a2.txt')).toBeDefined()
    expect(findNode(result.current.treeData, 'a/a1.txt')).toBeDefined()
  })
})

describe('useFileTree - 滚动位置保持前提（P5/C2）', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('自动刷新后根节点 key 与节点 key 集合稳定（不 remount 前提）', async () => {
    const { result } = await setupExpandedTree()
    const rootKeyBefore = result.current.treeData[0].key

    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'refreshExpanded' })
      await new Promise((r) => setTimeout(r, 500))
    })

    expect(result.current.treeData[0].key).toBe(rootKeyBefore)
    expect(findNode(result.current.treeData, 'a')?.key).toBe('a')
    expect(findNode(result.current.treeData, 'a/b')?.key).toBe('a/b')
    expect(findNode(result.current.treeData, 'a/b/c.txt')?.key).toBe('a/b/c.txt')
  })
})

describe('useFileTree - 内联编辑期间推迟刷新（§11.5）', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('inlineInput 非空时推迟自动刷新 setTreeData', async () => {
    let aCall = 0
    const listDir = async (relPath: string): Promise<FileInfo[]> => {
      if (relPath === '') return [{ name: 'a', path: 'a', isDirectory: true }]
      if (relPath === 'a') {
        aCall++
        return aCall >= 2
          ? [
              { name: 'a1.txt', path: 'a/a1.txt', isDirectory: false },
              { name: 'a2.txt', path: 'a/a2.txt', isDirectory: false }
            ]
          : [{ name: 'a1.txt', path: 'a/a1.txt', isDirectory: false }]
      }
      return []
    }
    mockFileApi((p) => listDir(p))
    const { result } = renderHook(() => useFileTree('/work', {}))
    await waitFor(() =>
      expect(result.current.treeData[0].children.some((c) => c.key === 'a')).toBe(true)
    )
    await act(async () => {
      await result.current.toggleExpand('a')
    })

    await act(async () => {
      result.current.setInlineInput({ parentKey: 'a', type: 'file', defaultName: '' })
    })
    const refBefore = result.current.treeData

    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'paths', relPaths: ['a/a2.txt'] })
      await new Promise((r) => setTimeout(r, 500))
    })

    // inlineInput 非空：推迟 setTreeData，treeData 引用不变，a2 未出现
    expect(result.current.treeData).toBe(refBefore)
    expect(findNode(result.current.treeData, 'a/a2.txt')).toBeUndefined()

    // 清除 inlineInput 后，下一次事件正常刷新
    await act(async () => {
      result.current.setInlineInput(null)
    })
    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'paths', relPaths: ['a/a2.txt'] })
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(findNode(result.current.treeData, 'a/a2.txt')).toBeDefined()
  })
})

describe('useFileTree - 端到端自动刷新（§12.1）', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('多层展开后 paths 事件刷新保留展开态并出现新文件', async () => {
    let cCall = 0
    const listDir = async (relPath: string): Promise<FileInfo[]> => {
      if (relPath === '') return [{ name: 'a', path: 'a', isDirectory: true }]
      if (relPath === 'a') return [{ name: 'b', path: 'a/b', isDirectory: true }]
      if (relPath === 'a/b') return [{ name: 'c', path: 'a/b/c', isDirectory: true }]
      if (relPath === 'a/b/c') {
        cCall++
        return cCall >= 2
          ? [
              { name: 'old.txt', path: 'a/b/c/old.txt', isDirectory: false },
              { name: 'new.txt', path: 'a/b/c/new.txt', isDirectory: false }
            ]
          : [{ name: 'old.txt', path: 'a/b/c/old.txt', isDirectory: false }]
      }
      return []
    }
    mockFileApi((p) => listDir(p))
    const { result } = renderHook(() => useFileTree('/work', {}))
    await waitFor(() => expect(findNode(result.current.treeData, 'a')).toBeDefined())
    await act(async () => {
      await result.current.toggleExpand('a')
    })
    await act(async () => {
      await result.current.toggleExpand('a/b')
    })
    await act(async () => {
      await result.current.toggleExpand('a/b/c')
    })
    expect(result.current.expandedKeys).toContain('a/b/c')

    await act(async () => {
      emitFileTreeSyncForTests({ kind: 'paths', relPaths: ['a/b/c/new.txt'] })
      await new Promise((r) => setTimeout(r, 500))
    })

    expect(result.current.expandedKeys).toContain('a')
    expect(result.current.expandedKeys).toContain('a/b')
    expect(result.current.expandedKeys).toContain('a/b/c')
    expect(findNode(result.current.treeData, 'a/b/c/new.txt')).toBeDefined()
    expect(findNode(result.current.treeData, 'a/b/c/old.txt')).toBeDefined()
  })
})

describe('useFileTree - 手动操作回归（§12.6）', () => {
  beforeEach(() => {
    resetFileTreeSyncBusForTests()
  })

  it('createFile 后父目录展开态与已加载子树保留', async () => {
    let aCall = 0
    const listDir = async (relPath: string): Promise<FileInfo[]> => {
      if (relPath === '') return [{ name: 'a', path: 'a', isDirectory: true }]
      if (relPath === 'a') {
        aCall++
        return aCall >= 2
          ? [
              { name: 'a1.txt', path: 'a/a1.txt', isDirectory: false },
              { name: 'new.txt', path: 'a/new.txt', isDirectory: false }
            ]
          : [{ name: 'a1.txt', path: 'a/a1.txt', isDirectory: false }]
      }
      return []
    }
    mockFileApi((p) => listDir(p))
    const { result } = renderHook(() => useFileTree('/work', {}))
    await waitFor(() => expect(findNode(result.current.treeData, 'a')).toBeDefined())
    await act(async () => {
      await result.current.toggleExpand('a')
    })
    expect(result.current.expandedKeys).toContain('a')

    await act(async () => {
      await result.current.createFile('a', 'new.txt')
    })

    expect(result.current.expandedKeys).toContain('a')
    expect(findNode(result.current.treeData, 'a/new.txt')).toBeDefined()
    expect(findNode(result.current.treeData, 'a/a1.txt')).toBeDefined()
  })
})
