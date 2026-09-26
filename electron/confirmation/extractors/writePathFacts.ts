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
  const root = windowsPath ? pathApi.normalize(workDir) : await fs.realpath(workDir)
  const target = pathApi.normalize(normalizedPath)
  const relative = pathApi.relative(root, target)
  return relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)
    ? 'outside-workdir'
    : 'inside-workdir'
}

export class WritePathProbeError extends Error {
  readonly failureClass = 'environment' as const
  readonly caseId = 'write-path-probe-environment-error' as const

  constructor(readonly code: string) {
    super('写入目标事实探测失败')
    this.name = 'WritePathProbeError'
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
  const pathApi = windowsInput ? path.win32 : path
  const workDir = windowsInput ? path.win32.normalize(input.workDir) : await canonicalizeThroughExistingParent(input.workDir, path)
  const userDataDir = windowsInput ? path.win32.normalize(input.userDataDir) : await canonicalizeThroughExistingParent(input.userDataDir, path)
  const homeDir = windowsInput ? path.win32.normalize(input.homeDir) : await canonicalizeThroughExistingParent(input.homeDir, path)
  const customSensitivePrefixes = windowsInput
    ? input.customSensitivePrefixes
    : await Promise.all(input.customSensitivePrefixes.map((prefix) => canonicalizeThroughExistingParent(prefix, path)))
  const lexicalPath = windowsInput ? path.win32.normalize(rawPath) : path.resolve(workDir, rawPath)
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
    parentReal = await fs.realpath(pathApi.dirname(realTarget))
  } catch (error) {
    const code = asCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WritePathProbeError(code)
    const symlinkComponent = await hasSymlinkComponent(lexicalPath, pathApi)
    let parent = pathApi.dirname(lexicalPath)
    while (true) {
      try {
        parentReal = await fs.realpath(parent)
        const suffix = pathApi.relative(parent, lexicalPath)
        normalizedPath = pathApi.join(parentReal, suffix)
        if (symlinkComponent) targetKind = 'symlink'
        break
      } catch (parentError) {
        const parentCode = asCode(parentError)
        if (parentCode !== 'ENOENT' && parentCode !== 'ENOTDIR') throw new WritePathProbeError(parentCode)
        const next = pathApi.dirname(parent)
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
