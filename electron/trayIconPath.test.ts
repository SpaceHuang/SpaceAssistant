import path from 'path'
import { describe, expect, it } from 'vitest'
import { getTrayIconBaseName, getTrayIconFileName, resolveTrayIconPath } from './trayIconPath'

describe('getTrayIconBaseName', () => {
  it('returns tray for light theme and tray-dark for dark theme', () => {
    expect(getTrayIconBaseName('light')).toBe('tray')
    expect(getTrayIconBaseName('dark')).toBe('tray-dark')
  })
})

describe('getTrayIconFileName', () => {
  it('returns tray.ico on win32', () => {
    expect(getTrayIconFileName('win32', 'light')).toBe('tray.ico')
    expect(getTrayIconFileName('win32', 'dark')).toBe('tray-dark.ico')
  })

  it('returns tray.png on darwin and linux', () => {
    expect(getTrayIconFileName('darwin', 'light')).toBe('tray.png')
    expect(getTrayIconFileName('darwin', 'dark')).toBe('tray-dark.png')
    expect(getTrayIconFileName('linux', 'light')).toBe('tray.png')
    expect(getTrayIconFileName('linux', 'dark')).toBe('tray-dark.png')
  })

  it('returns null on unsupported platforms', () => {
    expect(getTrayIconFileName('freebsd' as NodeJS.Platform, 'light')).toBeNull()
  })
})

describe('resolveTrayIconPath', () => {
  const mainDir = '/app/dist-electron/electron'

  it('resolves dev light tray path on win32', () => {
    const result = resolveTrayIconPath('win32', false, mainDir, 'light')
    expect(result).toBe(path.join(mainDir, '..', '..', 'resources', 'tray', 'tray.ico'))
  })

  it('resolves dev dark tray path on linux', () => {
    const result = resolveTrayIconPath('linux', false, mainDir, 'dark')
    expect(result).toBe(path.join(mainDir, '..', '..', 'resources', 'tray', 'tray-dark.png'))
  })

  it('resolves packaged path from resourcesPath', () => {
    const resourcesPath = '/app/resources/tray'
    expect(resolveTrayIconPath('win32', true, mainDir, 'light', resourcesPath)).toBe(
      path.join(resourcesPath, 'tray.ico')
    )
    expect(resolveTrayIconPath('darwin', true, mainDir, 'dark', resourcesPath)).toBe(
      path.join(resourcesPath, 'tray-dark.png')
    )
  })
})
