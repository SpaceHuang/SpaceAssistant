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

export type ShellPathPlatform = 'win32' | 'posix'

/** 内置敏感路径前缀（不可删除）。platform 参数供 Golden 跨平台录制/比对显式指定（缺省宿主平台，生产行为不变）。 */
export function getBuiltinSensitivePrefixes(userDataDir?: string, platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : 'posix'): string[] {
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
  } else if (process.platform === 'darwin' && platform !== 'posix') {
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
  platform: ShellPathPlatform = process.platform === 'win32' ? 'win32' : 'posix'
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
