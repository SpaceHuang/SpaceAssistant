import { vi } from 'vitest'

const loadState = vi.hoisted(() => ({ loaded: false }))

vi.mock('../markdownExport', () => {
  loadState.loaded = true
  return {}
})

describe('file IPC markdown export loading', () => {
  it('does not load document conversion libraries while registering file IPC', async () => {
    vi.resetModules()
    loadState.loaded = false

    await import('./fileIpc')

    expect(loadState.loaded).toBe(false)
  })
})
