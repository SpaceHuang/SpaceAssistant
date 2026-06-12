export type FileTreeChangeEvent =
  | { kind: 'paths'; relPaths: string[] }
  | { kind: 'refreshExpanded' }

export function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function parentDirKey(relPath: string): string {
  const normalized = normalizeRelPath(relPath)
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : ''
}

export function isPathUnderRoot(relPath: string, rootRelPath: string): boolean {
  const path = normalizeRelPath(relPath)
  const root = normalizeRelPath(rootRelPath)
  if (!root) return true
  return path === root || path.startsWith(`${root}/`)
}

/**
 * 返回需要刷新的目录 key：优先刷新已展开的直接父目录；
 * 若父目录未展开则向上找到最近的已展开祖先（用于新建子目录仍挂在已展开节点下的场景）。
 */
export function dirsToRefreshForPath(
  relPath: string,
  rootRelPath: string,
  expandedDirKeys: ReadonlySet<string>
): string[] {
  if (!isPathUnderRoot(relPath, rootRelPath)) return []

  const root = normalizeRelPath(rootRelPath)
  let cur = parentDirKey(relPath)

  if (expandedDirKeys.has(cur)) return [cur]

  while (true) {
    if (expandedDirKeys.has(cur)) return [cur]
    if (cur === root || cur === '') {
      if (expandedDirKeys.has(root) || (root === '' && expandedDirKeys.has(''))) {
        return [root]
      }
      return []
    }
    cur = parentDirKey(cur)
  }
}
