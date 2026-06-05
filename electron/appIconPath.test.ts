import path from 'path'
import { describe, expect, it } from 'vitest'
import { getAppIconFileName, getAppIconTheme, resolveAppIconPath } from './appIconPath'

describe('getAppIconTheme', () => {
  it('maps native theme flag to icon theme', () => {
    expect(getAppIconTheme(false)).toBe('light')
    expect(getAppIconTheme(true)).toBe('dark')
  })
})

describe('getAppIconFileName', () => {
  it('returns light 256 PNG for light theme on all platforms', () => {
    expect(getAppIconFileName('win32', 'light')).toBe('sa-logo-256.png')
    expect(getAppIconFileName('darwin', 'light')).toBe('sa-logo-256.png')
    expect(getAppIconFileName('linux', 'light')).toBe('sa-logo-256.png')
  })

  it('returns dark 256 PNG for dark theme on all platforms', () => {
    expect(getAppIconFileName('win32', 'dark')).toBe('dark/sa-logo-dark-256.png')
    expect(getAppIconFileName('darwin', 'dark')).toBe('dark/sa-logo-dark-256.png')
    expect(getAppIconFileName('linux', 'dark')).toBe('dark/sa-logo-dark-256.png')
  })
})

describe('resolveAppIconPath', () => {
  const mainDir = '/app/dist-electron/electron'

  it('resolves dev light icon path', () => {
    const result = resolveAppIconPath('win32', false, mainDir, 'light')
    expect(result).toBe(path.join(mainDir, '..', '..', 'res', 'icons', 'sa-logo-256.png'))
  })

  it('resolves dev dark icon path', () => {
    const result = resolveAppIconPath('win32', false, mainDir, 'dark')
    expect(result).toBe(path.join(mainDir, '..', '..', 'res', 'icons', 'dark', 'sa-logo-dark-256.png'))
  })

  it('resolves packaged path from resourcesPath', () => {
    const resourcesPath = '/app/resources/icons'
    expect(resolveAppIconPath('win32', true, mainDir, 'light', resourcesPath)).toBe(
      path.join(resourcesPath, 'sa-logo-256.png')
    )
    expect(resolveAppIconPath('darwin', true, mainDir, 'dark', resourcesPath)).toBe(
      path.join(resourcesPath, 'dark', 'sa-logo-dark-256.png')
    )
  })
})
