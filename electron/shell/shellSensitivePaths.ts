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

/** 内置敏感路径前缀（不可删除） */
export function getBuiltinSensitivePrefixes(userDataDir?: string): string[] {
  const home = os.homedir()
  const prefixes: string[] = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.env')
  ]
  if (process.platform === 'win32') {
    prefixes.push(path.join(home, 'AppData', 'Roaming'))
    prefixes.push(path.join('C:', 'Windows'))
  } else if (process.platform === 'darwin') {
    prefixes.push(path.join(home, 'Library'))
  } else {
    prefixes.push('/etc')
    prefixes.push('/System')
  }
  if (userDataDir) prefixes.push(userDataDir)
  return prefixes.map((p) => path.normalize(expandHome(p)).toLowerCase())
}

export function isSensitivePath(resolvedPath: string, userDataDir?: string, customPrefixes?: string[]): boolean {
  const norm = path.normalize(resolvedPath).toLowerCase()
  const all = [
    ...getBuiltinSensitivePrefixes(userDataDir),
    ...(customPrefixes ?? []).map((p) => path.normalize(expandHome(p)).toLowerCase())
  ]
  for (const prefix of all) {
    if (norm === prefix || norm.startsWith(prefix + path.sep)) return true
    if (norm.endsWith('.env') || norm.includes(`${path.sep}.env.`)) return true
    if (norm.includes(`${path.sep}secrets${path.sep}`)) return true
  }
  return false
}
