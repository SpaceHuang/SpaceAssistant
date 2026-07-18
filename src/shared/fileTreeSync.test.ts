import { describe, expect, it } from 'vitest'
import {
  dirsToRefreshForPath,
  isPathUnderRoot,
  mergeRefreshedChildren,
  parentDirKey
} from './fileTreeSync'

describe('fileTreeSync', () => {
  it('parentDirKey returns immediate parent', () => {
    expect(parentDirKey('src/app.ts')).toBe('src')
    expect(parentDirKey('README.md')).toBe('')
  })

  it('isPathUnderRoot respects wiki root', () => {
    expect(isPathUnderRoot('llm-wiki/a.md', 'llm-wiki')).toBe(true)
    expect(isPathUnderRoot('src/a.ts', 'llm-wiki')).toBe(false)
  })

  it('dirsToRefreshForPath refreshes expanded parent', () => {
    const expanded = new Set(['src'])
    expect(dirsToRefreshForPath('src/app.ts', '', expanded)).toEqual(['src'])
  })

  it('dirsToRefreshForPath walks up to expanded ancestor for new nested paths', () => {
    const expanded = new Set([''])
    expect(dirsToRefreshForPath('newdir/file.txt', '', expanded)).toEqual([''])
  })

  it('dirsToRefreshForPath skips collapsed branches', () => {
    const expanded = new Set(['src'])
    expect(dirsToRefreshForPath('src/deep/hidden.ts', '', expanded)).toEqual(['src'])
  })

  it('dirsToRefreshForPath returns empty when no ancestor expanded', () => {
    const expanded = new Set<string>()
    expect(dirsToRefreshForPath('src/app.ts', '', expanded)).toEqual([])
  })
})

// ---- mergeRefreshedChildren（§5.2 合并函数 + §7.4 无变化短路）----
type TestNode = {
  key: string
  name: string
  isDirectory: boolean
  expanded: boolean
  loading: boolean
  children: TestNode[]
  size?: number
}

function makeNode(
  over: Partial<TestNode> & Pick<TestNode, 'key' | 'name' | 'isDirectory'>
): TestNode {
  return { expanded: false, loading: false, children: [], ...over }
}

describe('mergeRefreshedChildren', () => {
  it('preserves expanded state and loaded children of nested expanded subdirectory', () => {
    const prev = [
      makeNode({
        key: 'a/b',
        name: 'b',
        isDirectory: true,
        expanded: true,
        children: [makeNode({ key: 'a/b/c', name: 'c', isDirectory: true })]
      })
    ]
    const next = [makeNode({ key: 'a/b', name: 'b', isDirectory: true })]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged[0].expanded).toBe(true)
    expect(merged[0].children).toHaveLength(1)
    expect(merged[0].children[0].key).toBe('a/b/c')
  })

  it('uses next value for newly added node (collapsed by default)', () => {
    const prev: TestNode[] = []
    const next = [makeNode({ key: 'a/new.ts', name: 'new.ts', isDirectory: false })]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged).toHaveLength(1)
    expect(merged[0].key).toBe('a/new.ts')
    expect(merged[0].expanded).toBe(false)
  })

  it('removes deleted nodes', () => {
    const prev = [
      makeNode({ key: 'a/keep', name: 'keep', isDirectory: false }),
      makeNode({ key: 'a/gone', name: 'gone', isDirectory: false })
    ]
    const next = [makeNode({ key: 'a/keep', name: 'keep', isDirectory: false })]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged).toHaveLength(1)
    expect(merged[0].key).toBe('a/keep')
  })

  it('treats renamed node as new (collapsed, old subtree dropped)', () => {
    const prev = [
      makeNode({
        key: 'a/old',
        name: 'old',
        isDirectory: true,
        expanded: true,
        children: [makeNode({ key: 'a/old/x', name: 'x', isDirectory: false })]
      })
    ]
    const next = [makeNode({ key: 'a/new', name: 'new', isDirectory: true })]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged[0].key).toBe('a/new')
    expect(merged[0].expanded).toBe(false)
    expect(merged[0].children).toHaveLength(0)
  })

  it('returns previous reference when no changes (same key/name/isDirectory, non-empty subtree)', () => {
    const prev = [
      makeNode({
        key: 'a/b',
        name: 'b',
        isDirectory: true,
        expanded: true,
        children: [makeNode({ key: 'a/b/c', name: 'c', isDirectory: false })]
      })
    ]
    const next = [makeNode({ key: 'a/b', name: 'b', isDirectory: true })]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged).toBe(prev)
  })

  it('takes next.children when previous subtree was empty (backfill, no short-circuit)', () => {
    const prev = [makeNode({ key: 'a/b', name: 'b', isDirectory: true, expanded: true, children: [] })]
    const next = [
      makeNode({
        key: 'a/b',
        name: 'b',
        isDirectory: true,
        children: [makeNode({ key: 'a/b/c', name: 'c', isDirectory: false })]
      })
    ]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged[0].children).toHaveLength(1)
    expect(merged[0].children[0].key).toBe('a/b/c')
  })

  it('uses next value for file nodes (metadata update)', () => {
    const prev = [makeNode({ key: 'a/f.txt', name: 'f.txt', isDirectory: false, size: 10 })]
    const next = [makeNode({ key: 'a/f.txt', name: 'f.txt', isDirectory: false, size: 20 })]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged[0].size).toBe(20)
  })

  it('does not short-circuit when length differs', () => {
    const prev = [makeNode({ key: 'a/b', name: 'b', isDirectory: true, expanded: true, children: [makeNode({ key: 'a/b/c', name: 'c', isDirectory: false })] })]
    const next = [
      makeNode({ key: 'a/b', name: 'b', isDirectory: true }),
      makeNode({ key: 'a/d', name: 'd', isDirectory: false })
    ]
    const merged = mergeRefreshedChildren(prev, next)
    expect(merged).not.toBe(prev)
    expect(merged).toHaveLength(2)
  })
})
