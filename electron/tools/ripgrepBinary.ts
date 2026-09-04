import path from 'path'

export type RipgrepBinarySource = 'bundled' | 'development' | 'unavailable'

export type ResolvedRipgrepBinary = {
  path: string | null
  source: RipgrepBinarySource
  platform: NodeJS.Platform
  arch: string
  reason?: 'unsupported'
}

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
