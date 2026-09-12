import path from 'path'
import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'

export type RipgrepBinarySource = 'bundled' | 'development' | 'unavailable'

export type RipgrepUnavailableReason =
  | 'unsupported'
  | 'not_found'
  | 'not_file'
  | 'permission_denied'
  | 'exec_format'
  | 'resource_exhausted'
  | 'spawn_failed'

export type ResolvedRipgrepBinary = {
  path: string | null
  source: RipgrepBinarySource
  platform: NodeJS.Platform
  arch: string
  reason?: Extract<RipgrepUnavailableReason, 'unsupported'>
}

export type RipgrepBinaryAvailability =
  | { available: true }
  | { available: false; reason: Extract<RipgrepUnavailableReason, 'not_found' | 'not_file' | 'permission_denied' | 'spawn_failed'> }

type ResolveOptions = {
  packaged: boolean
  resourcesPath: string
  developmentRoot?: string
  platform: NodeJS.Platform
  arch: string
}

const supported = new Set(['darwin-x64', 'darwin-arm64', 'win32-x64'])

export function resolveRipgrepBinary(options: ResolveOptions): ResolvedRipgrepBinary {
  const key = `${options.platform}-${options.arch}`
  const file = options.platform === 'win32' ? 'rg.exe' : 'rg'
  if (!supported.has(key)) {
    return { path: null, source: 'unavailable', platform: options.platform, arch: options.arch, reason: 'unsupported' }
  }
  if (options.packaged) {
    return { path: path.resolve(options.resourcesPath, 'bin', file), source: 'bundled', platform: options.platform, arch: options.arch }
  }
  return { path: path.resolve(options.developmentRoot ?? path.resolve(__dirname, '../../'), 'resources', 'ripgrep', key, file), source: 'development', platform: options.platform, arch: options.arch }
}

/**
 * 在启动子进程前验证解析出的受信二进制。开发态 staging 被 git 忽略，
 * 因此不能将“路径可计算”误认为“二进制已准备”。
 */
export async function inspectRipgrepBinary(resolved: ResolvedRipgrepBinary): Promise<RipgrepBinaryAvailability> {
  if (!resolved.path) return { available: false, reason: 'spawn_failed' }
  try {
    const stat = await fs.stat(resolved.path)
    if (!stat.isFile()) return { available: false, reason: 'not_file' }
    if (resolved.platform !== 'win32') await fs.access(resolved.path, fsConstants.X_OK)
    return { available: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { available: false, reason: 'not_found' }
    if (code === 'EACCES' || code === 'EPERM') return { available: false, reason: 'permission_denied' }
    return { available: false, reason: 'spawn_failed' }
  }
}

export function classifyRipgrepSpawnError(error: NodeJS.ErrnoException): Exclude<RipgrepUnavailableReason, 'unsupported' | 'not_file'> {
  switch (error.code) {
    case 'ENOENT': return 'not_found'
    case 'EACCES':
    case 'EPERM': return 'permission_denied'
    case 'ENOEXEC': return 'exec_format'
    case 'EMFILE':
    case 'ENFILE': return 'resource_exhausted'
    default: return 'spawn_failed'
  }
}
