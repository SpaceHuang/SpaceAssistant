/** 从 Tree 行 DOM 解析节点 key（含 switcher / indent 区域右键） */
export function resolveFileTreeNodeKeyFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const treenode = target.closest('.ant-tree-treenode')
  if (!treenode) return null
  const keyHost = treenode.querySelector('[data-file-tree-key]')
  const key = keyHost?.getAttribute('data-file-tree-key')
  if (!key || key.startsWith('__inline_input__')) return null
  return key
}
