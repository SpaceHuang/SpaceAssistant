import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInvalidationServiceForTest, startInvalidationService, registerMessagesReloadHandler } from './invalidationService'
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

  it('不相关 scope 不触发重取', async () => {
    emit({ scope: 'unknown-scope', version: 5 })
    await flushAsync()
    expect(window.api.sessionList).not.toHaveBeenCalled()
  })
})
