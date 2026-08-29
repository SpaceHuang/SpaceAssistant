import fs from 'node:fs'
import path from 'node:path'

/** Stable path identity: filesystem identity when present, lexical identity before creation. */
export function artifactPathIdentity(targetPath: string, options: { platform?: NodeJS.Platform } = {}): string {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return windowsPathIdentity(targetPath)
  const normalized = path.normalize(targetPath)
  try {
    return fs.realpathSync(normalized)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalized
    throw error
  }
}

function windowsPathIdentity(targetPath: string): string {
  const normalized = path.win32.normalize(targetPath).replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  for (const segment of segments) {
    if (/[. ]$/.test(segment)) throw new Error('Windows path segment has a trailing dot or space')
    const stem = segment.split('.')[0].toUpperCase()
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw new Error('Windows path contains a reserved device name')
  }
  return normalized.toLowerCase()
}
