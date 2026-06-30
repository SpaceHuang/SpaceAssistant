import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileInfo } from '../../../shared/domainTypes'
import { dirsToRefreshForPath } from '../../../shared/fileTreeSync'
import { ensureFileTreeSyncIpc, subscribeFileTreeSync } from '../../services/fileTreeSyncBus'

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

export interface UseFileTreeOptions {
  rootRelPath?: string
  rootDisplayName?: string
  excludePaths?: string[]
  readOnly?: boolean
}

/** 重载目录列表时保留已懒加载的子树，避免展开状态丢失 */
function mergePreservedDirectoryChildren(previous: FileTreeNode[], next: FileTreeNode[]): FileTreeNode[] {
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

export function useFileTree(workDir: string, options: UseFileTreeOptions = {}) {
  const {
    rootRelPath = '',
    rootDisplayName,
    excludePaths = [],
    readOnly = false
  } = options

  const rootName =
    rootDisplayName ??
    (rootRelPath
      ? rootRelPath.split('/').filter(Boolean).pop() || rootRelPath
      : workDir.split(/[/\\]/).filter(Boolean).pop() || 'project')

  const [treeData, setTreeData] = useState<FileTreeNode[]>([
    {
      key: rootRelPath,
      name: rootName,
      relPath: rootRelPath,
      isDirectory: true,
      expanded: true,
      loading: false,
      children: []
    }
  ])
  const [expandedKeys, setExpandedKeys] = useState<string[]>([rootRelPath])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)

  const nodeMapRef = useRef(new Map<string, FileTreeNode>())
  const excludeSet = useRef(new Set(excludePaths))
  const expandedKeysRef = useRef(expandedKeys)
  const refreshDirectoryRef = useRef<(key: string) => Promise<void>>(async () => {})
  const prevWorkDirRef = useRef(workDir)
  excludeSet.current = new Set(excludePaths)
  expandedKeysRef.current = expandedKeys

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

  const fileInfoToNode = useCallback(
    (info: FileInfo): FileTreeNode => ({
      key: info.path,
      name: info.name,
      relPath: info.path,
      isDirectory: info.isDirectory,
      size: info.size,
      expanded: false,
      loading: false,
      children: []
    }),
    []
  )

  const sortNodes = useCallback(
    (nodes: FileTreeNode[]): FileTreeNode[] =>
      [...nodes].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
    []
  )

  const filterList = useCallback(
    (list: FileInfo[]) => list.filter((info) => !excludeSet.current.has(info.path)),
    []
  )

  const loadDirectory = useCallback(
    async (dirKey: string) => {
      const list = await window.api.fileListDirectory(dirKey)
      return sortNodes(filterList(list).map(fileInfoToNode))
    },
    [fileInfoToNode, filterList, sortNodes]
  )

  useEffect(() => {
    const workDirChanged = prevWorkDirRef.current !== workDir
    prevWorkDirRef.current = workDir

    let cancelled = false
    void (async () => {
      try {
        const loaded = await loadDirectory(rootRelPath)
        if (cancelled) return

        if (workDirChanged) {
          setSelectedKey(null)
          setInlineInput(null)
          setRenamingKey(null)
          const newData: FileTreeNode[] = [
            {
              key: rootRelPath,
              name: rootName,
              relPath: rootRelPath,
              isDirectory: true,
              expanded: true,
              loading: false,
              children: loaded
            }
          ]
          rebuildNodeMap(newData)
          setTreeData(newData)
          setExpandedKeys([rootRelPath])
          return
        }

        setTreeData((prev) => {
          const prevRoot = prev[0]
          const children = mergePreservedDirectoryChildren(prevRoot?.children ?? [], loaded)
          const newData: FileTreeNode[] = [
            {
              ...prevRoot,
              key: rootRelPath,
              name: rootName,
              relPath: rootRelPath,
              isDirectory: true,
              expanded: true,
              loading: false,
              children
            }
          ]
          rebuildNodeMap(newData)
          return newData
        })
        setExpandedKeys((prev) => (prev.length > 0 ? prev : [rootRelPath]))
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rootRelPath, rootName, excludePaths.join('|'), workDir, loadDirectory, rebuildNodeMap])

  const toggleExpand = useCallback(
    async (key: string) => {
      const map = ensureNodeMap()
      const node = map.get(key)
      if (!node || !node.isDirectory) return

      if (node.expanded) {
        node.expanded = false
        setExpandedKeys((prev) => prev.filter((k) => k !== key))
        setTreeData((prev) => [...prev])
        return
      }

      if (node.children.length === 0 && !node.loading) {
        node.loading = true
        setTreeData((prev) => [...prev])
        try {
          node.children = await loadDirectory(key)
        } catch {
          node.children = []
        }
        node.loading = false
      }

      node.expanded = true
      setExpandedKeys((prev) => [...new Set([...prev, key])])
      setTreeData((prev) => [...prev])
      rebuildNodeMap(treeData)
    },
    [ensureNodeMap, loadDirectory, rebuildNodeMap, treeData]
  )

  const ensureExpanded = useCallback(
    async (key: string) => {
      const map = ensureNodeMap()
      const node = map.get(key)
      if (!node || !node.isDirectory || node.expanded) return

      if (node.children.length === 0 && !node.loading) {
        node.loading = true
        setTreeData((prev) => [...prev])
        try {
          node.children = await loadDirectory(key)
        } catch {
          node.children = []
        }
        node.loading = false
      }

      node.expanded = true
      setExpandedKeys((prev) => [...new Set([...prev, key])])
      setTreeData((prev) => [...prev])
      rebuildNodeMap(treeData)
    },
    [ensureNodeMap, loadDirectory, rebuildNodeMap, treeData]
  )

  const refreshDirectory = useCallback(
    async (key: string) => {
      const map = ensureNodeMap()
      const node = map.get(key)
      if (!node || !node.isDirectory) return
      try {
        node.children = await loadDirectory(key)
      } catch {
        node.children = []
      }
      setTreeData((prev) => [...prev])
      rebuildNodeMap(treeData)
    },
    [ensureNodeMap, loadDirectory, rebuildNodeMap, treeData]
  )

  refreshDirectoryRef.current = refreshDirectory

  useEffect(() => {
    ensureFileTreeSyncIpc()
    return subscribeFileTreeSync((event) => {
      void (async () => {
        const expanded = new Set(expandedKeysRef.current)
        const dirs =
          event.kind === 'refreshExpanded'
            ? [...expanded]
            : [
                ...new Set(
                  event.relPaths.flatMap((relPath) =>
                    dirsToRefreshForPath(relPath, rootRelPath, expanded)
                  )
                )
              ]
        for (const dirKey of dirs) {
          await refreshDirectoryRef.current(dirKey)
        }
      })()
    })
  }, [rootRelPath])

  const refreshTree = useCallback(async () => {
    try {
      const children = await loadDirectory(rootRelPath)
      setTreeData((prev) => {
        const newData: FileTreeNode[] = [
          {
            ...prev[0],
            key: rootRelPath,
            name: rootName,
            relPath: rootRelPath,
            isDirectory: true,
            expanded: true,
            loading: false,
            children
          }
        ]
        rebuildNodeMap(newData)
        return newData
      })
      setExpandedKeys([rootRelPath])
    } catch {
      /* ignore */
    }
  }, [loadDirectory, rebuildNodeMap, rootName, rootRelPath])

  const createFile = useCallback(
    async (parentKey: string, name: string) => {
      if (readOnly) return
      const parent = parentKey === '' ? '' : parentKey
      const relPath = parent ? `${parent}/${name}` : name
      await window.api.fileCreateFile(relPath)
      await refreshDirectory(parentKey)
    },
    [readOnly, refreshDirectory]
  )

  const createDirectory = useCallback(
    async (parentKey: string, name: string) => {
      if (readOnly) return
      const parent = parentKey === '' ? '' : parentKey
      const relPath = parent ? `${parent}/${name}` : name
      await window.api.fileCreateDirectory(relPath)
      await refreshDirectory(parentKey)
    },
    [readOnly, refreshDirectory]
  )

  const deleteNode = useCallback(
    async (key: string) => {
      if (readOnly) return
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
    },
    [ensureNodeMap, readOnly, selectedKey]
  )

  const renameNode = useCallback(
    async (key: string, newName: string) => {
      if (readOnly) return
      await window.api.fileRename(key, newName)
      const map = ensureNodeMap()
      const node = map.get(key)
      if (!node) return

      const parentKey = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : ''
      const newKey = parentKey ? `${parentKey}/${newName}` : newName

      const parent = map.get(parentKey)
      if (parent) {
        parent.children = sortNodes(
          parent.children.map((c) =>
            c.key === key ? { ...c, key: newKey, name: newName, relPath: newKey } : c
          )
        )
      }
      map.delete(key)
      map.set(newKey, { ...node, key: newKey, name: newName, relPath: newKey })
      setTreeData((prev) => [...prev])
      if (selectedKey === key) setSelectedKey(newKey)
      setRenamingKey(null)
    },
    [ensureNodeMap, readOnly, selectedKey, sortNodes]
  )

  const validateDrop = useCallback((srcKey: string, destDirKey: string): boolean => {
    if (readOnly) return false
    if (srcKey === destDirKey) return false
    const srcParentKey = srcKey.includes('/') ? srcKey.substring(0, srcKey.lastIndexOf('/')) : ''
    if (srcParentKey === destDirKey) return false
    if (destDirKey.startsWith(srcKey + '/')) return false
    return true
  }, [readOnly])

  const onDrop = useCallback(
    async (srcKey: string, destDirKey: string) => {
      if (readOnly) return
      if (!validateDrop(srcKey, destDirKey)) return
      await window.api.fileMove(srcKey, destDirKey)

      const map = ensureNodeMap()
      const srcParentKey = srcKey.includes('/') ? srcKey.substring(0, srcKey.lastIndexOf('/')) : ''
      const oldParent = map.get(srcParentKey)
      if (oldParent) {
        oldParent.children = oldParent.children.filter((c) => c.key !== srcKey)
      }

      await refreshDirectory(destDirKey)
    },
    [ensureNodeMap, readOnly, refreshDirectory, validateDrop]
  )

  const selectPath = useCallback(
    async (relPath: string) => {
      const normalized = relPath.replace(/\\/g, '/')
      const parts = normalized.split('/').filter(Boolean)
      const prefix = rootRelPath ? `${rootRelPath}/` : ''
      if (rootRelPath && normalized !== rootRelPath && !normalized.startsWith(prefix)) return

      const relParts = rootRelPath ? parts.slice(rootRelPath.split('/').filter(Boolean).length) : parts
      let curKey = rootRelPath
      for (let i = 0; i < relParts.length - 1; i++) {
        curKey = curKey ? `${curKey}/${relParts[i]}` : relParts[i]
        await ensureExpanded(curKey)
      }
      setSelectedKey(normalized)
    },
    [rootRelPath, ensureExpanded]
  )

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
    selectPath,
    workDir,
    readOnly,
    rootRelPath
  }
}
