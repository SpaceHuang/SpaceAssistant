import { forwardRef, useCallback, useImperativeHandle, useState } from 'react'
import { App, Tree } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { useFileTree, type UseFileTreeOptions } from './useFileTree'
import type { FileTreeNode as FileTreeNodeData } from './useFileTree'
import { FileTreeNode } from './FileTreeNode'
import { FileTreeToolbar } from './FileTreeToolbar'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import { canShowCollectToWiki } from '../../services/wikiImportService'
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
  const tree = useFileTree(workDir, treeOptions ?? {})
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; name: string; isDirectory: boolean } | null>(null)

  const selectedKey = controlledSelectedKey !== undefined ? controlledSelectedKey : tree.selectedKey

  const setSelected = useCallback(
    (key: string | null) => {
      if (onSelectedKeyChange) onSelectedKeyChange(key)
      else tree.setSelectedKey(key)
    },
    [onSelectedKeyChange, tree]
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
        const showCollect = Boolean(
          onCollectToWiki && canShowCollectToWiki(node.relPath, wikiRootPath, node.isDirectory, wikiEnabled)
        )

        return {
          key: node.key,
          className: highlighted ? 'file-tree-node--wiki-highlight' : undefined,
          title: (
            <FileTreeContextMenu
              relPath={node.relPath}
              name={node.name}
              isDirectory={node.isDirectory}
              readOnly={tree.readOnly}
              showCollectToWiki={showCollect}
              onCollectToWiki={showCollect ? () => onCollectToWiki?.(node.relPath) : undefined}
              onAddToChat={() => {}}
              onCopyPath={() => {
                const abs = workDir + (node.relPath ? '/' + node.relPath : '')
                void navigator.clipboard.writeText(abs)
                message.success('已复制绝对路径')
              }}
              onCopyRelPath={() => {
                void navigator.clipboard.writeText(node.relPath || '.')
                message.success('已复制相对路径')
              }}
              onRename={() => tree.setRenamingKey(node.key)}
              onDelete={() => setDeleteTarget({ key: node.key, name: node.name, isDirectory: node.isDirectory })}
            >
              <FileTreeNode
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
            </FileTreeContextMenu>
          ),
          children: inputChild && children ? [...children, inputChild] : inputChild ? [inputChild] : children,
          isLeaf: !node.isDirectory
        }
      })
    },
    [tree, workDir, message, highlightSet, onCollectToWiki, wikiRootPath, wikiEnabled]
  )

  const antdTreeData = toAntdDataNodesWithInput(tree.treeData)

  const handleSelect = (_selectedKeys: React.Key[], info: { node: EventDataNode }) => {
    const key = info.node.key as string
    if (key.startsWith('__inline_input__')) return
    const node = tree.treeData.length > 0 ? findNode(tree.treeData, key) : null
    if (!node) return
    setSelected(key)
    if (node.isDirectory) {
      void tree.toggleExpand(key)
    } else {
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

  const handleNewDirectory = () => {
    const parentKey = selectedKey || tree.rootRelPath || ''
    tree.setInlineInput({ parentKey, type: 'directory', defaultName: '新建文件夹' })
    if (!tree.expandedKeys.includes(parentKey)) {
      void tree.toggleExpand(parentKey)
    }
  }

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
    <div className={`file-tree-scroll${embedded ? ' file-tree-scroll--embedded' : ''}`}>
      <Tree
        className="file-tree"
        treeData={antdTreeData}
        expandedKeys={tree.expandedKeys}
        selectedKeys={selectedKey ? [selectedKey] : []}
        showIcon={false}
        onSelect={handleSelect}
        onExpand={handleExpand}
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
                  message.error(e instanceof Error ? e.message : '移动失败')
                })
              }
        }
        blockNode
      />
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
        <span className="app-pane-header-title">文件</span>
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
