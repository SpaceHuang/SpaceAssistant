import { describe, expect, it } from 'vitest'
import {
  canGoBack,
  canGoForward,
  createUrlHistory,
  currentHistoryUrl,
  navigateBack,
  navigateForward,
  pushUrlHistory,
  MAX_URL_HISTORY
} from './webViewHistory'

describe('webViewHistory', () => {
  it('creates empty history', () => {
    expect(createUrlHistory()).toEqual({ history: [], index: -1 })
  })

  it('pushes urls and dedupes current', () => {
    let state = createUrlHistory('https://a.com/')
    state = pushUrlHistory(state, 'https://b.com/')
    expect(currentHistoryUrl(state)).toBe('https://b.com/')
    state = pushUrlHistory(state, 'https://b.com/')
    expect(state.history).toEqual(['https://a.com/', 'https://b.com/'])
  })

  it('navigates back and forward', () => {
    let state = pushUrlHistory(createUrlHistory('https://a.com/'), 'https://b.com/')
    expect(canGoBack(state)).toBe(true)
    const back = navigateBack(state)
    expect(back && currentHistoryUrl(back)).toBe('https://a.com/')
    const forward = back ? navigateForward(back) : null
    expect(forward && currentHistoryUrl(forward)).toBe('https://b.com/')
  })

  it('caps history length', () => {
    let state = createUrlHistory('https://0.example/')
    for (let i = 1; i <= MAX_URL_HISTORY + 5; i += 1) {
      state = pushUrlHistory(state, `https://${i}.example/`)
    }
    expect(state.history.length).toBe(MAX_URL_HISTORY)
  })
})
