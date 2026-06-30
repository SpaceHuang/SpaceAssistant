import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileTree } from './useFileTree'

describe('useFileTree workDir change', () => {
  let originalApi: unknown

  beforeEach(() => {
    originalApi = (window as Record<string, unknown>).api
    ;(window as Record<string, unknown>).api = {
      fileListDirectory: vi.fn(async (dir: string) => {
        if (dir === '') {
          return [{ name: 'root.txt', path: 'root.txt', isDirectory: false, size: 1 }]
        }
        return []
      }),
      fileOnTreeChanged: vi.fn(() => () => {})
    }
  })

  afterEach(() => {
    ;(window as Record<string, unknown>).api = originalApi
    vi.clearAllMocks()
  })

  it('reloads root children when workDir changes without preserving stale children', async () => {
    const { result, rerender } = renderHook(
      ({ workDir }: { workDir: string }) => useFileTree(workDir),
      { initialProps: { workDir: '/work/a' } }
    )

    await waitFor(() => {
      expect(result.current.treeData[0]?.children.some((c) => c.name === 'root.txt')).toBe(true)
    })

    await act(async () => {
      await result.current.toggleExpand('')
    })

    rerender({ workDir: '/work/b' })

    await waitFor(() => {
      expect(result.current.expandedKeys).toEqual([''])
      expect(result.current.selectedKey).toBeNull()
      expect(result.current.treeData[0]?.children.some((c) => c.name === 'root.txt')).toBe(true)
    })
  })
})
