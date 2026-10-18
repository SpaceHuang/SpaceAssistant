import path from 'node:path'

export const WIKI_SERVICE_DIR = '.wiki-service'
export const WIKI_BOOTSTRAP_SEAL = '.wiki-service-bootstrap.json'
export const WIKI_CATALOG_PATH = `${WIKI_SERVICE_DIR}/catalog.json`

export function normalizeWikiRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw new Error('Wiki relative path is invalid.')
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('Wiki path must be relative.')
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Wiki path traversal is not allowed.')
  return segments.join(path.posix.sep)
}

export function resolveWikiServicePath(wikiRoot: string, relativePath: string): string {
  const normalized = normalizeWikiRelativePath(relativePath)
  const root = path.resolve(wikiRoot)
  const target = path.resolve(root, normalized)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Wiki path is outside the root.')
  return target
}
