import { Tooltip } from 'antd'
import addLineRaw from '../../assets/add_line.svg?raw'
import newFolderLineRaw from '../../assets/new_folder_line.svg?raw'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'

const patchSvg = (raw: string) => raw.replace(/fill="#09244B"/g, 'fill="currentColor"')

const addSvg = patchSvg(addLineRaw)
const newFolderSvg = patchSvg(newFolderLineRaw)
const refreshSvg = patchSvg(refresh2LineRaw)

interface FileTreeToolbarProps {
  onNewFile: () => void
  onNewDirectory: () => void
  onRefresh: () => void
}

export function FileTreeToolbar({ onNewFile, onNewDirectory, onRefresh }: FileTreeToolbarProps) {
  const btnStyle: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 4,
    display: 'inline-flex',
    alignItems: 'center',
    color: '#8c8c8c',
    lineHeight: 0
  }

  return (
    <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
      <Tooltip title="新建文件">
        <button type="button" style={btnStyle} onClick={onNewFile} dangerouslySetInnerHTML={{ __html: addSvg }} data-testid="new-file-btn" />
      </Tooltip>
      <Tooltip title="新建目录">
        <button type="button" style={btnStyle} onClick={onNewDirectory} dangerouslySetInnerHTML={{ __html: newFolderSvg }} data-testid="new-directory-btn" />
      </Tooltip>
      <Tooltip title="刷新">
        <button type="button" style={btnStyle} onClick={onRefresh} dangerouslySetInnerHTML={{ __html: refreshSvg }} data-testid="refresh-btn" />
      </Tooltip>
    </div>
  )
}
