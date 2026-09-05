import path from 'path'
import fs from 'fs/promises'
import type { EnvFacts, PathZone } from '../../../src/shared/confirmation/types'

/** 定位目录前缀：路径落在系统根下即归为 system-dir。 */
function isSystemDir(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase()
  // M9：允许无尾分隔符的 Windows 根（如 `C:\Windows`），并补 Program Files (x86)。
  const winRoot = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata|system32)(\/|$)/
  const posixRoot = /^\/(etc|usr|bin|sbin|lib|var|system|library)(\/|$)/
  return winRoot.test(norm) || posixRoot.test(norm)
}

function isSensitive(env: EnvFacts, resolved: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
  const lower = normalize(resolved)
  return env.sensitivePaths.some((s) => {
    const sensitive = normalize(s)
    return lower === sensitive || lower.startsWith(sensitive + '/')
  })
}

function resolveForEnvironment(rawPath: string, env: EnvFacts): string {
  if (env.os === 'win32') {
    const winPath = rawPath.replace(/\//g, '\\')
    return path.win32.isAbsolute(winPath)
      ? path.win32.normalize(winPath)
      : path.win32.resolve(env.workDir, winPath)
  }
  return path.posix.isAbsolute(rawPath) ? path.posix.resolve(rawPath) : path.posix.resolve(env.workDir, rawPath)
}

function isOutsideForEnvironment(workDir: string, resolved: string, env: EnvFacts): boolean {
  if (env.os === 'win32') {
    const rel = path.win32.relative(path.win32.normalize(workDir), path.win32.normalize(resolved))
    return rel.startsWith('..') || path.win32.isAbsolute(rel)
  }
  const rel = path.posix.relative(path.posix.resolve(workDir), path.posix.resolve(resolved))
  return rel.startsWith('..') || path.posix.isAbsolute(rel)
}

/**
 * 路径分类器：路径 → system-dir / outside-workdir / sensitive-file / workdir-normal。
 * 只产出分类事实，不做任何放行/拒绝判定。
 */
export function classifyPath(rawPath: string, env: EnvFacts): PathZone {
  const resolved = resolveForEnvironment(rawPath, env)
  if (isSensitive(env, resolved)) return 'sensitive-file'
  if (isSystemDir(resolved)) return 'system-dir'
  if (isOutsideForEnvironment(env.workDir, resolved, env)) return 'outside-workdir'
  return 'workdir-normal'
}

/** 对存在的路径解析 symlink 后再分类；不存在的目标回退到 lexical 分类。 */
export async function classifyPathWithSymlink(rawPath: string, env: EnvFacts): Promise<PathZone> {
  const lexical = classifyPath(rawPath, env)
  const resolved = resolveForEnvironment(rawPath, env)
  try {
    const real = await fs.realpath(resolved)
    if (isSensitive(env, real)) return 'sensitive-file'
    if (isSystemDir(real)) return 'system-dir'
    if (isOutsideForEnvironment(env.workDir, real, env)) return 'outside-workdir'
  } catch {
    // 目标不存在或当前平台不能解析时保留 lexical 事实。
  }
  return lexical
}

export function buildPathSignal(rawPath: string, env: EnvFacts): {
  kind: 'path-target'
  path: string
  zone: PathZone
} {
  return { kind: 'path-target', path: rawPath, zone: classifyPath(rawPath, env) }
}
