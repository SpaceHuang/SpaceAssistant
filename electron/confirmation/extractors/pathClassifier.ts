import type { EnvFacts, PathZone } from '../../../src/shared/confirmation/types'

/**
 * 跨平台路径规范化：统一分隔符为 `/`，手工解析 `.` / `..`。
 * 不使用 Node `path` 模块——分类器语义由 env.os 决定，而 CI / 远端运行时
 * 的宿主平台可能与目标平台不同（如 Linux 上判定 Windows 路径）。
 */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/')
}

function isAbsolutePath(p: string): boolean {
  const norm = normalizeSep(p)
  return norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm) || norm.startsWith('//')
}

function resolvePath(base: string, p: string): string {
  const raw = isAbsolutePath(p) ? normalizeSep(p) : `${normalizeSep(base)}/${normalizeSep(p)}`
  const hasDrive = /^[a-zA-Z]:\//.test(raw)
  const hasRoot = raw.startsWith('/')
  const parts = raw.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      // 不允许弹出驱动器 / 根之外
      if (out.length > (hasDrive ? 1 : 0)) out.pop()
      continue
    }
    out.push(part)
  }
  const prefix = hasDrive ? '' : hasRoot ? '/' : ''
  return prefix + out.join('/')
}

/** 定位目录前缀：路径落在系统根下即归为 system-dir。 */
function isSystemDir(p: string): boolean {
  const norm = normalizeSep(p).toLowerCase()
  // M9：允许无尾分隔符的 Windows 根（如 `C:\Windows`），并补 Program Files (x86)。
  const winRoot = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata|system32)(\/|$)/
  const posixRoot = /^\/(etc|usr|bin|sbin|lib|var|system|library)(\/|$)/
  return winRoot.test(norm) || posixRoot.test(norm)
}

function isOutsideWorkDir(workDir: string, resolved: string): boolean {
  const base = resolvePath(workDir, workDir).toLowerCase()
  const target = resolved.toLowerCase()
  return target !== base && !target.startsWith(base + '/')
}

function isSensitive(env: EnvFacts, resolved: string): boolean {
  const lower = resolved.toLowerCase()
  return env.sensitivePaths.some((s) => {
    const base = normalizeSep(s).toLowerCase().replace(/\/+$/, '')
    return lower === base || lower.startsWith(base + '/')
  })
}

/**
 * 路径分类器：路径 → system-dir / outside-workdir / sensitive-file / workdir-normal。
 * 只产出分类事实，不做任何放行/拒绝判定。
 */
export function classifyPath(rawPath: string, env: EnvFacts): PathZone {
  const resolved = resolvePath(env.workDir, rawPath)
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
