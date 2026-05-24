import { InlineInput } from './InlineInput'
import folderLineRaw from '../../assets/folder_line.svg?raw'
import folderOpenLineRaw from '../../assets/folder_open_line.svg?raw'
import fileLineRaw from '../../assets/file_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'

const folderSvg = patchSvg(folderLineRaw, 14)
const folderOpenSvg = patchSvg(folderOpenLineRaw, 14)
const fileSvg = patchSvg(fileLineRaw, 14)

interface FileTreeNodeProps {
  name: string
  isDirectory: boolean
  expanded: boolean
  isRenaming: boolean
  isNewInput: boolean
  newInputType: 'file' | 'directory'
  newInputDefaultName: string
  highlighted?: boolean
  onRenameConfirm: (newName: string) => void
  onRenameCancel: () => void
  onCreateConfirm: (name: string) => void
  onCreateCancel: () => void
}

export function FileTreeNode({
  name, isDirectory, expanded, isRenaming, isNewInput, newInputType, newInputDefaultName, highlighted = false,
  onRenameConfirm, onRenameCancel, onCreateConfirm, onCreateCancel
}: FileTreeNodeProps) {
  const icon = isDirectory
    ? (expanded ? folderOpenSvg : folderSvg)
    : fileSvg

  if (isRenaming) {
    return (
      <div className="file-tree-node">
        <span className="file-tree-node-icon" dangerouslySetInnerHTML={{ __html: icon }} />
        <InlineInput defaultValue={name} onConfirm={onRenameConfirm} onCancel={onRenameCancel} />
      </div>
    )
  }

  if (isNewInput) {
    const inputIcon = newInputType === 'directory' ? folderSvg : fileSvg
    return (
      <div className="file-tree-node">
        <span className="file-tree-node-icon" dangerouslySetInnerHTML={{ __html: inputIcon }} />
        <InlineInput defaultValue={newInputDefaultName} onConfirm={onCreateConfirm} onCancel={onCreateCancel} />
      </div>
    )
  }

  return (
    <div className={`file-tree-node${highlighted ? ' file-tree-node--highlight' : ''}`}>
      <span className="file-tree-node-icon" dangerouslySetInnerHTML={{ __html: icon }} />
      <span className={`file-tree-node-label${highlighted ? ' file-tree-node-label--highlight' : ''}`}>{name}</span>
    </div>
  )
}
