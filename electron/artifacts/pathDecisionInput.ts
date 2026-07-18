import path from 'node:path'

export function validateDecisionRename(value: string): string {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || path.basename(name) !== name || /[\\/]/.test(name)) {
    throw new Error('Invalid artifact rename filename')
  }
  return name
}

export function validateDecisionDirectory(value: string): string {
  const dir = value.trim().replace(/\\/g, '/')
  if (!dir || path.posix.isAbsolute(dir) || dir.split('/').includes('..')) throw new Error('Invalid artifact decision directory')
  return dir.replace(/\/+$/, '')
}
