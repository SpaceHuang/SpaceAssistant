import { describe, expect, it } from 'vitest'
import path from 'path'
import { getTrayIconFileName, resolveTrayIconPath } from './trayIconPath'

describe('getTrayIconFileName', () => {
  it('returns tray.ico on win32', () => {
    expect(getTrayIconFileName('win32')).toBe('tray.ico')
  })

  it('returns tray.png on darwin and linux', () => {
    expect(getTrayIconFileName('darwin')).toBe('tray.png')
    expect(getTrayIconFileName('linux')).toBe('tray.png')
  })

  it('returns null for unknown platforms', () => {
    expect(getTrayIconFileName('freebsd' as NodeJS.Platform)).toBeNull()
  })
})

describe('resolveTrayIconPath', () => {
  const mainDir = path.join('/project', 'dist-electron', 'electron')

  it('resolves dev path for Windows', () => {
    const result = resolveTrayIconPath('win32', false, mainDir)
    expect(result).toBe(path.join(mainDir, '..', '..', 'resources', 'tray', 'tray.ico'))
  })

  it('resolves dev path for Linux/macOS', () => {
    const result = resolveTrayIconPath('linux', false, mainDir)
    expect(result).toBe(path.join(mainDir, '..', '..', 'resources', 'tray', 'tray.png'))
  })

  it('resolves packaged path using resourcesPath', () => {
    const resourcesPath = '/app/resources/tray'
    expect(resolveTrayIconPath('win32', true, mainDir, resourcesPath)).toBe(
      path.join(resourcesPath, 'tray.ico')
    )
    expect(resolveTrayIconPath('darwin', true, mainDir, resourcesPath)).toBe(
      path.join(resourcesPath, 'tray.png')
    )
  })

  it('returns null for unsupported platform', () => {
    expect(resolveTrayIconPath('freebsd' as NodeJS.Platform, false, mainDir)).toBeNull()
  })
})
