import type { SearchResult } from '../../../shared/domainTypes'

export function getFileDirname(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : ''
}

export function getFileBasename(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export type FileSearchDisplay = {
  fileName: string
  fullPath: string
  detailLine: string | null
}

/** 文件搜索结果：文件名 + 单行详情（优先匹配片段，否则目录），完整路径仅用于 tooltip */
export function getFileSearchDisplay(item: SearchResult): FileSearchDisplay {
  const fullPath = (item.path || item.title).replace(/\\/g, '/')
  const fileName = getFileBasename(fullPath)
  const dir = getFileDirname(fullPath)
  const preview = item.preview.trim()
  const detailLine = preview || dir || null
  return { fileName, fullPath, detailLine }
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

/** @deprecated 使用 getFileSearchDisplay */
export function getFileAuxiliaryText(item: SearchResult): string | null {
  if (item.type !== 'file' || !item.path) return null
  const dir = getFileDirname(item.path)
  return dir || null
}
