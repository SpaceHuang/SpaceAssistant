import fs from 'fs/promises'
import path from 'path'
import type { PathZone } from '../../../src/shared/confirmation/types'
import { classifyReadPathZone } from './readPathFacts'
import { matchMountAnchor, type MountAnchor } from './mountAnchors'

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
  /** wiki 挂载命中时的 workDir 相对词汇路径（T1.1；与 Agent 入参逐字一致） */
  vocabularyPath?: string
  /** wiki 挂载命中时的包含判定基准（= realBase）；写范围分类以此为根（T1.4） */
  scopeBase?: string
}

export type WritePathProbeInput = {
  rawPath: string
  workDir: string
  workDirs?: readonly string[]
  userDataDir: string
  homeDir: string
  customSensitivePrefixes: readonly string[]
  /** wiki 挂载锚点（gate 以 resolveWikiMount 结果构造；缺省 = 行为与现状逐字节一致） */
  mountAnchors?: readonly MountAnchor[]
  /** wiki 启用时 gate 传入的敏感根豁免（仅含共享库子树；豁免优先，T1.3） */
  sensitiveRootExemptions?: readonly string[]
}

export { type MountAnchor } from './mountAnchors'

export async function classifyWriteTargetScope(normalizedPath: string, workDir: string, workDirs: readonly string[] = [workDir]): Promise<'inside-workdir' | 'outside-workdir'> {
  const roots = workDirs.length ? workDirs : [workDir]
  const windowsPath = isWindowsAbsolute(normalizedPath) || roots.some(isWindowsAbsolute)
  const pathApi = windowsPath ? path.win32 : path
  // workDir 真实存在时用 realpath（防 symlink 化的 workDir 误判归属）；尚未创建（新会话首写是常态）
  // 或不可达时回退 lexical 归一——此前直接 ENOENT 上抛会让调用方判 scope=unknown，远程首写被
  // remote-write-scope-unknown-deny 终局拒绝（GitHub Linux CI 实证）。
  const target = pathApi.normalize(normalizedPath)
  for (const candidate of roots) {
    const root = windowsPath
      ? pathApi.normalize(candidate)
      : await fs.realpath(candidate).catch(() => pathApi.normalize(candidate))
    const relative = pathApi.relative(root, target)
    if (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)) return 'inside-workdir'
  }
  return 'outside-workdir'
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
  // T1.1：锚点命中时探测的包含判定锚点从 workDir 换为 realBase，入参换为挂载内相对路径。
  const anchorHit = matchMountAnchor(input.rawPath, input.workDir, input.mountAnchors)
  const anchoredInput: WritePathProbeInput = anchorHit
    ? { ...input, rawPath: anchorHit.relInBase, workDir: anchorHit.anchor.base, workDirs: [anchorHit.anchor.base] }
    : input
  const rawPath = anchoredInput.rawPath.trim()
  if (!rawPath) throw new WritePathProbeError('INVALID_PATH')
  const windowsInput = isWindowsAbsolute(rawPath)
  // env 路径 canonicalize 保持按进程平台 API：win32 上对 win32 形态 env 直接正确；POSIX 形态 env 的
  // realpath 返回的是该路径在当前文件系统的真实指向（truthful），不适用「语法意图不可达」判定，不加跨语法守卫。
  const workDir = windowsInput ? path.win32.normalize(anchoredInput.workDir) : await canonicalizeThroughExistingParent(anchoredInput.workDir, path)
  const userDataDir = windowsInput ? path.win32.normalize(anchoredInput.userDataDir) : await canonicalizeThroughExistingParent(anchoredInput.userDataDir, path)
  const homeDir = windowsInput ? path.win32.normalize(anchoredInput.homeDir) : await canonicalizeThroughExistingParent(anchoredInput.homeDir, path)
  const customSensitivePrefixes = windowsInput
    ? anchoredInput.customSensitivePrefixes
    : await Promise.all(anchoredInput.customSensitivePrefixes.map((prefix) => canonicalizeThroughExistingParent(prefix, path)))
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
    workDirs: anchoredInput.workDirs,
    userDataDir,
    homeDir,
    customSensitivePrefixes,
    sensitiveRootExemptions: anchoredInput.sensitiveRootExemptions
  })
  return {
    rawPath: input.rawPath,
    normalizedPath,
    zone,
    targetKind,
    parentReal,
    parentIdentity,
    ...(identity ? { identity } : {}),
    ...(anchorHit
      ? {
          vocabularyPath: anchorHit.vocabularyPath,
          scopeBase: workDir
        }
      : {})
  }
}
