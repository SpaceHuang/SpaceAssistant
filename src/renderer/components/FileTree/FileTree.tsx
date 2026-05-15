import { useState, useCallback } from 'react'
import { Tree, message } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { useFileTree } from './useFileTree'
import type { FileTreeNode as FileTreeNodeData } from './useFileTree'
import { FileTreeNode } from './FileTreeNode'
import { FileTreeToolbar } from './FileTreeToolbar'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import './fileTree.css'

interface FileTreeProps {
  workDir: string
  onFileSelect?: (relPath: string) => void
}

export function FileTree({ workDir, onFileSelect }: FileTreeProps) {
  const tree = useFileTree(workDir)
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; name: string; isDirectory: boolean } | null>(null)

  const toAntdDataNodesWithInput = useCallback((nodes: FileTreeNodeData[]): DataNode[] => {
    return nodes.map((node) => {
      const isInputTarget = tree.inlineInput?.parentKey === node.key
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

      return {
        key: node.key,
        title: (
          <FileTreeContextMenu
            relPath={node.relPath}
            name={node.name}
            isDirectory={node.isDirectory}
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
  }, [tree, workDir])

  const antdTreeData = toAntdDataNodesWithInput(tree.treeData)

  const handleSelect = (_selectedKeys: React.Key[], info: { node: EventDataNode }) => {
    const key = info.node.key as string
    const node = tree.treeData.length > 0 ? findNode(tree.treeData, key) : null
    if (!node) return
    tree.setSelectedKey(key)
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
    const parentKey = tree.selectedKey || ''
    tree.setInlineInput({ parentKey, type: 'directory', defaultName: '新建文件夹' })
    if (!tree.expandedKeys.includes(parentKey)) {
      void tree.toggleExpand(parentKey)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="app-pane-header sider-content-header">
        <span className="app-pane-header-title">文件</span>
        <FileTreeToolbar onNewDirectory={handleNewDirectory} onRefresh={() => tree.refreshTree()} />
      </div>
      <div className="sider-content-body" style={{ overflow: 'auto', padding: '0 4px' }}>
        <Tree
          className="file-tree"
          treeData={antdTreeData}
          expandedKeys={tree.expandedKeys}
          selectedKeys={tree.selectedKey ? [tree.selectedKey] : []}
          showIcon={false}
          onSelect={handleSelect}
          onExpand={handleExpand}
          draggable={{ icon: false, nodeDraggable: () => true }}
          allowDrop={({ dragNode, dropNode, dropPosition }) => {
            if (dropPosition !== 0) return false
            const dragKey = dragNode.key as string
            const dropKey = dropNode.key as string
            return tree.validateDrop(dragKey, dropKey)
          }}
          onDrop={(info) => {
            const dragKey = info.dragNode.key as string
            const dropKey = info.node.key as string
            void tree.onDrop(dragKey, dropKey).catch((e: unknown) => {
              message.error(e instanceof Error ? e.message : '移动失败')
            })
          }}
          blockNode
        />
      </div>
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
}

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
