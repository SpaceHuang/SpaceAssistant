import { describe, expect, it, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import browserDetectReducer, { fetchBrowserDetect, setBrowserDetectResult } from './browserDetectSlice'
import type { BrowserDetectResult } from '../../shared/browserTypes'

const detectReady: BrowserDetectResult = {
  stagehand: { installed: true, version: '3.0.0' },
  playwright: { installed: true, browsers: ['chromium'] },
  chromium: { ready: true },
  node: { version: 'v22.0.0', meetsRequirement: true },
  canInitialize: true,
  primaryFailure: 'ok',
  errors: [],
  recommendedCwd: 'E:\\Develop\\SpaceAssistant',
  installContext: 'development'
}

describe('browserDetectSlice', () => {
  beforeEach(() => {
    window.api = {
      ...window.api,
      browserDetect: vi.fn().mockResolvedValue(detectReady)
    } as typeof window.api
  })

  it('fetchBrowserDetect stores API result', async () => {
    const store = configureStore({ reducer: { browserDetect: browserDetectReducer } })
    await store.dispatch(fetchBrowserDetect(true))
    expect(store.getState().browserDetect.result).toEqual(detectReady)
    expect(window.api.browserDetect).toHaveBeenCalledWith(true)
  })

  it('reuses client cache within TTL when force is false', async () => {
    const store = configureStore({ reducer: { browserDetect: browserDetectReducer } })
    store.dispatch(setBrowserDetectResult(detectReady))
    await store.dispatch(fetchBrowserDetect(false))
    expect(window.api.browserDetect).not.toHaveBeenCalled()
  })
})
