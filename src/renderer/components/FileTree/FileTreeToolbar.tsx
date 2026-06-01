import { Tooltip } from 'antd'
import newFolderLineRaw from '../../assets/new_folder_line.svg?raw'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'

const newFolderSvg = patchSvg(newFolderLineRaw, 14)
const refreshSvg = patchSvg(refresh2LineRaw, 14)

interface FileTreeToolbarProps {
  onNewDirectory: () => void
  onRefresh: () => void
}

export function FileTreeToolbar({ onNewDirectory, onRefresh }: FileTreeToolbarProps) {
  return (
    <div className="sa-pane-toolbar">
      <Tooltip title="新建目录">
        <button type="button" className="sa-icon-btn sa-icon-btn--xs" onClick={onNewDirectory} dangerouslySetInnerHTML={{ __html: newFolderSvg }} data-testid="new-directory-btn" />
      </Tooltip>
      <Tooltip title="刷新">
        <button type="button" className="sa-icon-btn sa-icon-btn--xs" onClick={onRefresh} dangerouslySetInnerHTML={{ __html: refreshSvg }} data-testid="refresh-btn" />
      </Tooltip>
    </div>
  )
}
