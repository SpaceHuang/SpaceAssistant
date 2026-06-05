import path from 'path'
import type { AppIconTheme } from './appIconPath'

export type TrayPlatform = NodeJS.Platform

export function getTrayIconBaseName(theme: AppIconTheme = 'light'): string {
  return theme === 'dark' ? 'tray-dark' : 'tray'
}

export function getTrayIconFileName(platform: TrayPlatform, theme: AppIconTheme = 'light'): string | null {
  const base = getTrayIconBaseName(theme)
  if (platform === 'win32') return `${base}.ico`
  if (platform === 'darwin' || platform === 'linux') return `${base}.png`
  return null
}

export function resolveTrayIconPath(
  platform: TrayPlatform,
  isPackaged: boolean,
  mainDirname: string,
  theme: AppIconTheme = 'light',
  resourcesPath?: string
): string | null {
  const fileName = getTrayIconFileName(platform, theme)
  if (!fileName) return null

  if (isPackaged) {
    const base = resourcesPath ?? path.join(process.resourcesPath, 'tray')
    return path.join(base, fileName)
  }

  return path.join(mainDirname, '..', '..', 'resources', 'tray', fileName)
}
