import { InlineInput } from './InlineInput'
import folderLineRaw from '../../assets/folder_line.svg?raw'
import folderOpenLineRaw from '../../assets/folder_open_line.svg?raw'
import fileLineRaw from '../../assets/file_line.svg?raw'

const patchSvg = (raw: string) =>
  raw.replace(/fill="#09244B"/g, 'fill="currentColor"').replace(/width="24"/, 'width="1em"').replace(/height="24"/, 'height="1em"')

const folderSvg = patchSvg(folderLineRaw)
const folderOpenSvg = patchSvg(folderOpenLineRaw)
const fileSvg = patchSvg(fileLineRaw)

interface FileTreeNodeProps {
  name: string
  isDirectory: boolean
  expanded: boolean
  isRenaming: boolean
  isNewInput: boolean
  newInputType: 'file' | 'directory'
  newInputDefaultName: string
  onRenameConfirm: (newName: string) => void
  onRenameCancel: () => void
  onCreateConfirm: (name: string) => void
  onCreateCancel: () => void
}

const iconStyle: React.CSSProperties = { width: 16, height: 16, marginRight: 6, flexShrink: 0, display: 'inline-block', lineHeight: 0 }

export function FileTreeNode({
  name, isDirectory, expanded, isRenaming, isNewInput, newInputType, newInputDefaultName,
  onRenameConfirm, onRenameCancel, onCreateConfirm, onCreateCancel
}: FileTreeNodeProps) {
  const icon = isDirectory
    ? (expanded ? folderOpenSvg : folderSvg)
    : fileSvg

  if (isRenaming) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', width: '100%' }}>
        <span dangerouslySetInnerHTML={{ __html: icon }} style={iconStyle} />
        <InlineInput defaultValue={name} onConfirm={onRenameConfirm} onCancel={onRenameCancel} />
      </span>
    )
  }

  if (isNewInput) {
    const inputIcon = newInputType === 'directory' ? folderSvg : fileSvg
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', width: '100%' }}>
        <span dangerouslySetInnerHTML={{ __html: inputIcon }} style={iconStyle} />
        <InlineInput defaultValue={newInputDefaultName} onConfirm={onCreateConfirm} onCancel={onCreateCancel} />
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', overflow: 'hidden' }}>
      <span dangerouslySetInnerHTML={{ __html: icon }} style={iconStyle} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </span>
  )
}
