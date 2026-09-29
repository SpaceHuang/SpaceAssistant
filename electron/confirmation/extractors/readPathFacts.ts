import fs from 'fs/promises'
import path from 'path'
import type { PathZone } from '../../../src/shared/confirmation/types'
import { getBuiltinSensitivePrefixes, matchSensitive } from '../../shell/shellSensitivePaths'

export type ReadTargetKind = 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'

export type ReadPathFact = {
  rawPath: string
  normalizedPath: string
  zone: PathZone
  targetKind: ReadTargetKind
  resolvedKind?: 'file' | 'directory' | 'special'
  identity?: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }
  scope?: 'single-target' | 'direct-entries-snapshot'
}

type ProbeInput = {
  rawPath: string
  workDir: string
  userDataDir: string
  homeDir: string
  customSensitivePrefixes: readonly string[]
}

export class ReadPathProbeError extends Error {
  readonly failureClass = 'environment' as const
  readonly caseId = 'read-path-probe-environment-error' as const

  constructor(readonly code: string) {
    super('读取目标事实探测失败')
    this.name = 'ReadPathProbeError'
  }
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)
}

function normalize(value: string, platform: 'win32' | 'posix' = isWindowsAbsolute(value) ? 'win32' : 'posix'): string {
  // 语法三态分派：win32 绝对 → win32 API；其余（POSIX 绝对/相对）→ posix API。
  // 进程平台相关的 path.resolve 在 win32 上会把 '/etc/hosts' 漂移成 'E:\etc\hosts'（当前盘符），导致 system-dir 漏判。
  const resolved = isWindowsAbsolute(value) ? path.win32.normalize(value) : path.posix.normalize(value)
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function under(candidate: string, prefix: string): boolean {
  const platform = isWindowsAbsolute(candidate) || isWindowsAbsolute(prefix) ? 'win32' : 'posix'
  const c = normalize(candidate, platform)
  const p = normalize(prefix, platform)
  return c === p || c.startsWith(`${p}/`)
}

function isSystemDir(candidate: string): boolean {
  const windowsPath = isWindowsAbsolute(candidate)
  const normalized = normalize(candidate, windowsPath ? 'win32' : 'posix')
  const standardWindowsRoot = /^[a-z]:\/(windows|program files(?: \(x86\))?|programdata|system32)(\/|$)/
  const configuredWindowsRoots = [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter((root): root is string => Boolean(root))
  const macPrivateVarSystem = !windowsPath && under(normalized, '/private/var') && !under(normalized, '/private/var/folders')
  return /^\/(etc|usr|bin|sbin|lib|var|system|library|System|Library)(\/|$)/.test(normalized) ||
    /^\/private\/etc(\/|$)/.test(normalized) ||
    macPrivateVarSystem ||
    standardWindowsRoot.test(normalized) || configuredWindowsRoots.some((root) => under(candidate, root))
}

/** 路径 zone 的唯一纯分类入口，读写事实探测共同消费其结果。 */
export function classifyReadPathZone(input: ProbeInput & { resolvedPath: string }): PathZone {
  const platform = isWindowsAbsolute(input.resolvedPath) ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix'
  return matchSensitive({
    resolvedPath: input.resolvedPath,
    userDataDir: input.userDataDir,
    homeDir: input.homeDir,
    platform,
    builtinPrefixes: getBuiltinSensitivePrefixes(input.userDataDir, platform, input.homeDir),
    customPrefixes: input.customSensitivePrefixes
  }).sensitive
    ? 'sensitive-file'
    : isSystemDir(input.resolvedPath)
      ? 'system-dir'
      : under(input.resolvedPath, input.workDir)
        ? 'workdir-normal'
        : 'outside-workdir'
}

function identityOf(stat: import('fs').Stats) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
}

/** 只探测事实；不做放行或拒绝判定。 */
export async function probeReadPathFact(input: ProbeInput): Promise<ReadPathFact> {
  const fallbackIfMissing = (error: unknown, fallback: string): string => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') return fallback
    throw new ReadPathProbeError(code || 'UNKNOWN')
  }
  const canonical = async (value: string) => {
    // env 路径按自身语法解析：POSIX 语法失败时保持 POSIX 形态（不落进程平台的盘符漂移）。
    try { return await fs.realpath(value) } catch (error) { return fallbackIfMissing(error, path.posix.resolve(value)) }
  }
  const canonicalPlatformPath = async (value: string) => {
    if (!isWindowsAbsolute(value)) return canonical(value)
    try { return await fs.realpath(value) } catch (error) { return fallbackIfMissing(error, path.win32.normalize(value)) }
  }
  const effectiveInput: ProbeInput = {
    ...input,
    workDir: await canonicalPlatformPath(input.workDir),
    userDataDir: await canonicalPlatformPath(input.userDataDir),
    homeDir: await canonicalPlatformPath(input.homeDir),
    customSensitivePrefixes: await Promise.all(input.customSensitivePrefixes.map(canonicalPlatformPath))
  }
  const rawIsWindowsAbsolute = isWindowsAbsolute(input.rawPath)
  // 三态分派：win32 绝对 → win32 API；POSIX 绝对 → posix API；相对路径 → 按 workDir 的语法 resolve。
  const pathApi = rawIsWindowsAbsolute
    ? path.win32
    : input.rawPath.startsWith('/')
      ? path.posix
      : isWindowsAbsolute(effectiveInput.workDir) ? path.win32 : path.posix
  const lexical = rawIsWindowsAbsolute
    ? path.win32.normalize(input.rawPath)
    : pathApi.resolve(effectiveInput.workDir, input.rawPath)
  let normalizedPath = lexical
  let targetKind: ReadTargetKind = 'missing'
  let resolvedKind: 'file' | 'directory' | 'special' | undefined
  let stat: import('fs').Stats | undefined

  try {
    const lstat = await fs.lstat(lexical)
    stat = lstat
    normalizedPath = await fs.realpath(lexical)
    if (lstat.isSymbolicLink()) targetKind = 'symlink'
    else if (lstat.isFile()) targetKind = 'file'
    else if (lstat.isDirectory()) targetKind = 'directory'
    else targetKind = 'special'
    stat = await fs.stat(lexical)
    resolvedKind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'special'
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // 保留缺失目标，但把最近存在父目录的符号链接解析进事实。
      let parent = pathApi.dirname(lexical)
      while (parent !== pathApi.dirname(parent)) {
        try {
          const realParent = await fs.realpath(parent)
          // 跨语法守卫：POSIX 语法路径在 win32 上父目录可能探到真实存在的盘符形态答案
          // （如 E:\etc 恰好存在），采信会产出混合分隔符形态并漏判 system-dir；不采信则保持 lexical。
          if (pathApi === path.posix && isWindowsAbsolute(realParent)) break
          normalizedPath = pathApi.join(realParent, pathApi.relative(parent, lexical))
          break
        } catch (error) {
          const parentCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
          if (parentCode !== 'ENOENT' && parentCode !== 'ENOTDIR') throw new ReadPathProbeError(parentCode || 'UNKNOWN')
          parent = pathApi.dirname(parent)
        }
      }
    } else {
      throw new ReadPathProbeError(code || 'UNKNOWN')
    }
  }

  const zone = classifyReadPathZone({ ...effectiveInput, resolvedPath: normalizedPath })

  return {
    rawPath: input.rawPath,
    normalizedPath,
    zone,
    targetKind,
    ...(resolvedKind ? { resolvedKind } : {}),
    ...(stat ? { identity: identityOf(stat) } : {}),
    scope: 'single-target'
  }
}
