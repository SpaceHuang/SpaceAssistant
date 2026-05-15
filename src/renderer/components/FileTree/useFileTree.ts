import { useState, useCallback, useRef, useEffect } from 'react'
import type { FileInfo } from '../../../shared/domainTypes'

export interface FileTreeNode {
  key: string
  name: string
  relPath: string
  isDirectory: boolean
  size?: number
  expanded: boolean
  loading: boolean
  children: FileTreeNode[]
}

export interface InlineInputState {
  parentKey: string
  type: 'file' | 'directory'
  defaultName: string
}

export function useFileTree(workDir: string) {
  const rootName = workDir.split(/[/\\]/).filter(Boolean).pop() || 'project'

  const [treeData, setTreeData] = useState<FileTreeNode[]>([
    { key: '', name: rootName, relPath: '', isDirectory: true, expanded: true, loading: false, children: [] }
  ])
  const [expandedKeys, setExpandedKeys] = useState<string[]>([''])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)

  const nodeMapRef = useRef(new Map<string, FileTreeNode>())

  const rebuildNodeMap = useCallback((nodes: FileTreeNode[]) => {
    const map = new Map<string, FileTreeNode>()
    const walk = (list: FileTreeNode[]) => {
      for (const n of list) {
        map.set(n.key, n)
        if (n.children.length > 0) walk(n.children)
      }
    }
    walk(nodes)
    nodeMapRef.current = map
    return map
  }, [])

  const ensureNodeMap = useCallback(() => {
    if (nodeMapRef.current.size === 0) rebuildNodeMap(treeData)
    return nodeMapRef.current
  }, [treeData, rebuildNodeMap])

  const fileInfoToNode = useCallback((info: FileInfo): FileTreeNode => ({
    key: info.path,
    name: info.name,
    relPath: info.path,
    isDirectory: info.isDirectory,
    size: info.size,
    expanded: false,
    loading: false,
    children: []
  }), [])

  const sortNodes = useCallback((nodes: FileTreeNode[]): FileTreeNode[] =>
    [...nodes].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  , [])

  // Load root children on mount
  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.fileListDirectory('')
        const root = treeData[0]
        root.children = sortNodes(list.map(fileInfoToNode))
        const newData = [{ ...root, children: [...root.children] }]
        setTreeData(newData)
        rebuildNodeMap(newData)
      } catch { /* ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleExpand = useCallback(async (key: string) => {
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node || !node.isDirectory) return

    if (node.expanded) {
      node.expanded = false
      setExpandedKeys((prev) => prev.filter((k) => k !== key))
      setTreeData((prev) => [...prev])
      return
    }

    // Lazy load
    if (node.children.length === 0 && !node.loading) {
      node.loading = true
      setTreeData((prev) => [...prev])
      try {
        const list = await window.api.fileListDirectory(key)
        node.children = sortNodes(list.map(fileInfoToNode))
      } catch {
        node.children = []
      }
      node.loading = false
    }

    node.expanded = true
    setExpandedKeys((prev) => [...prev, key])
    setTreeData((prev) => [...prev])
    rebuildNodeMap(treeData)
  }, [ensureNodeMap, fileInfoToNode, sortNodes, treeData])

  const refreshDirectory = useCallback(async (key: string) => {
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node || !node.isDirectory) return

    try {
      const list = await window.api.fileListDirectory(key)
      node.children = sortNodes(list.map(fileInfoToNode))
    } catch {
      node.children = []
    }
    setTreeData((prev) => [...prev])
    rebuildNodeMap(treeData)
  }, [ensureNodeMap, fileInfoToNode, sortNodes, treeData])

  const refreshTree = useCallback(async () => {
    try {
      const list = await window.api.fileListDirectory('')
      const root = treeData[0]
      root.children = sortNodes(list.map(fileInfoToNode))
      const newData = [{ ...root, children: [...root.children] }]
      setTreeData(newData)
      setExpandedKeys([''])
      rebuildNodeMap(newData)
    } catch { /* ignore */ }
  }, [fileInfoToNode, sortNodes, treeData])

  const createFile = useCallback(async (parentKey: string, name: string) => {
    const parent = parentKey === '' ? '' : parentKey
    const relPath = parent ? `${parent}/${name}` : name
    await window.api.fileCreateFile(relPath)
    await refreshDirectory(parentKey)
  }, [refreshDirectory])

  const createDirectory = useCallback(async (parentKey: string, name: string) => {
    const parent = parentKey === '' ? '' : parentKey
    const relPath = parent ? `${parent}/${name}` : name
    await window.api.fileCreateDirectory(relPath)
    await refreshDirectory(parentKey)
  }, [refreshDirectory])

  const deleteNode = useCallback(async (key: string) => {
    await window.api.fileDelete(key)
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node) return
    const parentKey = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : ''
    const parent = map.get(parentKey)
    if (parent) {
      parent.children = parent.children.filter((c) => c.key !== key)
    }
    map.delete(key)
    setTreeData((prev) => [...prev])
    if (selectedKey === key) setSelectedKey(null)
  }, [ensureNodeMap, selectedKey])

  const renameNode = useCallback(async (key: string, newName: string) => {
    await window.api.fileRename(key, newName)
    const map = ensureNodeMap()
    const node = map.get(key)
    if (!node) return

    const parentKey = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : ''
    const newKey = parentKey ? `${parentKey}/${newName}` : newName

    const parent = map.get(parentKey)
    if (parent) {
      const idx = parent.children.findIndex((c) => c.key === key)
      if (idx >= 0) {
        parent.children = sortNodes(
          parent.children.map((c) =>
            c.key === key ? { ...c, key: newKey, name: newName, relPath: newKey } : c
          )
        )
      }
    }
    map.delete(key)
    map.set(newKey, { ...node, key: newKey, name: newName, relPath: newKey })
    setTreeData((prev) => [...prev])
    if (selectedKey === key) setSelectedKey(newKey)
    setRenamingKey(null)
  }, [ensureNodeMap, selectedKey, sortNodes])

  const validateDrop = useCallback((srcKey: string, destDirKey: string): boolean => {
    if (srcKey === destDirKey) return false
    const srcParentKey = srcKey.includes('/') ? srcKey.substring(0, srcKey.lastIndexOf('/')) : ''
    if (srcParentKey === destDirKey) return false
    if (destDirKey.startsWith(srcKey + '/')) return false
    return true
  }, [])

  const onDrop = useCallback(async (srcKey: string, destDirKey: string) => {
    if (!validateDrop(srcKey, destDirKey)) return
    await window.api.fileMove(srcKey, destDirKey)

    const map = ensureNodeMap()
    const srcParentKey = srcKey.includes('/') ? srcKey.substring(0, srcKey.lastIndexOf('/')) : ''
    const oldParent = map.get(srcParentKey)
    if (oldParent) {
      oldParent.children = oldParent.children.filter((c) => c.key !== srcKey)
    }

    await refreshDirectory(destDirKey)
  }, [validateDrop, ensureNodeMap, refreshDirectory])

  return {
    treeData,
    expandedKeys,
    selectedKey,
    setSelectedKey,
    inlineInput,
    setInlineInput: (v: InlineInputState | null) => setInlineInput(v),
    renamingKey,
    setRenamingKey: (v: string | null) => setRenamingKey(v),
    toggleExpand,
    refreshTree,
    refreshDirectory,
    createFile,
    createDirectory,
    deleteNode,
    renameNode,
    validateDrop,
    onDrop,
    workDir
  }
}
