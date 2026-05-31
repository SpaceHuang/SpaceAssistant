import type { SearchResult } from '../../../shared/domainTypes'

export function getFileDirname(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : ''
}

export function shouldShowSessionAuxiliary(title: string, sessionName: string): boolean {
  return title.trim() !== sessionName.trim()
}

export function getSessionAuxiliaryText(item: SearchResult): string | null {
  if (item.type !== 'session') return null
  const sessionName = item.title
  if (!shouldShowSessionAuxiliary(item.title, sessionName)) return null
  return sessionName
}

export function getFileAuxiliaryText(item: SearchResult): string | null {
  if (item.type !== 'file' || !item.path) return null
  const dir = getFileDirname(item.path)
  return dir || null
}
