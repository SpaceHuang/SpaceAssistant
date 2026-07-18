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

export interface MergeableTreeNode {
  key: string
  name: string
  isDirectory: boolean
  expanded: boolean
  loading: boolean
  children: MergeableTreeNode[]
  size?: number
}

/**
 * 合并刷新后的目录子节点：对仍存在且已展开的子目录保留其 expanded/loading 与已加载子树；
 * 新增/删除/重命名节点按 next 处理；无变化时返回 prev 原引用以避免无意义重渲染（§7.4）。
 * 当某子目录此前子树为空、本次读取到子节点时，回填 next.children（不短路，避免丢数据）。
 */
export function mergeRefreshedChildren<T extends MergeableTreeNode>(
  previous: T[],
  next: T[]
): T[] {
  if (shouldShortCircuit(previous, next)) return previous
  const prevByKey = new Map(previous.map((node) => [node.key, node]))
  return next.map((node) => {
    const prev = prevByKey.get(node.key)
    if (!prev || !node.isDirectory) return node
    return {
      ...node,
      expanded: prev.expanded,
      loading: prev.loading,
      children: prev.children.length > 0 ? prev.children : node.children
    }
  })
}

function shouldShortCircuit<T extends MergeableTreeNode>(previous: T[], next: T[]): boolean {
  if (previous.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    const p = previous[i]
    const n = next[i]
    if (p.key !== n.key || p.name !== n.name || p.isDirectory !== n.isDirectory) return false
    // 文件元信息（size）变化属于"改"，不短路
    if (p.size !== n.size) return false
    // 子目录此前无子树、本次读到子节点时需回填，不能短路
    if (n.isDirectory && p.children.length === 0 && n.children.length > 0) return false
  }
  return true
}
