import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { store } from '../store'
import { setSession, restoreLastUsage } from '../store/chatSlice'
import { applyContextUsageUpdate, initContextUsageStreamBridge } from './contextUsageStreamService'

describe('contextUsageStreamService', () => {
  let usageHandler: ((d: { requestId: string; sessionId: string; usage: { input_tokens: number } }) => void) | undefined
  const usageSet = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    usageHandler = undefined
    store.dispatch(restoreLastUsage(null))
    store.dispatch(setSession('sess-bridge-1'))
    vi.stubGlobal('window', {
      api: {
        usageSet,
        claudeChatOnUsage: vi.fn((cb: typeof usageHandler) => {
          usageHandler = cb
          return vi.fn()
        })
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('applyContextUsageUpdate persists and updates Redux for current session', () => {
    applyContextUsageUpdate('sess-bridge-1', { input_tokens: 5000, output_tokens: 100 })
    expect(usageSet).toHaveBeenCalledWith({
      sessionId: 'sess-bridge-1',
      usage: { input_tokens: 5000, output_tokens: 100 }
    })
    expect(store.getState().chat.lastUsage).toEqual({ input_tokens: 5000, output_tokens: 100 })
  })

  it('applyContextUsageUpdate persists but skips Redux when session differs', () => {
    store.dispatch(setSession('sess-other'))
    applyContextUsageUpdate('sess-bridge-1', { input_tokens: 3000 })
    expect(usageSet).toHaveBeenCalled()
    expect(store.getState().chat.lastUsage).toBeNull()
  })

  it('initContextUsageStreamBridge forwards claude-chat-usage to applyContextUsageUpdate', () => {
    initContextUsageStreamBridge()
    expect(usageHandler).toBeTypeOf('function')
    usageHandler!({
      requestId: 'req-1',
      sessionId: 'sess-bridge-1',
      usage: { input_tokens: 9000, output_tokens: 500 }
    })
    expect(usageSet).toHaveBeenCalledWith({
      sessionId: 'sess-bridge-1',
      usage: { input_tokens: 9000, output_tokens: 500 }
    })
    expect(store.getState().chat.lastUsage).toEqual({ input_tokens: 9000, output_tokens: 500 })
  })

  it('projected usage updates Redux but skips persistence', () => {
    applyContextUsageUpdate('sess-bridge-1', { input_tokens: 8000, output_tokens: 200 }, { projected: true })
    expect(usageSet).not.toHaveBeenCalled()
    expect(store.getState().chat.lastUsage).toEqual({ input_tokens: 8000, output_tokens: 200 })
  })

  it('initContextUsageStreamBridge passes projected flag through', () => {
    initContextUsageStreamBridge()
    usageHandler!({
      requestId: 'req-2',
      sessionId: 'sess-bridge-1',
      usage: { input_tokens: 7000 },
      projected: true
    })
    expect(usageSet).not.toHaveBeenCalled()
    expect(store.getState().chat.lastUsage).toEqual({ input_tokens: 7000 })
  })
})
