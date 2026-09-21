import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyFileTreeChanged } from './fileTreeSyncNotify'
import { peekFileScopeVersion, resetFileScopeVersionForTests } from './fileScopeVersion'

const mockSend = vi.fn()

vi.mock('./windowRef', () => ({
  getMainWindow: () => ({ webContents: { send: mockSend } })
}))

describe('fileTreeSyncNotify(偏差 8/11:文件树失效经统一出口)', () => {
  beforeEach(() => {
    mockSend.mockClear()
    resetFileScopeVersionForTests(0)
  })
  afterEach(() => {
    resetFileScopeVersionForTests(0)
  })

  it('广播 scope:invalidated { file-tree, version, hint },sender 被忽略(不直连 webContents)', () => {
    notifyFileTreeChanged(null, { kind: 'paths', relPaths: ['a.md'] })
    expect(mockSend).toHaveBeenCalledTimes(1)
    const [channel, payload] = mockSend.mock.calls[0]!
    expect(channel).toBe('scope:invalidated')
    expect(payload).toEqual({ scope: 'file-tree', version: 1, hint: { paths: ['a.md'] } })
  })

  it('版本单调递增:丢通知后下一条版本必更高(渲染端版本比较必重取)', () => {
    notifyFileTreeChanged(null, { kind: 'refreshExpanded' })
    notifyFileTreeChanged(null, { kind: 'paths', relPaths: ['x', 'y'] })
    const versions = mockSend.mock.calls.map((c) => (c[1] as { version: number }).version)
    expect(versions[0]).toBe(1)
    expect(versions[1]).toBe(2)
    expect(peekFileScopeVersion()).toBe(2)
  })

  it('载荷不含真相(无树内容/文件内容字段)', () => {
    notifyFileTreeChanged(null, { kind: 'paths', relPaths: ['docs/note.md'] })
    const payload = mockSend.mock.calls[0]![1] as Record<string, unknown>
    const forbidden = ['entries', 'nodes', 'content', 'tree', 'files', 'items']
    for (const key of forbidden) {
      expect(payload).not.toHaveProperty(key)
    }
    expect(JSON.stringify(payload)).not.toContain('note.md 的内容')
  })
})
