import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { openExternalUrl } from './openExternalUrl'
import { APP_GITHUB_URL } from '../../shared/appMeta'

describe('openExternalUrl', () => {
  const originalOpen = window.open

  beforeEach(() => {
    window.api = {
      ...window.api,
      appOpenExternal: vi.fn().mockResolvedValue({ ok: true })
    }
  })

  afterEach(() => {
    window.open = originalOpen
  })

  it('uses appOpenExternal when available', async () => {
    const result = await openExternalUrl(APP_GITHUB_URL)
    expect(result.ok).toBe(true)
    expect(window.api.appOpenExternal).toHaveBeenCalledWith(APP_GITHUB_URL)
  })

  it('falls back to window.open when appOpenExternal is missing', async () => {
    window.api = { ...window.api, appOpenExternal: undefined as never }
    const openSpy = vi.fn()
    window.open = openSpy

    const result = await openExternalUrl(APP_GITHUB_URL)

    expect(result.ok).toBe(true)
    expect(openSpy).toHaveBeenCalledWith(APP_GITHUB_URL, '_blank', 'noopener,noreferrer')
  })
})
