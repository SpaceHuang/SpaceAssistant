import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInvalidationServiceForTest, startInvalidationService, registerMessagesReloadHandler } from './invalidationService'

vi.mock('./fileTreeSyncBus', () => ({ applyFileTreeInvalidation: vi.fn() }))
vi.mock('./fileContentSyncBus', () => ({ applyFileContentInvalidation: vi.fn() }))
import { store } from '../store'
import { setSessions } from '../store/sessionSlice'
import type { Session } from '../../shared/domainTypes'

function makeSession(id: string): Session {
  return {
    id,
    name: id,
    model: 'm',
    temperature: 0.7,
    maxTokens: 1024,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    skillsState: { manualActivated: [], manualDisabled: [] },
    metadata: {},
    schemaVersion: 1
  }
}

function emit(payload: { scope: string; version: number }) {
  ;(window.api.onScopeInvalidated as unknown as { __emit: (p: { scope: string; version: number }) => void }).__emit(payload)
}

const flushAsync = () => new Promise((r) => setTimeout(r, 220))

describe('invalidationService(通知驱动重取,偏差 11)', () => {
  let stop: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    const listeners: Array<(p: { scope: string; version: number }) => void> = []
    ;(window.api as unknown as Record<string, unknown>).onScopeInvalidated = (cb: (p: { scope: string; version: number }) => void) => {
      listeners.push(cb)
      ;(window.api.onScopeInvalidated as unknown as { __emit: (p: { scope: string; version: number }) => void }).__emit = (p) => {
        for (const l of listeners) l(p)
      }
      return () => undefined
    }
    window.api.sessionList = vi.fn().mockResolvedValue([makeSession('s1'), makeSession('s2')])
    store.dispatch(setSessions([]))
    resetInvalidationServiceForTest()
    stop = startInvalidationService()
  })

  afterEach(() => {
    stop?.()
    resetInvalidationServiceForTest()
  })

  it('更高版本的 session-list 失效触发一次重取(防抖合并多条通知)', async () => {
    emit({ scope: 'session-list', version: 1 })
    emit({ scope: 'session-list', version: 2 })
    emit({ scope: 'session:s1:messages', version: 1 })
    await flushAsync()
    expect(window.api.sessionList).toHaveBeenCalledTimes(1)
    expect(store.getState().session.list.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('同版本或更低版本通知被忽略(版本比较幂等)', async () => {
    emit({ scope: 'session-list', version: 3 })
    await flushAsync()
    expect(window.api.sessionList).toHaveBeenCalledTimes(1)
    emit({ scope: 'session-list', version: 3 })
    emit({ scope: 'session-list', version: 2 })
    await flushAsync()
    expect(window.api.sessionList).toHaveBeenCalledTimes(1)
    emit({ scope: 'session-list', version: 4 })
    await flushAsync()
    expect(window.api.sessionList).toHaveBeenCalledTimes(2)
  })

  it('session:<id>:messages 失效转发给注册的重载 handler', async () => {
    const handler = vi.fn()
    registerMessagesReloadHandler(handler)
    emit({ scope: 'session:s9:messages', version: 1 })
    await flushAsync()
    expect(handler).toHaveBeenCalledWith('s9')
    registerMessagesReloadHandler(null)
    emit({ scope: 'session:s9:messages', version: 2 })
    await flushAsync()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('文件域失效转发到对应 bus(树:hint;内容:path)', async () => {
    const { applyFileTreeInvalidation } = await import('./fileTreeSyncBus')
    const { applyFileContentInvalidation } = await import('./fileContentSyncBus')
    const treeFn = vi.mocked(applyFileTreeInvalidation)
    const contentFn = vi.mocked(applyFileContentInvalidation)
    emit({ scope: 'file-tree', version: 1, hint: { paths: ['docs/note.md'] } })
    emit({ scope: 'file:docs/other.md', version: 1 })
    await flushAsync()
    expect(treeFn).toHaveBeenCalledWith({ kind: 'paths', relPaths: ['docs/note.md'] })
    expect(contentFn).toHaveBeenCalledWith('docs/other.md')
    emit({ scope: 'file-tree', version: 2, hint: { refreshExpanded: true } })
    await flushAsync()
    expect(treeFn).toHaveBeenLastCalledWith({ kind: 'refreshExpanded' })
  })

  it('v2-B5:同窗多条 file-tree 通知 hint 合并(paths 并集),不再整体覆盖', async () => {
    const { applyFileTreeInvalidation } = await import('./fileTreeSyncBus')
    const treeFn = vi.mocked(applyFileTreeInvalidation)
    treeFn.mockClear()
    emit({ scope: 'file-tree', version: 10, hint: { paths: ['a.md'] } })
    emit({ scope: 'file-tree', version: 11, hint: { paths: ['b.md'] } })
    await flushAsync()
    // 一次 flush,paths 并集(旧实现只保留最后一份 → a.md 目录永不刷新)
    expect(treeFn).toHaveBeenCalledTimes(1)
    expect(treeFn).toHaveBeenCalledWith({ kind: 'paths', relPaths: ['a.md', 'b.md'] })
    // refreshExpanded 粘性:混合场景升级为全量刷新
    emit({ scope: 'file-tree', version: 12, hint: { paths: ['c.md'] } })
    emit({ scope: 'file-tree', version: 13, hint: { refreshExpanded: true } })
    await flushAsync()
    expect(treeFn).toHaveBeenLastCalledWith({ kind: 'refreshExpanded' })
  })

  it('不相关 scope 不触发重取', async () => {
    emit({ scope: 'unknown-scope', version: 5 })
    await flushAsync()
    expect(window.api.sessionList).not.toHaveBeenCalled()
  })
})
