import path from 'path'

export type AppIconPlatform = NodeJS.Platform
export type AppIconTheme = 'light' | 'dark'

export function getAppIconTheme(useDarkColors: boolean): AppIconTheme {
  return useDarkColors ? 'dark' : 'light'
}

/** Electron 窗口图标统一使用 256 PNG；浅色/深色任务栏分别用对应主题资源。 */
export function getAppIconFileName(_platform: AppIconPlatform, theme: AppIconTheme = 'light'): string {
  return theme === 'dark' ? 'dark/sa-logo-dark-256.png' : 'sa-logo-256.png'
}

export function resolveAppIconPath(
  platform: AppIconPlatform,
  isPackaged: boolean,
  mainDirname: string,
  theme: AppIconTheme = 'light',
  resourcesPath?: string
): string {
  const fileName = getAppIconFileName(platform, theme)

  if (isPackaged) {
    const base = resourcesPath ?? path.join(process.resourcesPath, 'icons')
    return path.join(base, fileName)
  }

  return path.join(mainDirname, '..', '..', 'res', 'icons', fileName)
}
