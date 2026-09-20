import os from 'os'
import path from 'path'

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1))
  }
  if (process.platform === 'win32' && p.startsWith('%USERPROFILE%')) {
    const rest = p.slice('%USERPROFILE%'.length).replace(/^[/\\]/, '')
    return path.join(os.homedir(), rest)
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
  platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix'
): string[] {
  const pp = platform === 'win32' ? path.win32 : path.posix
  const home = os.homedir()
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
  return prefixes.map((p) => pp.normalize(expandHome(p)).toLowerCase())
}

export function isSensitivePath(
  resolvedPath: string,
  userDataDir?: string,
  customPrefixes?: string[],
  platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix'
): boolean {
  const pp = platform === 'win32' ? path.win32 : path.posix
  const norm = pp.normalize(resolvedPath).toLowerCase()
  const all = [
    ...getBuiltinSensitivePrefixes(userDataDir, platform),
    ...(customPrefixes ?? []).map((p) => pp.normalize(expandHome(p)).toLowerCase())
  ]
  for (const prefix of all) {
    if (norm === prefix || norm.startsWith(prefix + pp.sep)) return true
    if (norm.endsWith('.env') || norm.includes(`${pp.sep}.env.`)) return true
    if (norm.includes(`${pp.sep}secrets${pp.sep}`)) return true
  }
  return false
}
