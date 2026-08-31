import path from 'path'
import type { EnvFacts, PathZone } from '../../../src/shared/confirmation/types'

/** 定位目录前缀：路径落在系统根下即归为 system-dir。 */
function isSystemDir(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase()
  const winRoot = /^[a-z]:\/(windows|program files|programdata|system32)\//
  const posixRoot = /^\/(etc|usr|bin|sbin|lib|var|system|library)\//
  return winRoot.test(norm) || posixRoot.test(norm)
}

function isOutsideWorkDir(workDir: string, resolved: string): boolean {
  const base = path.resolve(workDir)
  const rel = path.relative(base, path.resolve(resolved))
  return rel.startsWith('..') || path.isAbsolute(rel)
}

function isSensitive(env: EnvFacts, resolved: string): boolean {
  const lower = resolved.toLowerCase()
  return env.sensitivePaths.some((s) => lower === s.toLowerCase() || lower.startsWith(s.toLowerCase() + path.sep))
}

/**
 * 路径分类器：路径 → system-dir / outside-workdir / sensitive-file / workdir-normal。
 * 只产出分类事实，不做任何放行/拒绝判定。
 */
export function classifyPath(rawPath: string, env: EnvFacts): PathZone {
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(env.workDir, rawPath)
  if (isSensitive(env, resolved)) return 'sensitive-file'
  if (isSystemDir(resolved)) return 'system-dir'
  if (isOutsideWorkDir(env.workDir, resolved)) return 'outside-workdir'
  return 'workdir-normal'
}

export function buildPathSignal(rawPath: string, env: EnvFacts): {
  kind: 'path-target'
  path: string
  zone: PathZone
} {
  return { kind: 'path-target', path: rawPath, zone: classifyPath(rawPath, env) }
}
