import { describe, expect, it, vi } from 'vitest'
import { isAllowedExternalUrl, openExternalLink } from './externalLink'

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined)
  }
}))

describe('externalLink', () => {
  it('allows http and https urls only', () => {
    expect(isAllowedExternalUrl('https://github.com/SpaceHuang/SpaceAssistant')).toBe(true)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('not-a-url')).toBe(false)
  })

  it('opens allowed urls via shell.openExternal', async () => {
    const { shell } = await import('electron')
    await openExternalLink('https://example.com')
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })
})
