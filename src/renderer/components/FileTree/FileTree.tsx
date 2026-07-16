import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from 'react'
import { App, Tree } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { normalizeRelPath } from '../../../shared/fileTreeSync'
import { useFileTree, type UseFileTreeOptions } from './useFileTree'
import type { FileTreeNode as FileTreeNodeData } from './useFileTree'
import { FileTreeNode } from './FileTreeNode'
import { FileTreeToolbar } from './FileTreeToolbar'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import { canShowCollectToWiki } from '../../services/wikiImportService'
import { buildFileTreeContextMenuItems } from './fileTreeContextMenuItems'
import { resolveFileTreeNodeKeyFromTarget } from './fileTreeContextMenuDom'
import { FileTreeContextMenuOverlay } from './FileTreeContextMenuOverlay'
import './fileTree.css'

export type FileTreeHandle = {
  selectPath: (relPath: string) => Promise<void>
  refresh: () => Promise<void>
  startNewDirectory: () => void
}

interface FileTreeProps {
  workDir: string
  onFileSelect?: (relPath: string) => void
  treeOptions?: UseFileTreeOptions
  embedded?: boolean
  selectedKey?: string | null
  onSelectedKeyChange?: (key: string | null) => void
  highlightRelPaths?: string[]
  wikiRootPath?: string
  wikiEnabled?: boolean
  onCollectToWiki?: (relPath: string) => void
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  {
    workDir,
    onFileSelect,
    treeOptions,
    embedded = false,
    selectedKey: controlledSelectedKey,
    onSelectedKeyChange,
    highlightRelPaths = [],
    wikiRootPath = 'llm-wiki',
    wikiEnabled = false,
    onCollectToWiki
  },
  ref
) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('fileTree')
  const { t: tc } = useTypedTranslation('common')
  const tree = useFileTree(workDir, treeOptions ?? {})
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; name: string; isDirectory: boolean } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ key: string; x: number; y: number } | null>(null)

  const selectedKey = controlledSelectedKey !== undefined ? controlledSelectedKey : tree.selectedKey

  const setSelected = useCallback(
    (key: string | null) => {
      if (onSelectedKeyChange) onSelectedKeyChange(key)
      else tree.setSelectedKey(key)
    },
    [onSelectedKeyChange, tree]
  )

  const startNewDirectoryIn = useCallback(
    (parentKey: string) => {
      tree.setInlineInput({ parentKey, type: 'directory', defaultName: t('defaultNewFolder') })
      setSelected(parentKey)
      if (!tree.expandedKeys.includes(parentKey)) {
        void tree.toggleExpand(parentKey)
      }
    },
    [setSelected, t, tree]
  )

  const buildNodeMenuItems = useCallback(
    (node: FileTreeNodeData) => {
      const showCollect = Boolean(
        onCollectToWiki && canShowCollectToWiki(node.relPath, wikiRootPath, node.isDirectory, wikiEnabled)
      )
      return buildFileTreeContextMenuItems({
        onAddToChat: () => {},
        onCopyPath: () => {
          const abs = workDir + (node.relPath ? '/' + node.relPath : '')
          void navigator.clipboard.writeText(abs)
          message.success(t('copyAbsPathOk'))
        },
        onCopyRelPath: () => {
          void navigator.clipboard.writeText(node.relPath || '.')
          message.success(t('copyRelPathOk'))
        },
        onShowInFolder: () => {
          void window.api.fileShowInExplorer(node.relPath || '.').then((r) => {
            if (!r.ok) message.error(r.error ?? t('openDirFailed'))
          })
        },
        onRename: () => tree.setRenamingKey(node.key),
        onDelete: () => setDeleteTarget({ key: node.key, name: node.name, isDirectory: node.isDirectory }),
        onCollectToWiki: showCollect ? () => onCollectToWiki?.(node.relPath) : undefined,
        onNewSubdirectory: node.isDirectory
          ? () => {
              setContextMenu(null)
              startNewDirectoryIn(node.key)
            }
          : undefined,
        isDirectory: node.isDirectory,
        showCollectToWiki: showCollect,
        readOnly: tree.readOnly,
        onAddToChatPlaceholder: () => message.info(t('contextMenu.featureInDevelopment')),
        t: (key: string) => t(key as Parameters<typeof t>[0]),
        tc: (key: string) => tc(key as Parameters<typeof tc>[0])
      })
    },
    [message, onCollectToWiki, startNewDirectoryIn, t, tc, tree, wikiEnabled, wikiRootPath, workDir]
  )

  const openContextMenu = useCallback((key: string, x: number, y: number) => {
    if (key.startsWith('__inline_input__')) return
    setContextMenu({ key, x, y })
  }, [])

  const handleTreeRightClick = useCallback(
    ({ event, node }: { event: React.MouseEvent; node: EventDataNode<DataNode> }) => {
      event.preventDefault()
      event.stopPropagation()
      openContextMenu(normalizeRelPath(String(node.key)), event.clientX, event.clientY)
    },
    [openContextMenu]
  )

  const handleTreeContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const key = resolveFileTreeNodeKeyFromTarget(e.target)
      if (!key) return
      e.preventDefault()
      e.stopPropagation()
      openContextMenu(key, e.clientX, e.clientY)
    },
    [openContextMenu]
  )

  const contextMenuNode = contextMenu ? findNode(tree.treeData, contextMenu.key) : null
  const contextMenuItems = useMemo(
    () => (contextMenuNode ? buildNodeMenuItems(contextMenuNode) : []),
    [buildNodeMenuItems, contextMenuNode]
  )

  const highlightSet = new Set(highlightRelPaths.map((p) => p.replace(/\\/g, '/')))

  const toAntdDataNodesWithInput = useCallback(
    (nodes: FileTreeNodeData[]): DataNode[] => {
      return nodes.map((node) => {
        const isInputTarget = !tree.readOnly && tree.inlineInput?.parentKey === node.key
        const children = node.isDirectory ? toAntdDataNodesWithInput(node.children) : undefined
        const inputChild: DataNode | null = isInputTarget
          ? {
              key: `__inline_input__${node.key}`,
              title: (
                <FileTreeNode
                  name=""
                  isDirectory={tree.inlineInput!.type === 'directory'}
                  expanded={false}
                  isRenaming={false}
                  isNewInput={true}
                  newInputType={tree.inlineInput!.type}
                  newInputDefaultName={tree.inlineInput!.defaultName}
                  onRenameConfirm={() => {}}
                  onRenameCancel={() => {}}
                  onCreateConfirm={(name) => {
                    if (tree.inlineInput!.type === 'file') {
                      tree.createFile(node.key, name)
                    } else {
                      tree.createDirectory(node.key, name)
                    }
                    tree.setInlineInput(null)
                  }}
                  onCreateCancel={() => tree.setInlineInput(null)}
                />
              ),
              isLeaf: true
            }
          : null

        const highlighted = highlightSet.has(node.relPath.replace(/\\/g, '/'))
        return {
          key: node.key,
          className: highlighted ? 'file-tree-node--wiki-highlight' : undefined,
          title: (
            <FileTreeNode
              nodeKey={node.key}
              name={node.name}
              isDirectory={node.isDirectory}
              expanded={node.expanded}
              isRenaming={tree.renamingKey === node.key}
              isNewInput={false}
              newInputType="file"
              newInputDefaultName=""
              highlighted={highlighted}
              onRenameConfirm={(newName) => tree.renameNode(node.key, newName)}
              onRenameCancel={() => tree.setRenamingKey(null)}
              onCreateConfirm={() => {}}
              onCreateCancel={() => {}}
            />
          ),
          children: inputChild && children ? [...children, inputChild] : inputChild ? [inputChild] : children,
          isLeaf: !node.isDirectory
        }
      })
    },
    [tree, highlightSet]
  )

  const antdTreeData = toAntdDataNodesWithInput(tree.treeData)

  const handleSelect = (_selectedKeys: React.Key[], info: { node: EventDataNode<DataNode> }) => {
    const key = normalizeRelPath(String(info.node.key))
    if (key.startsWith('__inline_input__')) return
    const node = tree.treeData.length > 0 ? findNode(tree.treeData, key) : null
    setSelected(key)
    if (node?.isDirectory) {
      void tree.toggleExpand(key)
    } else if (node && !node.isDirectory) {
      onFileSelect?.(key)
    } else if (info.node.isLeaf) {
      onFileSelect?.(key)
    }
  }

  const handleExpand = (keys: React.Key[]) => {
    const newKeys = keys.filter((k) => !tree.expandedKeys.includes(k as string))
    for (const k of newKeys) {
      void tree.toggleExpand(k as string)
    }
    const collapsedKeys = tree.expandedKeys.filter((k) => !keys.includes(k))
    for (const k of collapsedKeys) {
      void tree.toggleExpand(k)
    }
  }

  const handleNewDirectory = useCallback(() => {
    startNewDirectoryIn(selectedKey || tree.rootRelPath || '')
  }, [selectedKey, tree.rootRelPath, startNewDirectoryIn])

  useImperativeHandle(
    ref,
    () => ({
      selectPath: tree.selectPath,
      refresh: tree.refreshTree,
      startNewDirectory: handleNewDirectory
    }),
    [tree.selectPath, tree.refreshTree, handleNewDirectory]
  )

  const treeBody = (
    <div
      className={`file-tree-scroll${embedded ? ' file-tree-scroll--embedded' : ''}`}
      onContextMenuCapture={handleTreeContextMenu}
    >
      <Tree
        className="file-tree"
        treeData={antdTreeData}
        expandedKeys={tree.expandedKeys}
        selectedKeys={selectedKey ? [selectedKey] : []}
        showIcon={false}
        onSelect={handleSelect}
        onExpand={handleExpand}
        onRightClick={handleTreeRightClick}
        draggable={tree.readOnly ? false : { icon: false, nodeDraggable: () => true }}
        allowDrop={
          tree.readOnly
            ? undefined
            : ({ dragNode, dropNode, dropPosition }) => {
                if (dropPosition !== 0) return false
                const dragKey = dragNode.key as string
                const dropKey = dropNode.key as string
                return tree.validateDrop(dragKey, dropKey)
              }
        }
        onDrop={
          tree.readOnly
            ? undefined
            : (info) => {
                const dragKey = info.dragNode.key as string
                const dropKey = info.node.key as string
                void tree.onDrop(dragKey, dropKey).catch((e: unknown) => {
                  message.error(e instanceof Error ? e.message : t('moveFailed'))
                })
              }
        }
        blockNode
      />
      {contextMenu && contextMenuNode ? (
        <FileTreeContextMenuOverlay
          items={contextMenuItems}
          open
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  )

  if (embedded) {
    return (
      <>
        {treeBody}
        <DeleteConfirmModal
          open={deleteTarget !== null}
          name={deleteTarget?.name ?? ''}
          isDirectory={deleteTarget?.isDirectory ?? false}
          onConfirm={() => {
            if (deleteTarget) {
              void tree.deleteNode(deleteTarget.key)
              setDeleteTarget(null)
            }
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="app-pane-header sider-content-header">
        <span className="app-pane-header-title">{t('paneTitle')}</span>
        <FileTreeToolbar onNewDirectory={handleNewDirectory} onRefresh={() => tree.refreshTree()} />
      </div>
      <div className="sider-content-body file-tree-body">{treeBody}</div>
      <DeleteConfirmModal
        open={deleteTarget !== null}
        name={deleteTarget?.name ?? ''}
        isDirectory={deleteTarget?.isDirectory ?? false}
        onConfirm={() => {
          if (deleteTarget) {
            void tree.deleteNode(deleteTarget.key)
            setDeleteTarget(null)
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
})

function findNode(nodes: FileTreeNodeData[], key: string): FileTreeNodeData | null {
  for (const n of nodes) {
    if (n.key === key) return n
    if (n.children.length > 0) {
      const found = findNode(n.children, key)
      if (found) return found
    }
  }
  return null
}
