import path from 'path'

export type TrayPlatform = NodeJS.Platform

export function getTrayIconFileName(platform: TrayPlatform): string | null {
  if (platform === 'win32') return 'tray.ico'
  if (platform === 'darwin' || platform === 'linux') return 'tray.png'
  return null
}

export function resolveTrayIconPath(
  platform: TrayPlatform,
  isPackaged: boolean,
  mainDirname: string,
  resourcesPath?: string
): string | null {
  const fileName = getTrayIconFileName(platform)
  if (!fileName) return null

  if (isPackaged) {
    const base = resourcesPath ?? path.join(process.resourcesPath, 'tray')
    return path.join(base, fileName)
  }

  return path.join(mainDirname, '..', '..', 'resources', 'tray', fileName)
}
