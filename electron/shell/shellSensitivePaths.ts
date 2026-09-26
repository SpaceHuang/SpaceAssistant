import os from 'os'
import path from 'path'

function expandHome(p: string, home: string, platform: ShellPathPlatform): string {
  const pp = platform === 'win32' ? path.win32 : path.posix
  if (p.startsWith('~/') || p === '~') {
    return pp.join(home, p.slice(1))
  }
  if (platform === 'win32' && p.startsWith('%USERPROFILE%')) {
    const rest = p.slice('%USERPROFILE%'.length).replace(/^[/\\]/, '')
    return path.win32.join(home, rest)
  }
  return p
}

export type ShellPathPlatform = 'win32' | 'posix' | 'darwin'

/**
 * 内置敏感路径前缀（不可删除）。platform 参数供 Golden 跨平台录制/比对显式指定；
 * 缺省 = 宿主平台（P1-b 评审修复：macOS 宿主缺省 'darwin'，保留 ~/Library 保护，
 * 不再被 'posix' 归并弱化）。golden bash 样本显式传 'posix' 与 win32 录制基线一致。
 */
export function getBuiltinSensitivePrefixes(
  userDataDir?: string,
  platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix',
  homeDir = os.homedir()
): string[] {
  const pp = platform === 'win32' ? path.win32 : path.posix
  const home = homeDir
  const prefixes: string[] = [
    pp.join(home, '.ssh'),
    pp.join(home, '.gnupg'),
    pp.join(home, '.env')
  ]
  if (platform === 'win32') {
    prefixes.push(pp.join(home, 'AppData', 'Roaming'))
    prefixes.push(pp.join('C:', 'Windows'))
  } else if (platform === 'darwin') {
    prefixes.push(pp.join(home, 'Library'))
  } else {
    prefixes.push('/etc')
    prefixes.push('/System')
  }
  if (userDataDir) prefixes.push(userDataDir)
  return prefixes.map((p) => pp.normalize(expandHome(p, home, platform)).toLowerCase())
}

/** 策略环境唯一读取的有效敏感前缀集合：内置与用户自定义使用相同平台归一化。 */
export function getEffectiveSensitivePrefixes(
  userDataDir?: string,
  customPrefixes: readonly string[] = [],
  platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix',
  homeDir = os.homedir()
): string[] {
  const pp = platform === 'win32' ? path.win32 : path.posix
  return [...new Set([
    ...getBuiltinSensitivePrefixes(userDataDir, platform, homeDir),
    ...customPrefixes.map((prefix) => pp.normalize(expandHome(prefix, homeDir, platform)).toLowerCase())
  ])]
}

export function matchSensitive(input: {
  resolvedPath: string
  userDataDir?: string
  homeDir?: string
  platform?: ShellPathPlatform
  builtinPrefixes?: readonly string[]
  customPrefixes?: readonly string[]
}): { sensitive: boolean; matchedBy?: 'builtin' | 'custom' | 'env-name' | 'secrets-directory' } {
  const platform = input.platform ?? (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix')
  const pp = platform === 'win32' ? path.win32 : path.posix
  const home = input.homeDir ?? os.homedir()
  const normalized = pp.normalize(input.resolvedPath).toLowerCase()
  const builtin = input.builtinPrefixes ?? getBuiltinSensitivePrefixes(input.userDataDir, platform, home)
  const custom = input.customPrefixes ?? []
  const matches = (prefix: string) => {
    const normalizedPrefix = pp.normalize(expandHome(prefix, home, platform)).toLowerCase()
    return normalized === normalizedPrefix || normalized.startsWith(normalizedPrefix + pp.sep)
  }
  if (builtin.some(matches)) return { sensitive: true, matchedBy: 'builtin' }
  if (custom.some(matches)) return { sensitive: true, matchedBy: 'custom' }
  if (normalized.endsWith('.env') || normalized.includes(`${pp.sep}.env.`)) return { sensitive: true, matchedBy: 'env-name' }
  if (normalized.includes(`${pp.sep}secrets${pp.sep}`)) return { sensitive: true, matchedBy: 'secrets-directory' }
  return { sensitive: false }
}

export function isSensitivePath(
  resolvedPath: string,
  userDataDir?: string,
  customPrefixes?: string[],
  platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix'
): boolean {
  return matchSensitive({ resolvedPath, userDataDir, customPrefixes, platform }).sensitive
}
