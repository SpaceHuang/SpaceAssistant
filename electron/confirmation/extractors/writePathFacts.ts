import fs from 'fs/promises'
import path from 'path'
import type { PathZone } from '../../../src/shared/confirmation/types'
import { classifyReadPathZone } from './readPathFacts'

export type WriteTargetKind = 'file' | 'directory' | 'missing' | 'symlink' | 'hardlink' | 'special' | 'unknown'
export type WritePathIdentity = { dev: number; ino: number; mode: number; size: number; mtimeMs: number; nlink: number }

export type WritePathFact = {
  rawPath: string
  normalizedPath: string
  zone: PathZone
  targetKind: WriteTargetKind
  parentReal: string
  parentIdentity: WritePathIdentity
  identity?: WritePathIdentity
}

export type WritePathProbeInput = {
  rawPath: string
  workDir: string
  userDataDir: string
  homeDir: string
  customSensitivePrefixes: readonly string[]
}

export async function classifyWriteTargetScope(normalizedPath: string, workDir: string): Promise<'inside-workdir' | 'outside-workdir'> {
  const windowsPath = isWindowsAbsolute(normalizedPath) || isWindowsAbsolute(workDir)
  const pathApi = windowsPath ? path.win32 : path
  // workDir 真实存在时用 realpath（防 symlink 化的 workDir 误判归属）；尚未创建（新会话首写是常态）
  // 或不可达时回退 lexical 归一——此前直接 ENOENT 上抛会让调用方判 scope=unknown，远程首写被
  // remote-write-scope-unknown-deny 终局拒绝（GitHub Linux CI 实证）。
  const root = windowsPath
    ? pathApi.normalize(workDir)
    : await fs.realpath(workDir).catch(() => pathApi.normalize(workDir))
  const target = pathApi.normalize(normalizedPath)
  const relative = pathApi.relative(root, target)
  return relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)
    ? 'outside-workdir'
    : 'inside-workdir'
}

export class WritePathProbeError extends Error {
  readonly failureClass = 'environment' as const
  readonly caseId: string

  constructor(readonly code: string, caseId = 'write-path-probe-environment-error') {
    super('写入目标事实探测失败')
    this.name = 'WritePathProbeError'
    this.caseId = caseId
  }
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)
}

function identityOf(stat: import('fs').Stats): WritePathIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
}

function asCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
}

async function canonicalizeThroughExistingParent(value: string, pathApi: typeof path | typeof path.win32): Promise<string> {
  let candidate = pathApi.resolve(value)
  while (true) {
    try {
      const real = await fs.realpath(candidate)
      return pathApi.join(real, pathApi.relative(candidate, pathApi.resolve(value)))
    } catch (error) {
      const code = asCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WritePathProbeError(code)
      const parent = pathApi.dirname(candidate)
      if (parent === candidate) throw new WritePathProbeError(code)
      candidate = parent
    }
  }
}

async function hasSymlinkComponent(value: string, pathApi: typeof path | typeof path.win32): Promise<boolean> {
  const resolved = pathApi.resolve(value)
  const root = pathApi.parse(resolved).root
  const relative = pathApi.relative(root, resolved)
  let walked = root
  for (const segment of relative.split(pathApi.sep).filter(Boolean)) {
    walked = pathApi.join(walked, segment)
    try {
      if ((await fs.lstat(walked)).isSymbolicLink()) return true
    } catch (error) {
      const code = asCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw new WritePathProbeError(code)
    }
  }
  return false
}

/** 只生成写目标事实；不根据 zone 决定是否允许写入。 */
export async function probeWritePathFact(input: WritePathProbeInput): Promise<WritePathFact> {
  const rawPath = input.rawPath.trim()
  if (!rawPath) throw new WritePathProbeError('INVALID_PATH')
  const windowsInput = isWindowsAbsolute(rawPath)
  // env 路径 canonicalize 保持按进程平台 API：win32 上对 win32 形态 env 直接正确；POSIX 形态 env 的
  // realpath 返回的是该路径在当前文件系统的真实指向（truthful），不适用「语法意图不可达」判定，不加跨语法守卫。
  const workDir = windowsInput ? path.win32.normalize(input.workDir) : await canonicalizeThroughExistingParent(input.workDir, path)
  const userDataDir = windowsInput ? path.win32.normalize(input.userDataDir) : await canonicalizeThroughExistingParent(input.userDataDir, path)
  const homeDir = windowsInput ? path.win32.normalize(input.homeDir) : await canonicalizeThroughExistingParent(input.homeDir, path)
  const customSensitivePrefixes = windowsInput
    ? input.customSensitivePrefixes
    : await Promise.all(input.customSensitivePrefixes.map((prefix) => canonicalizeThroughExistingParent(prefix, path)))
  // 三态分派（merge-main-28 批次 1）：win32 绝对 → win32 API；POSIX 绝对 → posix API（绝对路径不涉及
  // workDir）；相对路径 → 按 canonicalize 后 workDir 的语法 resolve。进程平台相关的 path.resolve 在
  // win32 上会把 '/etc/hosts' 漂移成 'E:\etc\hosts'（当前盘符），导致 system-dir 漏判。
  const pathApi = windowsInput
    ? path.win32
    : rawPath.startsWith('/')
      ? path.posix
      : isWindowsAbsolute(workDir) ? path.win32 : path.posix
  const lexicalPath = pathApi.resolve(workDir, rawPath)
  let normalizedPath = lexicalPath
  let targetKind: WriteTargetKind = 'missing'
  let identity: WritePathIdentity | undefined
  let parentReal: string

  try {
    const targetLstat = await fs.lstat(lexicalPath)
    const realTarget = await fs.realpath(lexicalPath)
    const targetStat = await fs.stat(lexicalPath)
    normalizedPath = realTarget
    // 写路径任一组件被 realpath 改写都要保留为 symlink 事实，留给机制层拒绝。
    targetKind = targetLstat.isSymbolicLink() || await hasSymlinkComponent(lexicalPath, pathApi)
      ? 'symlink'
      : targetStat.isFile()
        ? targetStat.nlink > 1 ? 'hardlink' : 'file'
        : targetStat.isDirectory()
          ? 'directory'
          : 'special'
    identity = identityOf(targetStat)
    // realTarget 是 fs.realpath 的真实答案，形态恒为进程平台原生（win32 上返回盘符形态），
    // 因此 dirname 用进程平台 API 而非 pathApi，避免跨语法 dirname 产出 '.'/错误父目录。
    parentReal = await fs.realpath(path.dirname(realTarget))
  } catch (error) {
    const code = asCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WritePathProbeError(code)
    const symlinkComponent = await hasSymlinkComponent(lexicalPath, pathApi)
    let parent = pathApi.dirname(lexicalPath)
    while (true) {
      try {
        const real = await fs.realpath(parent)
        // 跨语法守卫（1.4a）：POSIX 语法路径在 win32 上父目录可能探到真实存在的盘符形态答案
        // （如 E:\etc 恰好存在），采信会经 posix.join 产出 'E:\/etc/hosts' 混合形态并漏判 system-dir。
        // 不采信：normalizedPath 保持 lexical POSIX 形态，parentReal 记 lexical 父目录（fs.stat 按当前盘符解释可成功）。
        if (pathApi === path.posix && isWindowsAbsolute(real)) {
          parentReal = parent
          if (symlinkComponent) targetKind = 'symlink'
          break
        }
        parentReal = real
        const suffix = pathApi.relative(parent, lexicalPath)
        normalizedPath = pathApi.join(real, suffix)
        if (symlinkComponent) targetKind = 'symlink'
        break
      } catch (parentError) {
        const parentCode = asCode(parentError)
        if (parentCode !== 'ENOENT' && parentCode !== 'ENOTDIR') throw new WritePathProbeError(parentCode)
        const next = pathApi.dirname(parent)
        // 语法根守卫（1.4a）：POSIX 语法根 '/' 的 win32 realpath 会成功返回当前盘符根（探针实测
        // fs.realpath('/') === 'E:\'），继续回退会把不存在的 POSIX 根路径带回混合形态——到达即静默退出。
        if (pathApi === path.posix && next === '/') {
          parentReal = '/'
          if (symlinkComponent) targetKind = 'symlink'
          break
        }
        if (next === parent) throw new WritePathProbeError(parentCode)
        parent = next
      }
    }
  }

  let parentIdentity: WritePathIdentity
  try {
    parentIdentity = identityOf(await fs.stat(parentReal))
  } catch (error) {
    throw new WritePathProbeError(asCode(error))
  }
  if (targetKind === 'missing' && pathApi.dirname(normalizedPath) !== parentReal) {
    throw new WritePathProbeError('PARENT_DIRECTORY_MISSING', 'write-parent-directory-missing')
  }
  const zone = classifyReadPathZone({
    rawPath,
    resolvedPath: normalizedPath,
    workDir,
    userDataDir,
    homeDir,
    customSensitivePrefixes
  })
  return {
    rawPath: input.rawPath,
    normalizedPath,
    zone,
    targetKind,
    parentReal,
    parentIdentity,
    ...(identity ? { identity } : {})
  }
}
